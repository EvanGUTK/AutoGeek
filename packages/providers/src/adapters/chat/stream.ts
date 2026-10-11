import { JsonObjectSchema, providerError } from '@autogeek/core';
import type {
  JsonObject,
  ModelEvent,
  ModelUsage,
  ProviderErrorKind,
  StopReason,
} from '@autogeek/core';
import { z } from 'zod';
import type { Logger } from '../../http/logger.ts';
import { toDetail } from '../../http/redact.ts';
import type { SseEvent } from '../../http/sse.ts';
import type { EventWriter } from '../../stream/writer.ts';

// Tolerant schemas for the whole compatible family; every field is optional and unknown fields,
// comments and extra chunks are ignored (wire notes: OpenRouter, Ollama /v1, LM Studio, llama.cpp).
const Count = z.number().nullish();
const UsageSchema = z.looseObject({
  prompt_tokens: Count,
  completion_tokens: Count,
  prompt_tokens_details: z
    .looseObject({ cached_tokens: Count, cache_write_tokens: Count })
    .nullish(),
  completion_tokens_details: z.looseObject({ reasoning_tokens: Count }).nullish(),
});
const ToolCallDeltaSchema = z.looseObject({
  index: z.number().int().nonnegative().optional(),
  id: z.string().nullish(),
  function: z
    .looseObject({ name: z.string().nullish(), arguments: z.string().nullish() })
    .nullish(),
});
const ChunkSchema = z.looseObject({
  model: z.string().min(1).optional(),
  choices: z
    .array(
      z.looseObject({
        delta: z
          .looseObject({
            content: z.string().nullish(),
            refusal: z.string().nullish(),
            reasoning: z.string().nullish(),
            reasoning_content: z.string().nullish(),
            reasoning_details: z.array(z.unknown()).nullish(),
            tool_calls: z.array(ToolCallDeltaSchema).nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .nullish(),
  usage: UsageSchema.nullish(),
});
const ErrorChunkSchema = z.looseObject({
  error: z.looseObject({
    code: z.union([z.number(), z.string()]).nullish(),
    message: z.string().nullish(),
    type: z.string().nullish(),
    metadata: z.looseObject({ error_type: z.string().nullish() }).nullish(),
  }),
});

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

export interface ChatStreamOptions {
  readonly writer: EventWriter;
  readonly providerId: string;
  readonly model: string;
  readonly logger: Logger;
  readonly secrets: () => readonly string[];
}

export interface ChatStream {
  handle(event: SseEvent): ModelEvent[];
  end(): ModelEvent[];
}

/**
 * Parses an OpenAI-style Chat Completions stream from any compatible server. Tool calls are keyed
 * by `index` (servers that send whole calls fit the same path) and emitted, in index order, when
 * the finish reason arrives; `length` then marks the last one truncated. Tool use is judged by the
 * calls actually seen, never by `finish_reason` alone. Reasoning is read from `reasoning` or
 * `reasoning_content`; OpenRouter `reasoning_details` are merged by index and kept for replay.
 * Usage may come on its own chunk, with or without choices, or never.
 */
export function createChatStream(options: ChatStreamOptions): ChatStream {
  const { writer, logger, providerId } = options;
  let model = options.model;
  const calls = new Map<number, PendingCall>();
  const details: JsonObject[] = [];
  let finishReason: string | undefined;
  let refused = false;

  const fail = (kind: ProviderErrorKind, detail?: string): ModelEvent[] =>
    writer.fail(providerError(kind, providerId, detail === undefined ? {} : { detail }));

  const closeReasoning = (): ModelEvent[] =>
    details.length === 0
      ? []
      : writer.reasoningDone({
          providerMetadata: {
            origin: { providerId, modelId: model },
            data: { reasoningDetails: details.splice(0) },
          },
        });

  const flushCalls = (truncateLast: boolean): ModelEvent[] => {
    const ordered = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    calls.clear();
    return ordered.flatMap((call, index) =>
      writer.toolCall({
        id: call.id,
        name: call.name,
        rawInput: call.args,
        truncated: truncateLast && index === ordered.length - 1,
      }),
    );
  };

  function finish(): ModelEvent[] {
    const reason = finishReason;
    const events = [...closeReasoning(), ...flushCalls(reason === 'length')];
    return [...events, ...writer.finish(stopReason(reason))];
  }

  function stopReason(reason: string | undefined): StopReason {
    if (refused) return 'refusal';
    switch (reason ?? '') {
      case 'stop':
      case 'tool_calls':
      case 'function_call':
        return 'end_turn'; // the writer turns this into tool_use when calls were emitted
      case 'length':
        return 'max_tokens';
      case 'content_filter':
        return 'refusal';
      default:
        logger.warn('unexpected chat finish reason', {
          providerId,
          finishReason: reason ?? 'none',
        });
        return 'end_turn';
    }
  }

  function handle(sse: SseEvent): ModelEvent[] {
    // [DONE] ends the turn; a missing finish reason is tolerated (logged) because content was framed.
    if (sse.data.trim() === '[DONE]') return finish();
    let json: unknown;
    try {
      json = JSON.parse(sse.data);
    } catch (error) {
      if (error instanceof SyntaxError) return fail('invalid_response');
      throw error;
    }
    const errorChunk = ErrorChunkSchema.safeParse(json);
    if (errorChunk.success) {
      const { code, message, metadata, type } = errorChunk.data.error;
      return fail(
        errorKind(code, metadata?.error_type ?? type ?? undefined),
        toDetail(`${String(code ?? type ?? 'error')}: ${message ?? ''}`, options.secrets()),
      );
    }
    const parsed = ChunkSchema.safeParse(json);
    if (!parsed.success) return fail('invalid_response');
    const chunk = parsed.data;
    if (chunk.model !== undefined) model = chunk.model;
    recordUsage(chunk.usage);

    const events: ModelEvent[] = [];
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta !== null && delta !== undefined) {
      const reasoning = delta.reasoning ?? delta.reasoning_content;
      if (reasoning !== null && reasoning !== undefined)
        events.push(...writer.reasoningDelta(reasoning));
      for (const item of delta.reasoning_details ?? []) mergeDetail(item);
      if (delta.content !== null && delta.content !== undefined && delta.content !== '') {
        events.push(...closeReasoning(), ...writer.textDelta(delta.content));
      }
      if (delta.refusal !== null && delta.refusal !== undefined && delta.refusal !== '') {
        refused = true;
        events.push(...closeReasoning(), ...writer.textDelta(delta.refusal));
      }
      for (const [position, call] of (delta.tool_calls ?? []).entries()) recordCall(call, position);
    }
    // OpenRouter repeats the finish reason on its usage chunk; the first one wins.
    if (
      choice?.finish_reason !== null &&
      choice?.finish_reason !== undefined &&
      finishReason === undefined
    ) {
      if (choice.finish_reason === 'error') return [...events, ...fail('server')];
      finishReason = choice.finish_reason;
    }
    return events;
  }

  function recordCall(delta: z.infer<typeof ToolCallDeltaSchema>, position: number): void {
    const index = delta.index ?? position;
    const call = calls.get(index) ?? { id: '', name: '', args: '' };
    if (call.id === '' && delta.id !== null && delta.id !== undefined) call.id = delta.id;
    const name = delta.function?.name;
    if (call.name === '' && name !== null && name !== undefined) call.name = name;
    call.args += delta.function?.arguments ?? '';
    calls.set(index, call);
  }

  /** Streamed detail objects with the same index are fragments of one: strings concatenate. */
  function mergeDetail(item: unknown): void {
    const detail = JsonObjectSchema.safeParse(item);
    if (!detail.success) return;
    const index = detail.data['index'];
    const existing = details.find(
      (candidate) => candidate['index'] === index && index !== undefined,
    );
    if (existing === undefined) {
      details.push({ ...detail.data });
      return;
    }
    for (const [key, value] of Object.entries(detail.data)) {
      const previous = existing[key];
      existing[key] =
        typeof previous === 'string' &&
        typeof value === 'string' &&
        key !== 'type' &&
        key !== 'id' &&
        key !== 'format'
          ? previous + value
          : value;
    }
  }

  /**
   * Cached prompt tokens are subtracted from `prompt_tokens`; cache writes are reported but NOT
   * subtracted until a smoke test shows they are a subset (over-count rule).
   */
  function recordUsage(usage: z.infer<typeof UsageSchema> | null | undefined): void {
    if (usage === null || usage === undefined) return;
    const update: Partial<Record<keyof ModelUsage, number>> = {};
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    if (usage.prompt_tokens !== null && usage.prompt_tokens !== undefined)
      update.inputTokens = usage.prompt_tokens - cached;
    const set = (key: keyof ModelUsage, value: number | null | undefined): void => {
      if (value !== null && value !== undefined) update[key] = value;
    };
    set('outputTokens', usage.completion_tokens);
    set('cacheReadTokens', usage.prompt_tokens_details?.cached_tokens);
    set('cacheWriteTokens', usage.prompt_tokens_details?.cache_write_tokens);
    set('reasoningTokens', usage.completion_tokens_details?.reasoning_tokens);
    writer.usage(update);
  }

  return {
    handle,
    // Some servers end the body without [DONE]; a recorded finish reason still completes the turn.
    end: () => {
      if (writer.finished) return [];
      return finishReason === undefined ? fail('invalid_response') : finish();
    },
  };
}

/** Error chunks: OpenRouter numeric HTTP codes or `metadata.error_type`, OpenAI-style string types. */
export function errorKind(
  code: number | string | null | undefined,
  type: string | undefined,
): ProviderErrorKind {
  switch (type ?? '') {
    case 'context_length_exceeded':
    case 'exceed_context_size_error':
      return 'context_length';
    case 'rate_limit_exceeded':
    case 'rate_limit_error':
      return 'rate_limit';
    case 'payment_required':
    case 'insufficient_quota':
      return 'quota';
    case 'provider_overloaded':
    case 'provider_unavailable':
    case 'unavailable_error':
      return 'overloaded';
    case 'authentication':
    case 'authentication_error':
      return 'auth';
    case 'invalid_request':
    case 'invalid_request_error':
      return 'invalid_request';
    default:
      break;
  }
  if (typeof code === 'number') {
    if (code === 429) return 'rate_limit';
    if (code === 402) return 'quota';
    if (code === 401) return 'auth';
    if (code >= 500) return 'server';
    if (code >= 400) return 'invalid_request';
  }
  return code === 'server_error' ? 'server' : 'unknown';
}
