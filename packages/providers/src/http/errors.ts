import type { ProviderErrorKind } from '@autogeek/core';

/**
 * Default HTTP status mapping. Adapters refine it from the vendor error body (context length,
 * insufficient quota on a 429, an overloaded error type on a 500, ...). 409 is `unknown`, so it is
 * retried only when the vendor says so with `x-should-retry: true`.
 */
export function kindForStatus(status: number): ProviderErrorKind {
  switch (status) {
    case 400:
    case 413:
    case 422:
      return 'invalid_request';
    case 401:
      return 'auth';
    case 402:
      return 'quota';
    case 403:
      return 'permission';
    case 404:
      return 'not_found';
    case 408:
      return 'timeout';
    case 429:
      return 'rate_limit';
    case 503:
    case 529:
      return 'overloaded';
    default:
      if (status >= 500 && status <= 599) return 'server';
      if (status < 400) return 'invalid_response';
      return 'unknown';
  }
}

const REQUEST_ID_HEADERS = ['request-id', 'x-request-id'] as const;
// Matches the IPC projection rule, so an id is either safe everywhere or absent.
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function readRequestId(headers: Headers): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value !== undefined && REQUEST_ID.test(value)) return value;
  }
  return undefined;
}

/** `x-should-retry` (Anthropic, OpenAI): the server's explicit retry verdict, when present. */
export function readShouldRetry(headers: Headers): boolean | undefined {
  const value = headers.get('x-should-retry')?.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}
