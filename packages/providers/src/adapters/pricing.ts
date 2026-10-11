/** Integer micro-USD per million tokens (ModelInfo.pricing). Money is never a float. */
export interface Pricing {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** Documented USD-per-MTok prices to integer micros, rounded to the nearest micro. */
export function usdPerMTok(prices: {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}): Pricing {
  const micros = (usd: number): number => Math.round(usd * 1_000_000);
  return {
    input: micros(prices.input),
    output: micros(prices.output),
    ...(prices.cacheRead === undefined ? {} : { cacheRead: micros(prices.cacheRead) }),
    ...(prices.cacheWrite === undefined ? {} : { cacheWrite: micros(prices.cacheWrite) }),
  };
}
