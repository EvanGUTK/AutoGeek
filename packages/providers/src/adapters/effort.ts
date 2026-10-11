import { REASONING_EFFORTS } from '@autogeek/core';

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * The supported level nearest to `requested`: the closest lower one, else the closest higher
 * one. Undefined when the model takes no effort parameter.
 */
export function nearestEffort(
  requested: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  if (supported.includes(requested)) return requested;
  const ladder = REASONING_EFFORTS;
  const index = ladder.indexOf(requested);
  for (let i = index - 1; i >= 0; i -= 1) {
    const level = ladder[i];
    if (level !== undefined && supported.includes(level)) return level;
  }
  for (let i = index + 1; i < ladder.length; i += 1) {
    const level = ladder[i];
    if (level !== undefined && supported.includes(level)) return level;
  }
  return undefined;
}
