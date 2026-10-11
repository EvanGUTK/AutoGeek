import { usdPerMTok } from '../pricing.ts';
import type { Pricing } from '../pricing.ts';
import type { ReasoningEffort } from '../effort.ts';

/** How a model's thinking is configured: Gemini 3 levels, or Gemini 2.5 token budgets. */
export type GeminiThinking =
  | { readonly kind: 'level'; readonly levels: readonly ReasoningEffort[] }
  | { readonly kind: 'budget'; readonly min: number; readonly max: number };

export interface GeminiModelProfile {
  readonly displayName: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly thinking: GeminiThinking;
  readonly pricing: Pricing;
}

const LEVELS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

function model(
  displayName: string,
  thinking: GeminiThinking,
  pricing: Pricing,
): GeminiModelProfile {
  // Every current text model: 1,048,576 input and 65,536 output tokens (model pages).
  return { displayName, contextWindow: 1_048_576, maxOutputTokens: 65_536, thinking, pricing };
}

/**
 * Sources (verified 2026-10-11; re-verify when models change):
 * https://ai.google.dev/gemini-api/docs/models/<id>,
 * https://ai.google.dev/gemini-api/docs/pricing (output prices include thinking tokens) and
 * https://ai.google.dev/gemini-api/docs/generate-content/thinking (levels and budgets).
 * Our efforts never ask for `minimal`, so each level list is the subset we use.
 */
const PROFILES: Readonly<Record<string, GeminiModelProfile>> = {
  // Pricing page, verified 2026-10-11. Introductory 0.75 / 3.75 / 0.075 until 2026-12-31; the
  // 2027 price is listed so spend caps never under-count: over-estimates by 2x until then.
  'gemini-3.8-flash': model(
    'Gemini 3.8 Flash',
    { kind: 'level', levels: LEVELS },
    usdPerMTok({ input: 1.5, output: 7.5, cacheRead: 0.15 }),
  ),
  // Pricing page, verified 2026-10-11. Same introductory pricing and 2027 rise as 3.8 Flash.
  'gemini-3.6-flash': model(
    'Gemini 3.6 Flash',
    { kind: 'level', levels: LEVELS },
    usdPerMTok({ input: 1.5, output: 7.5, cacheRead: 0.15 }),
  ),
  // Pricing page, verified 2026-10-11.
  'gemini-3.5-flash-lite': model(
    'Gemini 3.5 Flash-Lite',
    { kind: 'level', levels: LEVELS },
    usdPerMTok({ input: 0.3, output: 2.5, cacheRead: 0.03 }),
  ),
  // Pricing page, verified 2026-10-11 (text input price; audio input costs more).
  'gemini-3.1-flash-lite': model(
    'Gemini 3.1 Flash-Lite',
    { kind: 'level', levels: LEVELS },
    usdPerMTok({ input: 0.25, output: 1.5, cacheRead: 0.025 }),
  ),
  // Pricing page, verified 2026-10-11. Long-context (>200K) tier; base 2 / 12 / 0.20: short
  // prompts are over-estimated up to 2x on input and 1.5x on output.
  'gemini-3.1-pro-preview': model(
    'Gemini 3.1 Pro (preview)',
    { kind: 'level', levels: LEVELS },
    usdPerMTok({ input: 4, output: 18, cacheRead: 0.4 }),
  ),
  // Same model and pricing, tuned for mixing bash and custom tools.
  'gemini-3.1-pro-preview-customtools': model(
    'Gemini 3.1 Pro (preview, custom tools)',
    { kind: 'level', levels: LEVELS },
    usdPerMTok({ input: 4, output: 18, cacheRead: 0.4 }),
  ),
  // Pricing page, verified 2026-10-11 (text input price).
  'gemini-3-flash-preview': model(
    'Gemini 3 Flash (preview)',
    { kind: 'level', levels: LEVELS },
    usdPerMTok({ input: 0.5, output: 3, cacheRead: 0.05 }),
  ),
  // Pricing page, verified 2026-10-11. Long-context (>200K) tier; base 1.25 / 10 / 0.125:
  // short prompts are over-estimated up to 2x on input and 1.5x on output.
  'gemini-2.5-pro': model(
    'Gemini 2.5 Pro',
    { kind: 'budget', min: 128, max: 32_768 },
    usdPerMTok({ input: 2.5, output: 15, cacheRead: 0.25 }),
  ),
  // Pricing page, verified 2026-10-11 (text input price).
  'gemini-2.5-flash': model(
    'Gemini 2.5 Flash',
    { kind: 'budget', min: 0, max: 24_576 },
    usdPerMTok({ input: 0.3, output: 2.5, cacheRead: 0.03 }),
  ),
  // Pricing page, verified 2026-10-11 (text input price).
  'gemini-2.5-flash-lite': model(
    'Gemini 2.5 Flash-Lite',
    { kind: 'budget', min: 512, max: 24_576 },
    usdPerMTok({ input: 0.1, output: 0.4, cacheRead: 0.01 }),
  ),
};

export function geminiProfile(modelId: string): GeminiModelProfile | undefined {
  return PROFILES[modelId];
}

const BUDGETS: Readonly<Record<ReasoningEffort, number>> = {
  low: 1_024,
  medium: 8_192,
  high: 16_384,
  xhigh: Number.POSITIVE_INFINITY,
  max: Number.POSITIVE_INFINITY,
};

/** A Gemini 2.5 thinking budget for an effort, clamped to the model's allowed range. */
export function thinkingBudget(
  effort: ReasoningEffort,
  range: { min: number; max: number },
): number {
  return Math.min(range.max, Math.max(range.min, BUDGETS[effort]));
}
