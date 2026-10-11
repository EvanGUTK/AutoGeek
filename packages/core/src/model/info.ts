import { z } from 'zod';
import type { Result } from '../result.ts';
import type { ModelEvent } from './event.ts';
import type { ProviderError } from './provider-error.ts';
import type { ModelRequest } from './request.ts';

export const SupportSchema = z.enum(['yes', 'no', 'unknown']);
export type Support = z.infer<typeof SupportSchema>;

/** Integer micro-USD (1 USD = 1_000_000) per million tokens. Money is never a float. */
const UsdMicrosPerMTok = z.number().int().nonnegative();

/**
 * What the loop, compaction and spend caps know about a model. `null` limits mean unknown; the
 * providers package exports `effectiveLimits(info)` with conservative numbers for unknowns
 * (context 8_192, max output 4_096) so unknown local models stay safe.
 *
 * `pricing` is integer USD micros per million tokens (so $3.00 is 3_000_000). This deliberately
 * differs from the float USD in docs/model-contract.md §5, following the chief's rule that money
 * in contracts is integer micros. Absent pricing means unknown: spend caps then warn instead of
 * computing.
 *
 * Cost arithmetic, wherever it is computed (agent, providers): for each usage event,
 * `cost = ceil(tokens * priceMicrosPer1M / 1_000_000)` micro-USD per priced token count. It ROUNDS
 * UP so spend caps over-count rather than under-count, and uses integer (BigInt) math, never
 * floats.
 */
export const ModelInfoSchema = z.strictObject({
  providerId: z.string().min(1),
  id: z.string().min(1),
  displayName: z.string().min(1),
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  capabilities: z.strictObject({
    tools: SupportSchema,
    vision: SupportSchema,
    reasoning: SupportSchema,
    promptCaching: SupportSchema,
  }),
  pricing: z
    .strictObject({
      input: UsdMicrosPerMTok,
      output: UsdMicrosPerMTok,
      cacheRead: UsdMicrosPerMTok.optional(),
      cacheWrite: UsdMicrosPerMTok.optional(),
    })
    .optional(),
  /** Where the data came from; the UI can show "estimated" for anything but `api`. */
  source: z.enum(['api', 'catalog', 'default']),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

/**
 * The seam between the agent loop and a vendor. `C` is the resolved credential type (owned by
 * `@autogeek/auth`; core only needs to know which provider it belongs to).
 *
 * `stream()` NEVER throws and never rejects: every failure, including a `credential_mismatch` or
 * a request found invalid locally, becomes the single terminal `error` event, and an abort
 * produces `error` with kind `aborted`. `listModels()` returns a `Result` instead of throwing,
 * per the "typed Results for expected failures" rule (a signature change from ARCHITECTURE.md §5).
 */
export interface ModelProvider<C extends { readonly providerId: string }> {
  readonly id: string;
  listModels(credential: C, signal: AbortSignal): Promise<Result<ModelInfo[], ProviderError>>;
  stream(request: ModelRequest, credential: C, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
