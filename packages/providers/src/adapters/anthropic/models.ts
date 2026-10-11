import { REASONING_EFFORTS } from '@autogeek/core';
import type { ReasoningEffort } from '../effort.ts';
import { usdPerMTok } from '../pricing.ts';
import type { Pricing } from '../pricing.ts';

/**
 * What the adapter must know about a Claude model to build a valid request. Sources (verified
 * 2026-10-11; re-verify when models change):
 * - https://platform.claude.com/docs/en/about-claude/models/overview.md (limits, pricing)
 * - https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking.md
 * - https://platform.claude.com/docs/en/build-with-claude/effort.md
 * - https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
 * `GET /v1/models` is authoritative for limits at listing time; this table only gates request
 * features, so an unknown model gets none of them.
 */
export interface AnthropicModelProfile {
  readonly displayName: string;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  /** Accepts `thinking: {type: "adaptive", display}`. */
  readonly adaptiveThinking: boolean;
  /** Accepted `output_config.effort` levels; empty means the parameter is not sent. */
  readonly efforts: readonly ReasoningEffort[];
  /** Accepts `role: "system"` inside `messages`. */
  readonly midConversationSystem: boolean;
  readonly pricing?: Pricing;
}

const NO_XHIGH: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max'];

/** Documented USD per MTok; cache writes use the 5-minute rate (1.25x input). */
function price(input: number, output: number, cacheRead: number): Pricing {
  return usdPerMTok({ input, output, cacheRead, cacheWrite: input * 1.25 });
}

function current(
  displayName: string,
  options: {
    midConversationSystem: boolean;
    efforts?: readonly ReasoningEffort[];
    pricing?: Pricing;
  },
): AnthropicModelProfile {
  return {
    displayName,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    adaptiveThinking: true,
    efforts: options.efforts ?? REASONING_EFFORTS,
    midConversationSystem: options.midConversationSystem,
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
  };
}

const PROFILES: Readonly<Record<string, AnthropicModelProfile>> = {
  // Price: https://platform.claude.com/docs/en/about-claude/models/overview.md, verified 2026-10-11.
  'claude-fable-5-1': current('Claude Fable 5.1', {
    midConversationSystem: true,
    pricing: price(10, 50, 0.25),
  }),
  // Price: https://platform.claude.com/docs/en/about-claude/models/overview.md, verified 2026-10-11.
  'claude-mythos-5-1': current('Claude Mythos 5.1', {
    midConversationSystem: true,
    pricing: price(10, 50, 0.25),
  }),
  // Price: https://platform.claude.com/docs/en/about-claude/models/overview.md, verified 2026-10-11.
  'claude-fable-5': current('Claude Fable 5', {
    midConversationSystem: true,
    pricing: price(10, 50, 1),
  }),
  // Price: https://platform.claude.com/docs/en/about-claude/models/overview.md, verified 2026-10-11.
  'claude-mythos-5': current('Claude Mythos 5', {
    midConversationSystem: true,
    pricing: price(10, 50, 1),
  }),
  // Price: https://platform.claude.com/docs/en/about-claude/models/overview.md, verified 2026-10-11.
  'claude-opus-5-5': current('Claude Opus 5.5', {
    midConversationSystem: true,
    pricing: price(4, 20, 0.2),
  }),
  // Price: https://platform.claude.com/docs/en/about-claude/models/overview.md, verified 2026-10-11.
  'claude-opus-5': current('Claude Opus 5', {
    midConversationSystem: true,
    pricing: price(5, 25, 0.5),
  }),
  // Price: https://platform.claude.com/docs/en/about-claude/models/overview.md, verified 2026-10-11.
  'claude-opus-4-8': current('Claude Opus 4.8', {
    midConversationSystem: true,
    pricing: price(5, 25, 0.5),
  }),
  'claude-opus-4-7': current('Claude Opus 4.7', { midConversationSystem: false }),
  'claude-opus-4-6': current('Claude Opus 4.6', {
    midConversationSystem: false,
    efforts: NO_XHIGH,
  }),
  // Price: https://platform.claude.com/docs/en/about-claude/models/overview.md, verified 2026-10-11.
  'claude-sonnet-5-5': current('Claude Sonnet 5.5', {
    midConversationSystem: true,
    pricing: price(2, 10, 0.2),
  }),
  // Price: https://platform.claude.com/docs/en/about-claude/models/overview.md, verified 2026-10-11.
  'claude-sonnet-5': current('Claude Sonnet 5', {
    midConversationSystem: false,
    pricing: price(2, 10, 0.2),
  }),
  'claude-sonnet-4-6': current('Claude Sonnet 4.6', {
    midConversationSystem: false,
    efforts: NO_XHIGH,
  }),
  'claude-haiku-5-5': {
    ...current('Claude Haiku 5.5', { midConversationSystem: true }),
    contextWindow: null,
  },
  'claude-haiku-4-5': {
    displayName: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    adaptiveThinking: false,
    efforts: [],
    midConversationSystem: false,
  },
};

/** A dated snapshot id (`claude-haiku-4-5-20251001`) shares its alias's profile. */
const SNAPSHOT_SUFFIX = /-\d{8}$/;

export function anthropicProfile(modelId: string): AnthropicModelProfile | undefined {
  return PROFILES[modelId] ?? PROFILES[modelId.replace(SNAPSHOT_SUFFIX, '')];
}
