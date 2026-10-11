import { JsonObjectSchema, providerError } from '@autogeek/core';
import type { ModelEvent, ProviderErrorKind, StopReason } from '@autogeek/core';
import { z } from 'zod';
import type { Logger } from '../../http/logger.ts';
import { toDetail } from '../../http/redact.ts';
import type { SseEvent } from '../../http/sse.ts';
import type { EventWriter } from '../../stream/writer.ts';
import { GEMINI_PROVIDER_ID } from './request.ts';

// Loose wire schemas: unknown fields, part types and enum values are ignored, never fatal.
const Count = z.number().nullish();
const UsageSchema = z.looseObject({
  promptTokenCount: Count,
  cachedContentTokenCount: Count,
  candidatesTokenCount: Count,
  thoughtsTokenCount: Count,
  toolUsePromptTokenCount: Count,
});
const PartSchema = z.looseObject({
  text: z.string().optional(),
  thought: z.boolean().optional(),
  thoughtSignature: z.string().min(1).optional(),
  functionCall: z
    .looseObject({
      id: z.string().optional(),
      name: z.string().optional(),
      args: z.unknown().optional(),
    })
    .optional(),
});
const ChunkSchema = z.looseObject({
  candidates: z
    .array(
      z.looseObject({
        content: z.looseObject({ parts: z.array(PartSchema).optional() }).optional(),
        finishReason: z.string().optional(),
        finishMessage: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.looseObject({ blockReason: z.string().optional() }).optional(),
  usageMetadata: UsageSchema.optional(),
  modelVersion: z.string().min(1).optional(),
});
const ErrorChunkSchema = z.looseObject({
  error: z.looseObject({
    code: z.number().optional(),
    status: z.string().optional(),
    message: z.string().optional(),
  }),
});

export interface GeminiStreamOptions {
  readonly writer: EventWriter;
  readonly model: string;
  readonly logger: Logger;
  readonly secrets: () => readonly string[];
}

export interface GeminiStream {
  handle(event: SseEvent): ModelEvent[];
  end(): ModelEvent[];
}

/**
 * Turns `streamGenerateContent?alt=sse` chunks into model events
 * (https://ai.google.dev/api/generate-content). Function calls arrive whole (the Developer API
 * does not stream arguments). A `thoughtSignature` closes the part that carried it, so replay can
 * return it in that exact part. Each chunk's `usageMetadata` is a running snapshot: the latest
 * wins. There is no tool-call finish reason; tool use is detected from emitted calls.
 */
export function createGeminiStream(options: GeminiStreamOptions): GeminiStream {
  const { writer, logger } = options;
  let model = options.model;
  let synthesized = 0;

  const metadata = (data: { thoughtSignature?: string; idSynthesized?: true }) => ({
    origin: { providerId: GEMINI_PROVIDER_ID, modelId: model },
    data,
  });

  const fail = (kind: ProviderErrorKind, detail?: string): ModelEvent[] =>
    writer.fail(providerError(kind, GEMINI_PROVIDER_ID, detail === undefined ? {} : { detail }));

  function handle(sse: SseEvent): ModelEvent[] {
    let json: unknown;
    try {
      json = JSON.parse(sse.data);
    } catch (error) {
      if (error instanceof SyntaxError) return fail('invalid_response');
      throw error;
    }
    // A mid-stream failure is a bare google.rpc.Status object instead of a chunk.
    const errorChunk = ErrorChunkSchema.safeParse(json);
    if (errorChunk.success) {
      const { code, status, message } = errorChunk.data.error;
      return fail(
        statusKind(status, code),
        toDetail(`${status ?? String(code)}: ${message ?? ''}`, options.secrets()),
      );
    }
    const parsed = ChunkSchema.safeParse(json);
    if (!parsed.success) return fail('invalid_response');
    const chunk = parsed.data;
    if (chunk.modelVersion !== undefined) model = chunk.modelVersion;
    recordUsage(chunk.usageMetadata);

    const blocked = chunk.promptFeedback?.blockReason;
    const candidate = chunk.candidates?.[0];
    if (candidate === undefined) {
      if (blocked !== undefined) return writer.finish('refusal');
      return [];
    }
    const events = (candidate.content?.parts ?? []).flatMap(handlePart);
    if (candidate.finishReason !== undefined) {
      events.push(...finish(candidate.finishReason, candidate.finishMessage));
    }
    return events;
  }

  function handlePart(part: z.infer<typeof PartSchema>): ModelEvent[] {
    const signature = part.thoughtSignature;
    if (part.functionCall !== undefined) {
      const call = part.functionCall;
      const args = JsonObjectSchema.safeParse(call.args ?? {});
      const id = call.id ?? '';
      const idSynthesized = id === '';
      synthesized += idSynthesized ? 1 : 0;
      const data = {
        ...(signature === undefined ? {} : { thoughtSignature: signature }),
        ...(idSynthesized ? { idSynthesized: true as const } : {}),
      };
      return writer.toolCall({
        id: idSynthesized ? `gemini_call_${String(synthesized)}` : id,
        name: call.name ?? '',
        // args is a whole object on this API; a non-object is reported as not_an_object.
        rawInput: args.success ? JSON.stringify(args.data) : JSON.stringify(call.args ?? null),
        ...(Object.keys(data).length === 0 ? {} : { providerMetadata: metadata(data) }),
      });
    }
    if (part.text === undefined) return []; // inlineData, code execution and future part types
    if (part.thought === true) {
      const events = writer.reasoningDelta(part.text);
      return signature === undefined
        ? events
        : [
            ...events,
            ...writer.reasoningDone({
              providerMetadata: metadata({ thoughtSignature: signature }),
            }),
          ];
    }
    const events = writer.textDelta(part.text);
    return signature === undefined
      ? events
      : [...events, ...writer.textDone(metadata({ thoughtSignature: signature }))];
  }

  /**
   * Finish reasons (https://ai.google.dev/api/generate-content#FinishReason). Safety-type
   * reasons are refusals; a malformed call is reported as tool_call_invalid so the loop can tell
   * the model; reasons that mean our request or the response was broken are errors; anything
   * else (OTHER and future values) ends the turn with a warning.
   */
  function finish(reason: string, message: string | undefined): ModelEvent[] {
    switch (reason) {
      case 'STOP':
        return writer.finish('end_turn');
      case 'MAX_TOKENS':
        return writer.finish('max_tokens');
      case 'SAFETY':
      case 'RECITATION':
      case 'LANGUAGE':
      case 'BLOCKLIST':
      case 'PROHIBITED_CONTENT':
      case 'SPII':
      case 'IMAGE_SAFETY':
      case 'IMAGE_PROHIBITED_CONTENT':
        return writer.finish('refusal');
      case 'MALFORMED_FUNCTION_CALL':
        // The model's call could not be parsed. finishMessage describes it in prose (never JSON),
        // so the call is reported as invalid_json and the loop tells the model.
        synthesized += 1;
        return [
          ...writer.toolCall({
            id: `gemini_call_${String(synthesized)}`,
            name: '',
            rawInput: message === undefined || message === '' ? 'MALFORMED_FUNCTION_CALL' : message,
          }),
          ...writer.finish('tool_use'),
        ];
      case 'MISSING_THOUGHT_SIGNATURE':
        return fail('invalid_request');
      case 'UNEXPECTED_TOOL_CALL':
      case 'TOO_MANY_TOOL_CALLS':
      case 'MALFORMED_RESPONSE':
        return fail('invalid_response');
      default:
        logger.warn('unexpected Gemini finish reason', {
          providerId: GEMINI_PROVIDER_ID,
          finishReason: reason,
        });
        return writer.finish('end_turn' satisfies StopReason);
    }
  }

  /**
   * `promptTokenCount` includes cached tokens, which are subtracted; output is candidates plus
   * thoughts, because `candidatesTokenCount` excludes thinking and thinking is billed as output
   * (https://ai.google.dev/gemini-api/docs/generate-content/thinking, pricing). We send no
   * server-side tools, so `toolUsePromptTokenCount` should be zero; if not, it is logged and
   * ignored.
   */
  function recordUsage(usage: z.infer<typeof UsageSchema> | undefined): void {
    if (usage === undefined) return;
    const prompt = usage.promptTokenCount ?? undefined;
    const cached = usage.cachedContentTokenCount ?? 0;
    const candidates = usage.candidatesTokenCount ?? undefined;
    const thoughts = usage.thoughtsTokenCount ?? undefined;
    if ((usage.toolUsePromptTokenCount ?? 0) > 0) {
      logger.warn('Gemini reported tool-use prompt tokens', {
        providerId: GEMINI_PROVIDER_ID,
        toolUsePromptTokens: usage.toolUsePromptTokenCount ?? 0,
      });
    }
    writer.usage({
      ...(prompt === undefined ? {} : { inputTokens: prompt - cached }),
      ...(candidates === undefined && thoughts === undefined
        ? {}
        : { outputTokens: (candidates ?? 0) + (thoughts ?? 0) }),
      ...(usage.cachedContentTokenCount === null || usage.cachedContentTokenCount === undefined
        ? {}
        : { cacheReadTokens: cached }),
      ...(thoughts === undefined ? {} : { reasoningTokens: thoughts }),
    });
  }

  return {
    handle,
    end: () => (writer.finished ? [] : fail('invalid_response')),
  };
}

/** google.rpc.Status names (and the HTTP code when the name is absent). */
export function statusKind(
  status: string | undefined,
  code: number | undefined,
): ProviderErrorKind {
  switch (status ?? '') {
    case 'INVALID_ARGUMENT':
    case 'FAILED_PRECONDITION':
      return 'invalid_request';
    case 'UNAUTHENTICATED':
      return 'auth';
    case 'PERMISSION_DENIED':
      return 'permission';
    case 'NOT_FOUND':
      return 'not_found';
    case 'RESOURCE_EXHAUSTED':
      return 'rate_limit';
    case 'UNAVAILABLE':
      return 'overloaded';
    case 'INTERNAL':
      return 'server';
    case 'DEADLINE_EXCEEDED':
      return 'server';
    default:
      return code !== undefined && code >= 500 ? 'server' : 'unknown';
  }
}
