import { describe, expect, it } from 'vitest';
import { err } from '../result.ts';
import { EMPTY_LEDGER, addUsage, capStatus, monthKey, pruneMonthsBefore } from './ledger.ts';
import type { Ledger, MonthTotals } from './ledger.ts';

const OCT = new Date('2026-10-31T23:59:59.999Z');
const NOV = new Date('2026-11-01T00:00:00.000Z');
const ZERO: MonthTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsdMicros: 0,
  costIncomplete: false,
};

function unwrap(result: ReturnType<typeof addUsage>): Ledger {
  if (!result.ok) throw new Error(`addUsage failed: ${result.error}`);
  return result.value;
}

describe('monthKey', () => {
  it('buckets by UTC month regardless of local time zone', () => {
    expect(monthKey(OCT)).toBe('2026-10');
    expect(monthKey(NOV)).toBe('2026-11');
    expect(monthKey(new Date('0999-01-15T00:00:00Z'))).toBe('0999-01');
  });
});

describe('addUsage', () => {
  it('accumulates every token kind and cost into the event month', () => {
    let ledger = unwrap(
      addUsage(EMPTY_LEDGER, OCT, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 }, 1500),
    );
    ledger = unwrap(
      addUsage(
        ledger,
        OCT,
        { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3, reasoningTokens: 4 },
        25,
      ),
    );
    ledger = unwrap(addUsage(ledger, NOV, { inputTokens: 7, outputTokens: 0 }, 0));
    expect(ledger).toEqual({
      '2026-10': {
        ...ZERO,
        inputTokens: 101,
        outputTokens: 22,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
        reasoningTokens: 4,
        costUsdMicros: 1525,
      },
      '2026-11': { ...ZERO, inputTokens: 7 },
    });
  });

  it('does not mutate the input ledger', () => {
    const before = unwrap(addUsage(EMPTY_LEDGER, OCT, { inputTokens: 1, outputTokens: 1 }, 1));
    const snapshot = structuredClone(before);
    unwrap(addUsage(before, OCT, { inputTokens: 1, outputTokens: 1 }, 1));
    expect(before).toEqual(snapshot);
  });

  it('marks the month cost-incomplete when a sample has unknown pricing', () => {
    const ledger = unwrap(addUsage(EMPTY_LEDGER, OCT, { inputTokens: 10, outputTokens: 10 }, null));
    expect(ledger['2026-10']).toEqual({
      ...ZERO,
      inputTokens: 10,
      outputTokens: 10,
      costIncomplete: true,
    });
  });

  it('keeps a month cost-incomplete after later priced samples', () => {
    let ledger = unwrap(addUsage(EMPTY_LEDGER, OCT, { inputTokens: 1, outputTokens: 1 }, null));
    ledger = unwrap(addUsage(ledger, OCT, { inputTokens: 1, outputTokens: 1 }, 10));
    expect(ledger['2026-10']?.costIncomplete).toBe(true);
  });

  it.each([
    ['a negative count', { inputTokens: -1, outputTokens: 0 }, 0],
    ['a fractional count', { inputTokens: 1.5, outputTokens: 0 }, 0],
    ['NaN', { inputTokens: Number.NaN, outputTokens: 0 }, 0],
    ['Infinity', { inputTokens: 0, outputTokens: Number.POSITIVE_INFINITY }, 0],
    ['a negative cost', { inputTokens: 0, outputTokens: 0 }, -5],
    ['a fractional cost', { inputTokens: 0, outputTokens: 0 }, 0.5],
  ] as const)('rejects %s without changing anything', (_name, sample, cost) => {
    expect(addUsage(EMPTY_LEDGER, OCT, sample, cost)).toEqual(err('invalid_usage'));
  });

  it('rejects a sum beyond the safe integer range', () => {
    const near = unwrap(
      addUsage(EMPTY_LEDGER, OCT, { inputTokens: Number.MAX_SAFE_INTEGER - 1, outputTokens: 0 }, 0),
    );
    expect(addUsage(near, OCT, { inputTokens: 2, outputTokens: 0 }, 0)).toEqual(err('overflow'));
  });

  it('rejects an invalid date', () => {
    expect(
      addUsage(EMPTY_LEDGER, new Date(Number.NaN), { inputTokens: 1, outputTokens: 1 }, 1),
    ).toEqual(err('invalid_usage'));
  });
});

describe('capStatus', () => {
  const ledger = unwrap(
    addUsage(EMPTY_LEDGER, OCT, { inputTokens: 1, outputTokens: 1 }, 4_000_000),
  );

  it('reports no_cap when none is set', () => {
    expect(capStatus(ledger, '2026-10', null)).toEqual({
      state: 'no_cap',
      spentUsdMicros: 4_000_000,
      costIncomplete: false,
    });
  });

  it('reports remaining spend under the cap', () => {
    expect(capStatus(ledger, '2026-10', 5_000_000)).toEqual({
      state: 'within',
      spentUsdMicros: 4_000_000,
      remainingUsdMicros: 1_000_000,
      costIncomplete: false,
    });
  });

  it('reports reached at and over the cap', () => {
    expect(capStatus(ledger, '2026-10', 4_000_000)).toMatchObject({ state: 'reached' });
    expect(capStatus(ledger, '2026-10', 1)).toMatchObject({ state: 'reached' });
  });

  it('treats a month with no usage as zero spend', () => {
    expect(capStatus(ledger, '2026-11', 10)).toEqual({
      state: 'within',
      spentUsdMicros: 0,
      remainingUsdMicros: 10,
      costIncomplete: false,
    });
  });

  it('carries cost-incompleteness so a cap is never shown as reliable when it is not', () => {
    const partial = unwrap(addUsage(EMPTY_LEDGER, OCT, { inputTokens: 1, outputTokens: 1 }, null));
    expect(capStatus(partial, '2026-10', 10)).toMatchObject({ costIncomplete: true });
  });

  it('treats a cap of zero as already reached', () => {
    expect(capStatus(EMPTY_LEDGER, '2026-10', 0)).toMatchObject({ state: 'reached' });
  });
});

describe('pruneMonthsBefore', () => {
  it('drops months older than the given month and keeps the rest', () => {
    let ledger = EMPTY_LEDGER;
    for (const iso of ['2024-09-15', '2024-10-15', '2026-10-15']) {
      ledger = unwrap(
        addUsage(ledger, new Date(`${iso}T00:00:00Z`), { inputTokens: 1, outputTokens: 0 }, 1),
      );
    }
    expect(Object.keys(pruneMonthsBefore(ledger, '2024-10')).sort()).toEqual([
      '2024-10',
      '2026-10',
    ]);
  });
});
