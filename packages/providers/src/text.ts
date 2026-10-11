const encoder = new TextEncoder();

/**
 * `text` cut to at most `maxBytes` of UTF-8 on a code point boundary. When it had to be cut,
 * `suffix` is appended and counted inside the budget (or nothing is returned if even it does
 * not fit).
 */
export function truncateUtf8(text: string, maxBytes: number, suffix = ''): string {
  if (encoder.encode(text).length <= maxBytes) return text;
  const budget = maxBytes - encoder.encode(suffix).length;
  if (budget < 0) return '';
  let used = 0;
  let out = '';
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (used + size > budget) break;
    used += size;
    out += char;
  }
  return out + suffix;
}
