import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';

/** One `usage` model event, normalized (docs/model-contract.md). */
export interface UsageSample {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

/** A credential's totals for one UTC month. Integers only: money is in micro-dollars. */
export interface MonthTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly costUsdMicros: number;
  /** Some usage had no known price, so `costUsdMicros` understates the real spend. */
  readonly costIncomplete: boolean;
}

/** Month key (`YYYY-MM`, UTC) → totals. Plain data, so it serializes into the vault document. */
export type Ledger = Readonly<Record<string, MonthTotals>>;

export const EMPTY_LEDGER: Ledger = {};

const EMPTY_MONTH: MonthTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsdMicros: 0,
  costIncomplete: false,
};

export function monthKey(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Adds two counts, or null when the sum leaves the safe integer range. */
function add(a: number, b: number): number | null {
  const sum = a + b;
  return Number.isSafeInteger(sum) ? sum : null;
}

/**
 * Records one usage sample in its UTC month and returns a new ledger (the input is not changed).
 * `costUsdMicros` is null when the model's price is unknown; the month is then marked
 * cost-incomplete. Invalid numbers are refused rather than clamped, and so is a sum beyond the safe
 * integer range, so the ledger never silently under-counts.
 */
export function addUsage(
  ledger: Ledger,
  at: Date,
  sample: UsageSample,
  costUsdMicros: number | null,
): Result<Ledger, 'invalid_usage' | 'overflow'> {
  const counts = [
    sample.inputTokens,
    sample.outputTokens,
    sample.cacheReadTokens ?? 0,
    sample.cacheWriteTokens ?? 0,
    sample.reasoningTokens ?? 0,
    costUsdMicros ?? 0,
  ];
  if (Number.isNaN(at.getTime()) || !counts.every(isCount)) return err('invalid_usage');
  const key = monthKey(at);
  const month = ledger[key] ?? EMPTY_MONTH;
  const next = {
    inputTokens: add(month.inputTokens, sample.inputTokens),
    outputTokens: add(month.outputTokens, sample.outputTokens),
    cacheReadTokens: add(month.cacheReadTokens, sample.cacheReadTokens ?? 0),
    cacheWriteTokens: add(month.cacheWriteTokens, sample.cacheWriteTokens ?? 0),
    reasoningTokens: add(month.reasoningTokens, sample.reasoningTokens ?? 0),
    costUsdMicros: add(month.costUsdMicros, costUsdMicros ?? 0),
  };
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } = next;
  if (
    inputTokens === null ||
    outputTokens === null ||
    cacheReadTokens === null ||
    cacheWriteTokens === null ||
    reasoningTokens === null ||
    next.costUsdMicros === null
  ) {
    return err('overflow');
  }
  return ok({
    ...ledger,
    [key]: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      costUsdMicros: next.costUsdMicros,
      costIncomplete: month.costIncomplete || costUsdMicros === null,
    },
  });
}

export type CapStatus =
  | { readonly state: 'no_cap'; readonly spentUsdMicros: number; readonly costIncomplete: boolean }
  | {
      readonly state: 'within';
      readonly spentUsdMicros: number;
      readonly remainingUsdMicros: number;
      readonly costIncomplete: boolean;
    }
  | {
      readonly state: 'reached';
      readonly spentUsdMicros: number;
      readonly costIncomplete: boolean;
    };

/**
 * Where a month stands against a monthly cap. `reached` once spend is at or over the cap. auth only
 * reports this; enforcing it per run is the agent budget's job.
 */
export function capStatus(ledger: Ledger, month: string, capUsdMicros: number | null): CapStatus {
  const totals = ledger[month] ?? EMPTY_MONTH;
  const spent = totals.costUsdMicros;
  const { costIncomplete } = totals;
  if (capUsdMicros === null) return { state: 'no_cap', spentUsdMicros: spent, costIncomplete };
  if (spent >= capUsdMicros) return { state: 'reached', spentUsdMicros: spent, costIncomplete };
  return {
    state: 'within',
    spentUsdMicros: spent,
    remainingUsdMicros: capUsdMicros - spent,
    costIncomplete,
  };
}

/** Drops months before `oldestKept` (a `YYYY-MM` key) to bound the vault document's size. */
export function pruneMonthsBefore(ledger: Ledger, oldestKept: string): Ledger {
  return Object.fromEntries(Object.entries(ledger).filter(([key]) => key >= oldestKept));
}
