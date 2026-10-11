import { err, ok, providerError } from '@autogeek/core';
import type { ProviderError, Result } from '@autogeek/core';
import type { z } from 'zod';
import { openStream, readText } from '../http/transport.ts';
import type { HttpRequest, TransportDeps } from '../http/transport.ts';

/** Listings are small; anything bigger is not a real vendor answer. */
export const MAX_JSON_BYTES = 4 * 1024 * 1024;

/** `JSON.parse` that returns undefined for malformed text instead of throwing. */
export function parseJsonOrUndefined(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * Sends `http` (GET, or POST with a body), reads the bounded JSON answer and validates it with
 * `schema`. A body that is not JSON or does not match is `invalid_response`.
 */
export async function requestJson<S extends z.ZodType>(
  http: HttpRequest,
  deps: TransportDeps,
  schema: S,
): Promise<Result<z.infer<S>, ProviderError>> {
  const opened = await openStream(http, deps);
  if (!opened.ok) return opened;
  const text = await readText(opened.value, http.providerId, MAX_JSON_BYTES);
  if (!text.ok) return text;
  const parsed = schema.safeParse(parseJsonOrUndefined(text.value));
  return parsed.success ? ok(parsed.data) : err(providerError('invalid_response', http.providerId));
}
