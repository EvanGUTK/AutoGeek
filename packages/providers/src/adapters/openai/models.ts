import type { Support } from '@autogeek/core';
import { usdPerMTok } from '../pricing.ts';
import type { Pricing } from '../pricing.ts';
import type { ReasoningEffort } from '../effort.ts';

/** What the adapter must know about an OpenAI model; `GET /v1/models` reports none of it. */
export interface OpenAIModelProfile {
  readonly displayName: string;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  /** Accepts the `reasoning` parameter. */
  readonly reasoning: boolean;
  /** Accepted `reasoning.effort` levels among ours. */
  readonly efforts: readonly ReasoningEffort[];
  readonly vision: Support;
  readonly pricing?: Pricing;
}

const ALL: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const TO_XHIGH: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const TO_HIGH: readonly ReasoningEffort[] = ['low', 'medium', 'high'];
// Max INPUT tokens: the context window minus the 128K output reservation, as the model pages
// state (922K for the 1.05M-context models, 272K for the 400K ones).
const LARGE = 922_000;
const SMALL = 272_000;

/**
 * Prices are the documented USD per MTok (input / cached input / cache write / output). Models
 * with a long-context tier (prompts over 272K tokens) list the HIGHER tier: ModelInfo.pricing
 * cannot express tiers, and spend caps must over-count rather than under-count.
 */
function profile(
  displayName: string,
  contextWindow: number,
  efforts: readonly ReasoningEffort[],
  prices: { input: number; cacheRead: number; cacheWrite?: number; output: number },
): OpenAIModelProfile {
  return {
    displayName,
    contextWindow,
    maxOutputTokens: 128_000,
    reasoning: true,
    efforts,
    vision: 'yes',
    pricing: usdPerMTok(prices),
  };
}

/**
 * Re-verify when models change. Effort lists are the levels of ours the model accepts
 * (https://developers.openai.com/api/docs/guides/reasoning); gpt-5-mini/-nano accept reasoning
 * but their levels are unverified (low..high).
 */
const PROFILES: Readonly<Record<string, OpenAIModelProfile>> = {
  // https://developers.openai.com/api/docs/models/gpt-6-astra and /api/docs/pricing, verified 2026-10-11.
  // Long-context (>272K) tier; base 10 / 1 / 12.5 / 50: short prompts are over-estimated up
  // to 2x on input and 1.5x on output.
  'gpt-6-astra': profile('GPT-6 Astra', LARGE, ALL, {
    input: 20,
    cacheRead: 2,
    cacheWrite: 25,
    output: 75,
  }),
  // https://developers.openai.com/api/docs/models/gpt-6.1-sol and /api/docs/pricing, verified 2026-10-11.
  // Long-context (>272K) tier; base 2 / 0.10 / 2.5 / 10: short prompts are over-estimated up
  // to 2x on input and 1.5x on output.
  'gpt-6.1-sol': profile('GPT-6.1 Sol', LARGE, ALL, {
    input: 4,
    cacheRead: 0.2,
    cacheWrite: 5,
    output: 15,
  }),
  // https://developers.openai.com/api/docs/models/gpt-6-sol and /api/docs/pricing, verified 2026-10-11.
  // Long-context (>272K) tier; base 2 / 0.20 / 2.5 / 10: short prompts are over-estimated up
  // to 2x on input and 1.5x on output.
  'gpt-6-sol': profile('GPT-6 Sol', LARGE, ALL, {
    input: 4,
    cacheRead: 0.4,
    cacheWrite: 5,
    output: 15,
  }),
  // https://developers.openai.com/api/docs/models/gpt-6-luna and /api/docs/pricing, verified 2026-10-11.
  // Long-context (>272K) tier; base 0.10 / 0.01 / 0.125 / 0.50: short prompts are over-estimated up
  // to 2x on input and 1.5x on output.
  'gpt-6-luna': profile('GPT-6 Luna', LARGE, ALL, {
    input: 0.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    output: 0.75,
  }),
  // https://developers.openai.com/api/docs/models/gpt-5.6-sol and /api/docs/pricing, verified 2026-10-11.
  // Long-context (>272K) tier; base 4 / 0.40 / 5 / 20: short prompts are over-estimated up
  // to 2x on input and 1.5x on output.
  'gpt-5.6-sol': profile('GPT-5.6 Sol', LARGE, ALL, {
    input: 8,
    cacheRead: 0.8,
    cacheWrite: 10,
    output: 30,
  }),
  // https://developers.openai.com/api/docs/models/gpt-5.6-terra and /api/docs/pricing, verified 2026-10-11.
  // Long-context (>272K) tier; base 2 / 0.20 / 2.5 / 12: short prompts are over-estimated up
  // to 2x on input and 1.5x on output.
  'gpt-5.6-terra': profile('GPT-5.6 Terra', LARGE, ALL, {
    input: 4,
    cacheRead: 0.4,
    cacheWrite: 5,
    output: 18,
  }),
  // https://developers.openai.com/api/docs/models/gpt-5.6-luna and /api/docs/pricing, verified 2026-10-11.
  // Long-context (>272K) tier; base 0.20 / 0.02 / 0.25 / 1.20: short prompts are over-estimated up
  // to 2x on input and 1.5x on output.
  'gpt-5.6-luna': profile('GPT-5.6 Luna', LARGE, ALL, {
    input: 0.4,
    cacheRead: 0.04,
    cacheWrite: 0.5,
    output: 1.8,
  }),
  // https://developers.openai.com/api/docs/models/gpt-5.5 and /api/docs/pricing, verified 2026-10-11.
  // Long-context (>272K) tier (the model page lists it; the pricing page does not); base 5 / 0.50 / - / 30: short prompts are over-estimated up
  // to 2x on input and 1.5x on output.
  'gpt-5.5': profile('GPT-5.5', LARGE, TO_XHIGH, { input: 10, cacheRead: 1, output: 45 }),
  // https://developers.openai.com/api/docs/models/gpt-5.4 and /api/docs/pricing, verified 2026-10-11.
  // Long-context (>272K) tier; base 2.5 / 0.25 / - / 15: short prompts are over-estimated up
  // to 2x on input and 1.5x on output.
  'gpt-5.4': profile('GPT-5.4', LARGE, TO_XHIGH, { input: 5, cacheRead: 0.5, output: 22.5 }),
  // https://developers.openai.com/api/docs/models/gpt-5.4-mini and /api/docs/pricing, verified 2026-10-11.
  'gpt-5.4-mini': profile('GPT-5.4 mini', SMALL, TO_XHIGH, {
    input: 0.75,
    cacheRead: 0.075,
    output: 4.5,
  }),
  // https://developers.openai.com/api/docs/models/gpt-5.4-nano and /api/docs/pricing, verified 2026-10-11.
  'gpt-5.4-nano': profile('GPT-5.4 nano', SMALL, TO_XHIGH, {
    input: 0.2,
    cacheRead: 0.02,
    output: 1.25,
  }),
  // https://developers.openai.com/api/docs/models/gpt-5.2 and /api/docs/pricing, verified 2026-10-11.
  'gpt-5.2': profile('GPT-5.2', SMALL, TO_XHIGH, { input: 1.75, cacheRead: 0.175, output: 14 }),
  // https://developers.openai.com/api/docs/models/gpt-5.1 and /api/docs/pricing, verified 2026-10-11.
  'gpt-5.1': profile('GPT-5.1', SMALL, TO_HIGH, { input: 1.25, cacheRead: 0.125, output: 10 }),
  // https://developers.openai.com/api/docs/models/gpt-5 and /api/docs/pricing, verified 2026-10-11.
  'gpt-5': profile('GPT-5', SMALL, TO_HIGH, { input: 1.25, cacheRead: 0.125, output: 10 }),
  // https://developers.openai.com/api/docs/models/gpt-5-mini and /api/docs/pricing, verified 2026-10-11.
  'gpt-5-mini': profile('GPT-5 mini', SMALL, TO_HIGH, { input: 0.25, cacheRead: 0.025, output: 2 }),
  // https://developers.openai.com/api/docs/models/gpt-5-nano and /api/docs/pricing, verified 2026-10-11.
  'gpt-5-nano': profile('GPT-5 nano', SMALL, TO_HIGH, {
    input: 0.05,
    cacheRead: 0.005,
    output: 0.4,
  }),
};

/**
 * Reasoning-model families whose exact limits are not in the table. low/medium/high is the
 * effort range every documented reasoning model accepts (INFERRED); higher requests map to high.
 */
const REASONING_FAMILY = /^(gpt-5|gpt-6|o[1-9])(?![0-9])/;
const SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

export function openaiProfile(modelId: string): OpenAIModelProfile | undefined {
  const known = PROFILES[modelId] ?? PROFILES[modelId.replace(SNAPSHOT_SUFFIX, '')];
  if (known !== undefined) return known;
  if (!REASONING_FAMILY.test(modelId)) return undefined;
  return {
    displayName: modelId,
    contextWindow: null,
    maxOutputTokens: null,
    reasoning: true,
    efforts: ['low', 'medium', 'high'],
    vision: 'unknown',
  };
}
