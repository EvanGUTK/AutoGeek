import { providerError } from '@autogeek/core';
import type { ModelEvent, ModelUsage, ProviderErrorKind, StopReason } from '@autogeek/core';
import { z } from 'zod';
import type { Logger } from '../../http/logger.ts';
import { toDetail } from '../../http/redact.ts';
import type { SseEvent } from '../../http/sse.ts';
import type { EventWriter, ToolCallInput } from '../../stream/writer.ts';
import { ANTHROPIC_PROVIDER_ID } from './request.ts';

// Wire schemas are deliberately loose: unknown fields, event types, block types and delta types
// are ignored, never fatal (https://platform.claude.com/docs/en/build-with-claude/streaming.md,
// "Other events"; API versioning policy).
const Count = z.number().nullish();
const UsageSchema = z.looseObject({
  input_tokens: Count,
  output_tokens: Count,
  cache_creation_input_tokens: Count,
  cache_read_input_tokens: Count,
  output_tokens_details: z.looseObject({ thinking_tokens: Count }).nullish(),
});
const Index = z.number().int().nonnegative();

const EventSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('message_start'),
    message: z.looseObject({ model: z.string().min(1).optional(), usage: UsageSchema.nullish() }),
  }),
  z.looseObject({
    type: z.literal('content_block_start'),
    index: Index,
    content_block: z.looseObject({
      type: z.string(),
      id: z.string().optional(),
      name: z.string().optional(),
      data: z.string().optional(),
    }),
  }),
  z.looseObject({
    type: z.literal('content_block_delta'),
    index: Index,
    delta: z.looseObject({
      type: z.string(),
      text: z.string().optional(),
      thinking: z.string().optional(),
      signature: z.string().optional(),
      partial_json: z.string().optional(),
    }),
  }),
  z.looseObject({ type: z.literal('content_block_stop'), index: Index }),
  z.looseObject({
    type: z.literal('message_delta'),
    delta: z.looseObject({ stop_reason: z.string().nullish() }),
    usage: UsageSchema.nullish(),
  }),
  z.looseObject({ type: z.literal('message_stop') }),
  z.looseObject({
    type: z.literal('error'),
    error: z.looseObject({ type: z.string(), message: z.string().optional() }),
  }),
]);
const KNOWN_TYPES = new Set<string>(EventSchema.options.map((option) => option.shape.type.value));
const TypeOnly = z.looseObject({ type: z.string() });

type Block =
  | { readonly kind: 'text' }
  | { readonly kind: 'thinking'; signature: string }
  | { readonly kind: 'redacted'; readonly data: string }
  | { readonly kind: 'tool'; readonly id: string; readonly name: string; json: string }
  | { readonly kind: 'ignored' };

export interface AnthropicStreamOptions {
  readonly writer: EventWriter;
  /** The requested model; `message_start` may name the model that actually answered. */
  readonly model: string;
  readonly logger: Logger;
  readonly secrets: () => readonly string[];
}

export interface AnthropicStream {
  handle(event: SseEvent): ModelEvent[];
  /** The body ended. Without `message_stop` that is a truncated stream. */
  end(): ModelEvent[];
}

/**
 * Turns Messages API stream events into model events
 * (https://platform.claude.com/docs/en/build-with-claude/streaming.md).
 *
 * Tool calls are held until the next block starts or the stop reason arrives: with eager input
 * streaming a call cut off by `max_tokens` can still parse, so only the stop reason tells whether
 * the last call is complete. Usage is cumulative: `message_start` sets it and each
 * `message_delta` overwrites the fields it carries (never summed).
 */
export function createAnthropicStream(options: AnthropicStreamOptions): AnthropicStream {
  const { writer, logger } = options;
  const blocks = new Map<number, Block>();
  let pendingCalls: ToolCallInput[] = [];
  let model = options.model;
  let stopReason: string | undefined;

  const flushCalls = (truncateLast: boolean): ModelEvent[] => {
    const calls = pendingCalls;
    pendingCalls = [];
    return calls.flatMap((call, index) =>
      writer.toolCall(
        truncateLast && index === calls.length - 1 ? { ...call, truncated: true } : call,
      ),
    );
  };

  const metadata = (data: { signature: string } | { redactedData: string }) => ({
    origin: { providerId: ANTHROPIC_PROVIDER_ID, modelId: model },
    data,
  });

  // Held calls are dropped on failure: the loop discards a failed turn, and emitting calls right
  // before the error would make an unfinished turn look actionable.
  const fail = (kind: ProviderErrorKind, detail?: string): ModelEvent[] => {
    pendingCalls = [];
    return writer.fail(
      providerError(kind, ANTHROPIC_PROVIDER_ID, detail === undefined ? {} : { detail }),
    );
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
    if (!KNOWN_TYPES.has(typed.data.type)) return []; // ping and future event types
    const parsed = EventSchema.safeParse(json);
    if (!parsed.success) return fail('invalid_response');
    const event = parsed.data;

    switch (event.type) {
      case 'message_start':
        if (event.message.model !== undefined) model = event.message.model;
        recordUsage(event.message.usage);
        return [];
      case 'content_block_start': {
        const block = event.content_block;
        const flushed = flushCalls(false);
        switch (block.type) {
          case 'text':
            blocks.set(event.index, { kind: 'text' });
            break;
          case 'thinking':
            blocks.set(event.index, { kind: 'thinking', signature: '' });
            break;
          case 'redacted_thinking':
            blocks.set(event.index, { kind: 'redacted', data: block.data ?? '' });
            break;
          case 'tool_use':
            blocks.set(event.index, {
              kind: 'tool',
              id: block.id ?? '',
              name: block.name ?? '',
              json: '',
            });
            break;
          default:
            // Server-tool and future block types: we send no server tools, so nothing to map.
            blocks.set(event.index, { kind: 'ignored' });
        }
        return flushed;
      }
      case 'content_block_delta': {
        const block = blocks.get(event.index);
        const { delta } = event;
        if (block === undefined) return fail('invalid_response');
        if (block.kind === 'text' && delta.type === 'text_delta') {
          return writer.textDelta(delta.text ?? '');
        }
        if (block.kind === 'thinking' && delta.type === 'thinking_delta') {
          return writer.reasoningDelta(delta.thinking ?? '');
        }
        if (block.kind === 'thinking' && delta.type === 'signature_delta') {
          block.signature = delta.signature ?? ''; // assigned, not appended (SDK MessageStream)
          return [];
        }
        if (block.kind === 'tool' && delta.type === 'input_json_delta') {
          block.json += delta.partial_json ?? '';
          return [];
        }
        return []; // citations_delta and future delta types
      }
      case 'content_block_stop': {
        const block = blocks.get(event.index);
        blocks.delete(event.index);
        if (block === undefined) return fail('invalid_response');
        return stopBlock(block);
      }
      case 'message_delta':
        if (event.delta.stop_reason !== null && event.delta.stop_reason !== undefined) {
          stopReason = event.delta.stop_reason;
        }
        recordUsage(event.usage);
        return [];
      case 'message_stop': {
        const reason = mapStopReason(stopReason ?? '', logger);
        return [...flushCalls(reason === 'max_tokens'), ...writer.finish(reason)];
      }
      case 'error':
        return fail(
          errorKind(event.error.type),
          toDetail(`${event.error.type}: ${event.error.message ?? ''}`, options.secrets()),
        );
    }
  }

  function stopBlock(block: Block): ModelEvent[] {
    switch (block.kind) {
      case 'text':
        return writer.textDone();
      case 'thinking':
        return writer.reasoningDone(
          block.signature === ''
            ? {}
            : { providerMetadata: metadata({ signature: block.signature }) },
        );
      case 'redacted':
        return block.data === ''
          ? []
          : writer.reasoningDone({
              text: '',
              providerMetadata: metadata({ redactedData: block.data }),
            });
      case 'tool':
        pendingCalls.push({ id: block.id, name: block.name, rawInput: block.json });
        return [];
      case 'ignored':
        return [];
    }
  }

  function recordUsage(usage: z.infer<typeof UsageSchema> | null | undefined): void {
    if (usage === null || usage === undefined) return;
    // input_tokens already excludes cache reads and writes (prompt-caching docs), so it maps 1:1.
    const update: Partial<Record<keyof ModelUsage, number>> = {};
    const set = (key: keyof ModelUsage, value: number | null | undefined): void => {
      if (value !== null && value !== undefined) update[key] = value;
    };
    set('inputTokens', usage.input_tokens);
    set('outputTokens', usage.output_tokens);
    set('cacheReadTokens', usage.cache_read_input_tokens);
    set('cacheWriteTokens', usage.cache_creation_input_tokens);
    set('reasoningTokens', usage.output_tokens_details?.thinking_tokens);
    writer.usage(update);
  }

  return {
    handle,
    end: () => (writer.finished ? [] : fail('invalid_response')),
  };
}

/**
 * `stop_sequence` is a normal end; `model_context_window_exceeded` truncates like `max_tokens`;
 * `pause_turn` only follows server tools, which we never send. Unknown values end the turn and are
 * logged, never fatal.
 */
function mapStopReason(reason: string, logger: Logger): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      logger.warn('unexpected Anthropic stop reason', {
        providerId: ANTHROPIC_PROVIDER_ID,
        stopReason: reason === '' ? 'none' : reason,
      });
      return 'end_turn';
  }
}

/** Error `type` values from https://platform.claude.com/docs/en/api/errors (also used mid-stream). */
export function errorKind(type: string): ProviderErrorKind {
  switch (type) {
    case 'invalid_request_error':
      return 'invalid_request';
    case 'authentication_error':
      return 'auth';
    case 'permission_error':
      return 'permission';
    case 'not_found_error':
      return 'not_found';
    case 'billing_error':
      return 'quota';
    case 'rate_limit_error':
      return 'rate_limit';
    case 'overloaded_error':
      return 'overloaded';
    case 'api_error':
    case 'timeout_error':
      return 'server';
    default:
      return 'unknown';
  }
}
