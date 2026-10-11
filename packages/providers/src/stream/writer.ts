import { JsonObjectSchema } from '@autogeek/core';
import type {
  JsonObject,
  ModelEvent,
  ModelUsage,
  ProviderError,
  ProviderMetadata,
  StopReason,
} from '@autogeek/core';
import { truncateUtf8 } from '../text.ts';

/** Mirrors `tool_call_invalid.rawInput`'s limit in @autogeek/core. */
const MAX_RAW_INPUT_BYTES = 4096;

/**
 * Name given to a call whose vendor sent no name (seen on some local servers). The agent answers
 * it with an unknown-tool result, which is what the model needs to recover.
 */
export const UNNAMED_TOOL = 'unnamed_tool';

export interface ToolCallInput {
  readonly id: string;
  readonly name: string;
  /** The complete argument JSON text as the vendor sent it. */
  readonly rawInput: string;
  readonly providerMetadata?: ProviderMetadata;
  /** The stream hit the output limit while this call's input was still arriving. */
  readonly truncated?: boolean;
}

export interface ReasoningDoneInput {
  /** Final text when the vendor sends it whole; defaults to the accumulated deltas. */
  readonly text?: string;
  readonly providerMetadata?: ProviderMetadata;
}

/**
 * Builds a contract-conforming event sequence (docs/model-contract.md section 3). Each method
 * returns the events to yield, so an adapter's generator does `yield* writer.textDelta(...)`.
 * Ordering is enforced by construction: starting a part closes the open one, the terminal event
 * comes once with `usage` right before it, and nothing follows it.
 */
export interface EventWriter {
  textDelta(text: string): ModelEvent[];
  /** Closes the open text part; with metadata and no open part, emits a metadata-only part. */
  textDone(providerMetadata?: ProviderMetadata): ModelEvent[];
  reasoningDelta(text: string): ModelEvent[];
  /** Closes the reasoning part, or emits a whole one (redacted reasoning: empty text). */
  reasoningDone(input?: ReasoningDoneInput): ModelEvent[];
  toolCall(call: ToolCallInput): ModelEvent[];
  /** Records usage; fields merge and the last value wins. Emitted just before the terminal. */
  usage(update: Partial<ModelUsage>): void;
  finish(vendorStopReason: StopReason): ModelEvent[];
  fail(error: ProviderError): ModelEvent[];
  /** A terminal event was emitted. */
  readonly finished: boolean;
  /** The part currently open, if any. */
  readonly openPart: 'text' | 'reasoning' | undefined;
  /** Some event reached the consumer, so the request must not be retried. */
  readonly started: boolean;
}

type OpenPart =
  { readonly kind: 'text' } | { readonly kind: 'reasoning'; text: string } | undefined;

export function createEventWriter(): EventWriter {
  let open: OpenPart;
  let finished = false;
  let started = false;
  let toolEvents = 0;
  let truncatedCall = false;
  const toolIds = new Set<string>();
  let usage: Partial<Record<keyof ModelUsage, number>> = {};

  const out = (events: ModelEvent[]): ModelEvent[] => {
    if (events.length > 0) started = true;
    return events;
  };

  function close(): ModelEvent[] {
    const part = open;
    open = undefined;
    if (part === undefined) return [];
    if (part.kind === 'text') return [{ type: 'text_done' }];
    return [{ type: 'reasoning_done', text: part.text }];
  }

  function uniqueId(id: string): string {
    const base = id === '' ? 'call' : id;
    let candidate = base;
    for (let n = 1; toolIds.has(candidate); n += 1) {
      candidate = `${base}_${String(n)}`;
    }
    toolIds.add(candidate);
    return candidate;
  }

  function usageEvents(): ModelEvent[] {
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } = usage;
    const values = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens];
    if (values.every((value) => value === undefined)) return [];
    return [
      {
        type: 'usage',
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
        ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
      },
    ];
  }

  return {
    get finished() {
      return finished;
    },
    get started() {
      return started;
    },
    get openPart() {
      return open?.kind;
    },
    textDelta(text) {
      if (finished || text === '') return [];
      const events = open?.kind === 'text' ? [] : close();
      open = { kind: 'text' };
      return out([...events, { type: 'text_delta', text }]);
    },
    textDone(providerMetadata) {
      if (finished) return [];
      if (open?.kind !== 'text') {
        if (providerMetadata === undefined) return [];
        return out([...close(), { type: 'text_done', providerMetadata }]);
      }
      open = undefined;
      return out([
        { type: 'text_done', ...(providerMetadata === undefined ? {} : { providerMetadata }) },
      ]);
    },
    reasoningDelta(text) {
      if (finished || text === '') return [];
      if (open?.kind === 'reasoning') {
        open.text += text;
        return out([{ type: 'reasoning_delta', text }]);
      }
      const events = close();
      open = { kind: 'reasoning', text };
      return out([...events, { type: 'reasoning_delta', text }]);
    },
    reasoningDone(input = {}) {
      if (finished) return [];
      const accumulated = open?.kind === 'reasoning' ? open.text : '';
      const events = open?.kind === 'reasoning' ? [] : close();
      open = undefined;
      return out([
        ...events,
        {
          type: 'reasoning_done',
          text: input.text ?? accumulated,
          ...(input.providerMetadata === undefined
            ? {}
            : { providerMetadata: input.providerMetadata }),
        },
      ]);
    },
    toolCall(call) {
      if (finished) return [];
      const events = close();
      const id = uniqueId(call.id);
      const name = call.name === '' ? UNNAMED_TOOL : call.name;
      toolEvents += 1;
      const rawInput = truncateUtf8(call.rawInput, MAX_RAW_INPUT_BYTES);
      if (call.truncated === true) {
        truncatedCall = true;
        return out([
          ...events,
          { type: 'tool_call_invalid', id, name, rawInput, reason: 'truncated' },
        ]);
      }
      const parsed = parseInput(call.rawInput);
      if (parsed.type === 'invalid') {
        return out([
          ...events,
          { type: 'tool_call_invalid', id, name, rawInput, reason: parsed.reason },
        ]);
      }
      return out([
        ...events,
        {
          type: 'tool_call',
          id,
          name,
          input: parsed.input,
          ...(call.providerMetadata === undefined
            ? {}
            : { providerMetadata: call.providerMetadata }),
        },
      ]);
    },
    usage(update) {
      if (finished) return;
      const next = { ...usage };
      for (const key of USAGE_KEYS) {
        const value = update[key];
        if (value === undefined) continue;
        if (!Number.isFinite(value)) continue;
        next[key] = Math.max(0, Math.round(value));
      }
      usage = next;
    },
    finish(vendorStopReason) {
      if (finished) return [];
      const events = [...close(), ...usageEvents()];
      finished = true;
      return out([...events, { type: 'done', stopReason: stopReason(vendorStopReason) }]);
    },
    fail(error) {
      if (finished) return [];
      // An error may cut a part short (the loop discards it), so the open part stays unclosed.
      open = undefined;
      finished = true;
      return out([...usageEvents(), { type: 'error', error }]);
    },
  };

  function stopReason(vendor: StopReason): StopReason {
    if (truncatedCall) return 'max_tokens';
    if (toolEvents > 0) return vendor === 'end_turn' ? 'tool_use' : vendor;
    return vendor === 'tool_use' ? 'end_turn' : vendor;
  }
}

const USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const;

type ParsedInput =
  | { readonly type: 'ok'; readonly input: JsonObject }
  | { readonly type: 'invalid'; readonly reason: 'invalid_json' | 'not_an_object' };

function parseInput(raw: string): ParsedInput {
  if (raw.trim() === '') return { type: 'ok', input: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return { type: 'invalid', reason: 'invalid_json' };
    throw error;
  }
  const object = JsonObjectSchema.safeParse(value);
  if (!object.success) return { type: 'invalid', reason: 'not_an_object' };
  return { type: 'ok', input: object.data };
}
