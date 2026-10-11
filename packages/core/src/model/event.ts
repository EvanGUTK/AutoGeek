import { z } from 'zod';
import { JsonObjectSchema } from '../json.ts';
import { ProviderMetadataSchema } from './message.ts';
import { ProviderErrorSchema } from './provider-error.ts';

export const STOP_REASONS = ['end_turn', 'tool_use', 'max_tokens', 'refusal'] as const;
export const StopReasonSchema = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof StopReasonSchema>;

const TokenCount = z.number().int().nonnegative();

/**
 * Token usage. `inputTokens` is UNCACHED input only: it excludes `cacheReadTokens` and
 * `cacheWriteTokens`, so the three plus `outputTokens` sum without double counting. Vendors
 * differ (some report cached tokens as a subset of their input count), so each adapter
 * normalizes by subtracting. `reasoningTokens` is informational and must not be added to
 * `outputTokens` unless the vendor excludes it from that count. Money is never computed here.
 */
export const ModelUsageSchema = z.strictObject({
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  cacheReadTokens: TokenCount.optional(),
  cacheWriteTokens: TokenCount.optional(),
  reasoningTokens: TokenCount.optional(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const TOOL_CALL_INVALID_REASONS = ['invalid_json', 'not_an_object', 'truncated'] as const;

const MAX_RAW_INPUT_BYTES = 4096;

/**
 * Streaming events from any provider, normalized. Ordering rules are in `event-order.ts` and are
 * enforced by the provider conformance suite. A stream ends with EXACTLY ONE terminal event
 * (`done` or `error`); an abort produces `error` with kind `aborted`.
 */
export const ModelEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text_delta'), text: z.string() }),
  /** Closes a text part; carries metadata (Gemini thought signatures, OpenAI item ids). */
  z.strictObject({
    type: z.literal('text_done'),
    providerMetadata: ProviderMetadataSchema.optional(),
  }),
  z.strictObject({ type: z.literal('reasoning_delta'), text: z.string() }),
  z.strictObject({
    type: z.literal('reasoning_done'),
    text: z.string(),
    providerMetadata: ProviderMetadataSchema.optional(),
  }),
  /** Only emitted once the input is fully assembled and parsed; adapters never leak partial JSON. */
  z.strictObject({
    type: z.literal('tool_call'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: JsonObjectSchema,
    providerMetadata: ProviderMetadataSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('tool_call_invalid'),
    id: z.string().min(1),
    name: z.string().min(1),
    /** Truncated to 4 KiB. Never shown to the model verbatim by default. */
    rawInput: z
      .string()
      .refine((text) => new TextEncoder().encode(text).length <= MAX_RAW_INPUT_BYTES, {
        message: `rawInput must be at most ${String(MAX_RAW_INPUT_BYTES)} bytes`,
      }),
    reason: z.enum(TOOL_CALL_INVALID_REASONS),
  }),
  ModelUsageSchema.extend({ type: z.literal('usage') }),
  z.strictObject({ type: z.literal('done'), stopReason: StopReasonSchema }),
  z.strictObject({ type: z.literal('error'), error: ProviderErrorSchema }),
]);
export type ModelEvent = z.infer<typeof ModelEventSchema>;
