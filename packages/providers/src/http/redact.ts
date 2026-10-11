import { truncateUtf8 } from '../text.ts';

/** Mirrors ProviderError.detail's limit in @autogeek/core. */
export const MAX_DETAIL_BYTES = 2048;
const MARK = '[REDACTED]';
const ELLIPSIS = '…';

// No word boundaries: a key glued to other text must still go. Over-redaction is the safe side.
const PATTERNS: readonly RegExp[] = [
  // OpenAI (sk-, sk-proj-), Anthropic (sk-ant-), OpenRouter (sk-or-).
  /sk-[A-Za-z0-9_-]{8,}/g,
  // Google API keys.
  /AIza[0-9A-Za-z_-]{20,}/g,
  // JWT-shaped tokens (OAuth access tokens).
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];
const BEARER = /\b(Bearer\s+)[^\s"',}]+/gi;
const KEYED =
  /(["']?(?:api[_-]?key|x-api-key|x-goog-api-key|authorization|access[_-]?token|refresh[_-]?token|token|secret|password)["']?\s*[:=]\s*["']?)(?!Bearer\s)[^\s"',}]+/gi;

/**
 * Best-effort removal of credentials from vendor text before it reaches a log or
 * `ProviderError.detail`. `knownSecrets` are exact values to remove (the credential in use,
 * revealed inline by the caller and not retained).
 */
export function redactSecrets(text: string, knownSecrets: readonly string[]): string {
  let result = text;
  for (const secret of knownSecrets) {
    if (secret !== '') result = result.split(secret).join(MARK);
  }
  for (const pattern of PATTERNS) result = result.replace(pattern, MARK);
  result = result.replace(BEARER, `$1${MARK}`);
  return result.replace(KEYED, `$1${MARK}`);
}

/** Redacted text truncated to `ProviderError.detail`'s byte limit on a code point boundary. */
export function toDetail(text: string, knownSecrets: readonly string[]): string {
  return truncateUtf8(redactSecrets(text, knownSecrets), MAX_DETAIL_BYTES, ELLIPSIS);
}
