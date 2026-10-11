import type { Result } from '../result.ts';

/**
 * What protects the wrapped data key at rest.
 * - `os_keychain`: an OS-backed secret store (macOS Keychain, Windows DPAPI, libsecret/KWallet).
 * - `basic_text`: Chromium's plaintext fallback on Linux. Encryption under a hard-coded key, so
 *   it protects nothing; the vault refuses to store under it.
 * - `unavailable`: encryption cannot be used at all (for example, before the app is ready).
 */
export const CIPHER_BACKENDS = ['os_keychain', 'basic_text', 'unavailable'] as const;
export type CipherBackend = (typeof CIPHER_BACKENDS)[number];

/**
 * Wraps and unwraps the vault's 256-bit data key with an OS-protected secret. Injected so the
 * vault is testable without Electron; the production implementation adapts `safeStorage`.
 *
 * Implementations must never log or embed key material in errors, and must return (not throw)
 * when the OS refuses an operation.
 */
export interface SecretCipher {
  backend(): CipherBackend;
  wrap(key: Uint8Array): Result<Uint8Array, 'wrap_failed'>;
  unwrap(wrapped: Uint8Array): Result<Uint8Array, 'unwrap_failed'>;
}
