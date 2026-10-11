import { JsonObjectSchema, providerError } from '@autogeek/core';
import type { ModelEvent, StopReason } from '@autogeek/core';
import { z } from 'zod';
import type { Logger } from '../../http/logger.ts';
import { toDetail } from '../../http/redact.ts';
import type { EventWriter } from '../../stream/writer.ts';
import { OLLAMA_PROVIDER_ID } from './request.ts';

const Count = z.number().nullish();
const LineSchema = z.looseObject({
  model: z.string().min(1).optional(),
  message: z
    .looseObject({
      content: z.string().nullish(),
      thinking: z.string().nullish(),
      tool_calls: z
        .array(
          z.looseObject({
            id: z.string().nullish(),
            function: z.looseObject({
              name: z.string().nullish(),
              arguments: z.unknown().optional(),
            }),
          }),
        )
        .nullish(),
    })
    .nullish(),
  done: z.boolean().optional(),
  done_reason: z.string().nullish(),
  prompt_eval_count: Count,
  prompt_eval_cached_count: Count,
  eval_count: Count,
});
const ErrorLineSchema = z.looseObject({ error: z.string() });

export interface OllamaStreamOptions {
  readonly writer: EventWriter;
  readonly model: string;
  readonly logger: Logger;
}

/**
 * Turns `/api/chat` NDJSON lines into model events. Tool calls arrive whole with object arguments.
 * The final `done: true` line carries `done_reason` and usage (input minus cached prompt tokens;
 * `eval_count` includes thinking). There is no tool-call reason; tool use comes from calls seen.
 * Thinking parts carry origin metadata so replay can match provider + model.
 */
export function createOllamaStream(options: OllamaStreamOptions) {
  const { writer, logger } = options;
  let model = options.model;
  let calls = 0;

  function handle(value: unknown): ModelEvent[] {
    const error = ErrorLineSchema.safeParse(value);
    if (error.success) {
      return writer.fail(
        providerError('server', OLLAMA_PROVIDER_ID, { detail: toDetail(error.data.error, []) }),
      );
    }
    const parsed = LineSchema.safeParse(value);
    if (!parsed.success) return writer.fail(providerError('invalid_response', OLLAMA_PROVIDER_ID));
    const line = parsed.data;
    if (line.model !== undefined) model = line.model;
    const events: ModelEvent[] = [];
    const message = line.message;
    if (message?.thinking !== null && message?.thinking !== undefined && message.thinking !== '') {
      events.push(...writer.reasoningDelta(message.thinking));
    }
    if (message?.content !== null && message?.content !== undefined && message.content !== '') {
      events.push(...closeThinking(), ...writer.textDelta(message.content));
    }
    for (const call of message?.tool_calls ?? []) {
      calls += 1;
      const raw = call.function.arguments;
      const args = JsonObjectSchema.safeParse(raw ?? {});
      events.push(
        ...closeThinking(),
        ...writer.toolCall({
          id: call.id ?? `ollama_call_${String(calls)}`,
          name: call.function.name ?? '',
          // Arguments are an object on this API; a string is treated as raw JSON text.
          rawInput: args.success
            ? JSON.stringify(args.data)
            : typeof raw === 'string'
              ? raw
              : JSON.stringify(raw ?? null),
        }),
      );
    }
    if (line.done !== true) return events;
    const prompt = line.prompt_eval_count;
    const cached = line.prompt_eval_cached_count ?? 0;
    writer.usage({
      ...(prompt === null || prompt === undefined ? {} : { inputTokens: prompt - cached }),
      ...(line.prompt_eval_cached_count === null || line.prompt_eval_cached_count === undefined
        ? {}
        : { cacheReadTokens: cached }),
      ...(line.eval_count === null || line.eval_count === undefined
        ? {}
        : { outputTokens: line.eval_count }),
    });
    return [...events, ...closeThinking(), ...writer.finish(stopReason(line.done_reason ?? ''))];
  }

  /** Thinking ends with origin metadata, so only this model gets it back. */
  function closeThinking(): ModelEvent[] {
    if (writer.openPart !== 'reasoning') return [];
    return writer.reasoningDone({
      providerMetadata: { origin: { providerId: OLLAMA_PROVIDER_ID, modelId: model }, data: {} },
    });
  }

  function stopReason(reason: string): StopReason {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      default:
        logger.warn('unexpected Ollama done reason', {
          providerId: OLLAMA_PROVIDER_ID,
          doneReason: reason === '' ? 'none' : reason,
        });
        return 'end_turn';
    }
  }

  return {
    handle,
    end: (): ModelEvent[] =>
      writer.finished ? [] : writer.fail(providerError('invalid_response', OLLAMA_PROVIDER_ID)),
  };
}
