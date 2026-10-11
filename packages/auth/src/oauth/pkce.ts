import { createHash, randomBytes } from 'node:crypto';

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/** 32 bytes = 256 bits of entropy, the size RFC 7636 §4.1 recommends. */
const RANDOM_BYTES = 32;

/** A fresh PKCE `code_verifier`: 32 random bytes, base64url without padding (43 chars). */
export function createCodeVerifier(): string {
  return randomBytes(RANDOM_BYTES).toString('base64url');
}

/** A fresh OAuth `state` value, unguessable by anyone who did not start the flow. */
export function createState(): string {
  return randomBytes(RANDOM_BYTES).toString('base64url');
}

/**
 * The S256 `code_challenge` for `verifier` (RFC 7636 §4.2). Only S256 exists in this engine:
 * `plain` would put the verifier itself in the browser URL.
 *
 * Throws RangeError for a malformed verifier, which can only come from a programmer error since
 * verifiers are produced by `createCodeVerifier`.
 */
export function deriveCodeChallenge(verifier: string): string {
  if (!VERIFIER_PATTERN.test(verifier)) {
    throw new RangeError('code_verifier must be 43-128 unreserved characters');
  }
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}
