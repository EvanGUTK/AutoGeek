import { JsonObjectSchema, providerError } from '@autogeek/core';
import type { ModelEvent, ModelUsage, ProviderErrorKind } from '@autogeek/core';
import { z } from 'zod';
import type { Logger } from '../../http/logger.ts';
import { toDetail } from '../../http/redact.ts';
import type { SseEvent } from '../../http/sse.ts';
import type { EventWriter } from '../../stream/writer.ts';
import { OPENAI_PROVIDER_ID } from './request.ts';

// Loose wire schemas: unknown fields, event types and item types are ignored, never fatal.
const Count = z.number().nullish();
const UsageSchema = z.looseObject({
  input_tokens: Count,
  output_tokens: Count,
  input_tokens_details: z
    .looseObject({ cached_tokens: Count, cache_write_tokens: Count })
    .nullish(),
  output_tokens_details: z.looseObject({ reasoning_tokens: Count }).nullish(),
});
const ResponseSchema = z.looseObject({
  model: z.string().min(1).optional(),
  usage: UsageSchema.nullish(),
  incomplete_details: z.looseObject({ reason: z.string().nullish() }).nullish(),
  error: z.looseObject({ code: z.string().nullish(), message: z.string().nullish() }).nullish(),
});
const ItemSchema = z.looseObject({
  type: z.string(),
  id: z.string().optional(),
  status: z.string().optional(),
  call_id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.string().optional(),
});
const OutputIndex = z.number().int().nonnegative();

const EventSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('response.created'), response: ResponseSchema }),
  z.looseObject({
    type: z.literal('response.output_item.added'),
    output_index: OutputIndex,
    item: ItemSchema,
  }),
  z.looseObject({
    type: z.literal('response.output_item.done'),
    output_index: OutputIndex,
    item: ItemSchema,
  }),
  z.looseObject({
    type: z.literal('response.output_text.delta'),
    output_index: OutputIndex,
    delta: z.string(),
  }),
  z.looseObject({
    type: z.literal('response.refusal.delta'),
    output_index: OutputIndex,
    delta: z.string(),
  }),
  z.looseObject({
    type: z.literal('response.reasoning_summary_text.delta'),
    output_index: OutputIndex,
    summary_index: z.number().int().nonnegative(),
    delta: z.string(),
  }),
  z.looseObject({
    type: z.literal('response.reasoning_text.delta'),
    output_index: OutputIndex,
    delta: z.string(),
  }),
  z.looseObject({
    type: z.literal('response.function_call_arguments.delta'),
    output_index: OutputIndex,
    delta: z.string(),
  }),
  z.looseObject({ type: z.literal('response.completed'), response: ResponseSchema }),
  z.looseObject({ type: z.literal('response.incomplete'), response: ResponseSchema }),
  z.looseObject({ type: z.literal('response.failed'), response: ResponseSchema }),
  z.looseObject({
    type: z.literal('error'),
    code: z.string().nullish(),
    message: z.string().nullish(),
  }),
]);
const KNOWN_TYPES = new Set<string>(EventSchema.options.map((option) => option.shape.type.value));
const TypeOnly = z.looseObject({ type: z.string() });

type Item =
  | { readonly kind: 'message' }
  | { readonly kind: 'reasoning'; lastSummaryIndex: number | undefined }
  | {
      readonly kind: 'call';
      readonly callId: string;
      readonly name: string;
      readonly itemId: string;
      json: string;
    }
  | { readonly kind: 'ignored' };

export interface OpenAIStreamOptions {
  readonly writer: EventWriter;
  readonly model: string;
  readonly logger: Logger;
  readonly secrets: () => readonly string[];
}

export interface OpenAIStream {
  handle(event: SseEvent): ModelEvent[];
  end(): ModelEvent[];
}

/**
 * Turns Responses API stream events into model events
 * (https://developers.openai.com/api/docs/guides/streaming-responses.md). Items are tracked by
 * `output_index`; the Responses API has no finish reason, so the stop reason is derived from the
 * terminal event (INFERRED from documented fields): `response.completed` ends the turn (tool use
 * when calls were emitted, refusal when refusal content was streamed), `response.incomplete` with
 * `max_output_tokens` is `max_tokens` and marks an unfinished call truncated.
 */
export function createOpenAIStream(options: OpenAIStreamOptions): OpenAIStream {
  const { writer, logger } = options;
  const items = new Map<number, Item>();
  let model = options.model;
  let refused = false;

  const metadata = <T extends Record<string, unknown>>(data: T) => ({
    origin: { providerId: OPENAI_PROVIDER_ID, modelId: model },
    data,
  });

  const fail = (kind: ProviderErrorKind, detail?: string): ModelEvent[] =>
    writer.fail(providerError(kind, OPENAI_PROVIDER_ID, detail === undefined ? {} : { detail }));

  /** Calls whose item never completed; at a max_output_tokens stop they were cut off. */
  const flushUnfinishedCalls = (): ModelEvent[] => {
    const events: ModelEvent[] = [];
    for (const [index, item] of [...items.entries()].sort(([a], [b]) => a - b)) {
      if (item.kind !== 'call') continue;
      items.delete(index);
      events.push(
        ...writer.toolCall({
          id: item.callId,
          name: item.name,
          rawInput: item.json,
          truncated: true,
        }),
      );
    }
    return events;
  };

  function handle(sse: SseEvent): ModelEvent[] {
    let json: unknown;
    try {
      json = JSON.parse(sse.data);
    } catch (error) {
      if (error instanceof SyntaxError) return fail('invalid_response');
      throw error;
    }
    const typed = TypeOnly.safeParse(json);
    if (!typed.success) return fail('invalid_response');
    if (!KNOWN_TYPES.has(typed.data.type)) return [];
    const parsed = EventSchema.safeParse(json);
    if (!parsed.success) return fail('invalid_response');
    const event = parsed.data;

    switch (event.type) {
      case 'response.created':
        if (event.response.model !== undefined) model = event.response.model;
        return [];
      case 'response.output_item.added':
        items.set(event.output_index, startItem(event.item));
        return [];
      case 'response.output_text.delta':
        return items.get(event.output_index)?.kind === 'message'
          ? writer.textDelta(event.delta)
          : [];
      case 'response.refusal.delta':
        // Shown as text so the user sees why; the turn ends with stopReason 'refusal'.
        refused = true;
        return items.get(event.output_index)?.kind === 'message'
          ? writer.textDelta(event.delta)
          : [];
      case 'response.reasoning_summary_text.delta': {
        const item = items.get(event.output_index);
        if (item?.kind !== 'reasoning') return [];
        const separator =
          item.lastSummaryIndex !== undefined && item.lastSummaryIndex !== event.summary_index
            ? '\n\n'
            : '';
        item.lastSummaryIndex = event.summary_index;
        return writer.reasoningDelta(separator + event.delta);
      }
      case 'response.reasoning_text.delta':
        return items.get(event.output_index)?.kind === 'reasoning'
          ? writer.reasoningDelta(event.delta)
          : [];
      case 'response.function_call_arguments.delta': {
        const item = items.get(event.output_index);
        if (item?.kind === 'call') item.json += event.delta;
        return [];
      }
      case 'response.output_item.done':
        return finishItem(event.output_index, event.item);
      case 'response.completed':
        recordUsage(event.response.usage);
        return [...flushUnfinishedCalls(), ...writer.finish(refused ? 'refusal' : 'end_turn')];
      case 'response.incomplete': {
        recordUsage(event.response.usage);
        const reason = event.response.incomplete_details?.reason;
        if (reason === 'max_output_tokens')
          return [...flushUnfinishedCalls(), ...writer.finish('max_tokens')];
        if (reason === 'content_filter') return writer.finish('refusal');
        logger.warn('unexpected OpenAI incomplete reason', {
          providerId: OPENAI_PROVIDER_ID,
          reason: reason ?? 'none',
        });
        return writer.finish(refused ? 'refusal' : 'end_turn');
      }
      case 'response.failed': {
        recordUsage(event.response.usage);
        const error = event.response.error;
        return fail(errorCodeKind(error?.code), detail(error?.code, error?.message));
      }
      case 'error':
        return fail(errorCodeKind(event.code), detail(event.code, event.message));
    }
  }

  function startItem(item: z.infer<typeof ItemSchema>): Item {
    switch (item.type) {
      case 'message':
        return { kind: 'message' };
      case 'reasoning':
        return { kind: 'reasoning', lastSummaryIndex: undefined };
      case 'function_call':
        return {
          kind: 'call',
          callId: item.call_id ?? '',
          name: item.name ?? '',
          itemId: item.id ?? '',
          json: item.arguments ?? '',
        };
      default:
        return { kind: 'ignored' };
    }
  }

  function finishItem(index: number, item: z.infer<typeof ItemSchema>): ModelEvent[] {
    const started = items.get(index);
    items.delete(index);
    if (started === undefined) return fail('invalid_response');
    switch (started.kind) {
      case 'message':
        return writer.textDone(item.id === undefined ? undefined : metadata({ itemId: item.id }));
      case 'reasoning': {
        // The whole output item (unknown fields included) is kept and replayed unmodified.
        const whole = JsonObjectSchema.safeParse(item);
        return writer.reasoningDone(
          whole.success ? { providerMetadata: metadata({ item: whole.data }) } : {},
        );
      }
      case 'call': {
        const itemId = item.id ?? started.itemId;
        return writer.toolCall({
          id: item.call_id ?? started.callId,
          name: item.name ?? started.name,
          rawInput: item.arguments ?? started.json,
          truncated: item.status === 'incomplete',
          ...(itemId === '' ? {} : { providerMetadata: metadata({ itemId }) }),
        });
      }
      case 'ignored':
        return [];
    }
  }

  /**
   * `input_tokens` includes cached tokens, which are subtracted. `cache_write_tokens` is reported
   * but NOT subtracted: whether it is a subset of `input_tokens` is unverified (opt-in smoke test),
   * and the rule for unverified semantics is to over-count, never under-count.
   */
  function recordUsage(usage: z.infer<typeof UsageSchema> | null | undefined): void {
    if (usage === null || usage === undefined) return;
    const update: Partial<Record<keyof ModelUsage, number>> = {};
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    if (usage.input_tokens !== null && usage.input_tokens !== undefined) {
      update.inputTokens = usage.input_tokens - cached;
    }
    const set = (key: keyof ModelUsage, value: number | null | undefined): void => {
      if (value !== null && value !== undefined) update[key] = value;
    };
    set('outputTokens', usage.output_tokens);
    set('cacheReadTokens', usage.input_tokens_details?.cached_tokens);
    set('cacheWriteTokens', usage.input_tokens_details?.cache_write_tokens);
    set('reasoningTokens', usage.output_tokens_details?.reasoning_tokens);
    writer.usage(update);
  }

  function detail(code: string | null | undefined, message: string | null | undefined): string {
    return toDetail(`${code ?? 'error'}: ${message ?? ''}`, options.secrets());
  }

  return {
    handle,
    end: () => (writer.finished ? [] : fail('invalid_response')),
  };
}

/** `response.failed` / `error` codes (openai-node `ResponseError.code`). */
function errorCodeKind(code: string | null | undefined): ProviderErrorKind {
  switch (code) {
    case 'rate_limit_exceeded':
      return 'rate_limit';
    case 'server_error':
    case 'vector_store_timeout':
      return 'server';
    case 'context_length_exceeded':
      return 'context_length';
    case 'insufficient_quota':
      return 'quota';
    case null:
    case undefined:
      return 'unknown';
    default:
      return code.startsWith('invalid_') ? 'invalid_request' : 'unknown';
  }
}
