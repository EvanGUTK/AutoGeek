const DECIMAL = /^\d+(?:\.\d+)?$/;
/** Anything longer than a day is not a usable retry hint. */
const MAX_HINT_MS = 24 * 60 * 60 * 1000;

/**
 * Milliseconds the server asked us to wait, or undefined when it gave no usable hint.
 * `retry-after-ms` (OpenAI, Anthropic) wins over `retry-after`, which is delta-seconds or an
 * HTTP-date (RFC 9110 section 10.2.3). Malformed values are ignored, never guessed.
 */
export function parseRetryAfter(headers: Headers, nowMs: number): number | undefined {
  const ms = parseDecimal(headers.get('retry-after-ms'));
  if (ms !== undefined) {
    const hint = bounded(ms);
    if (hint !== undefined) return hint;
  }
  const raw = headers.get('retry-after')?.trim();
  if (raw === undefined || raw === '') return undefined;
  const seconds = parseDecimal(raw);
  if (seconds !== undefined) return bounded(seconds * 1000);
  // HTTP-dates always contain a letter (weekday or month); this rejects bare numbers like
  // "1e3" or "12 34", which Date.parse would otherwise read as years.
  if (!/[a-z]/i.test(raw) || !/\d/.test(raw)) return undefined;
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return bounded(Math.max(0, date - nowMs));
}

function parseDecimal(raw: string | null): number | undefined {
  const text = raw?.trim();
  if (text === undefined || !DECIMAL.test(text)) return undefined;
  return Number(text);
}

function bounded(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms > MAX_HINT_MS) return undefined;
  return Math.ceil(ms);
}
