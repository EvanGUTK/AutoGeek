import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import type { SecretCipher } from './secret-cipher.ts';

/*
 * On-disk envelope, version 1:
 *
 *   magic "AGKV" (4) | version 0x01 (1) | wrapped-key length, u16 BE (2) | wrapped key (n)
 *   | IV (12) | GCM tag (16) | ciphertext (rest)
 *
 * The body is AES-256-GCM under a random data key; the data key is wrapped by the OS keychain via
 * `SecretCipher`. Everything before the IV is the additional authenticated data, so the version
 * and the wrapped key cannot be swapped without failing authentication. safeStorage alone is not
 * enough: on macOS and Linux Chromium encrypts with AES-CBC and no MAC, so tampering would not be
 * detected reliably.
 */
const MAGIC = Buffer.from('AGKV', 'latin1');
const VERSION = 1;
const HEADER_FIXED_LENGTH = MAGIC.length + 1 + 2;
const MAX_WRAPPED_KEY_LENGTH = 1024;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ALGORITHM = 'aes-256-gcm';

/** The vault's data key: raw for sealing (main process only), wrapped for the file header. */
export interface DataKey {
  readonly key: Uint8Array;
  readonly wrapped: Uint8Array;
}

export type BackendError = 'insecure_backend' | 'encryption_unavailable';
export type CreateDataKeyError = BackendError | 'wrap_failed';
export type OpenEnvelopeError =
  BackendError | 'malformed' | 'unsupported_version' | 'unwrap_failed' | 'auth_failed';

export interface OpenedEnvelope {
  readonly plaintext: Uint8Array;
  readonly dataKey: DataKey;
}

function checkBackend(cipher: SecretCipher): Result<void, BackendError> {
  switch (cipher.backend()) {
    case 'os_keychain':
      return ok(undefined);
    case 'basic_text':
      return err('insecure_backend');
    case 'unavailable':
      return err('encryption_unavailable');
  }
}

/** A fresh random data key, wrapped by the OS keychain. Refuses non-keychain backends. */
export function createDataKey(cipher: SecretCipher): Result<DataKey, CreateDataKeyError> {
  const backend = checkBackend(cipher);
  if (!backend.ok) return backend;
  const key = randomBytes(KEY_LENGTH);
  const wrapped = cipher.wrap(key);
  if (!wrapped.ok) return wrapped;
  if (wrapped.value.length === 0 || wrapped.value.length > MAX_WRAPPED_KEY_LENGTH) {
    return err('wrap_failed');
  }
  return ok({ key, wrapped: wrapped.value });
}

function header(wrapped: Uint8Array): Buffer {
  const fixed = Buffer.alloc(HEADER_FIXED_LENGTH);
  MAGIC.copy(fixed, 0);
  fixed.writeUInt8(VERSION, MAGIC.length);
  fixed.writeUInt16BE(wrapped.length, MAGIC.length + 1);
  return Buffer.concat([fixed, wrapped]);
}

/**
 * Seals `plaintext` under `dataKey`. The IV is drawn fresh from the CSPRNG on every call and is not
 * a parameter, so no caller can reuse one. With random 96-bit IVs a key stays well within NIST
 * SP 800-38D's 2^32-invocation bound for any realistic number of vault writes.
 */
export function sealEnvelope(plaintext: Uint8Array, dataKey: DataKey): Uint8Array {
  if (dataKey.key.length !== KEY_LENGTH) {
    throw new RangeError('data key must be 32 bytes');
  }
  const aad = header(dataKey.wrapped);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, dataKey.key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([aad, iv, cipher.getAuthTag(), body]);
}

interface ParsedEnvelope {
  readonly aad: Buffer;
  readonly wrapped: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly body: Buffer;
}

function parse(blob: Buffer): Result<ParsedEnvelope, 'malformed' | 'unsupported_version'> {
  if (blob.length < HEADER_FIXED_LENGTH || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    return err('malformed');
  }
  if (blob.readUInt8(MAGIC.length) !== VERSION) return err('unsupported_version');
  const wrappedLength = blob.readUInt16BE(MAGIC.length + 1);
  const ivStart = HEADER_FIXED_LENGTH + wrappedLength;
  const bodyStart = ivStart + IV_LENGTH + TAG_LENGTH;
  if (wrappedLength === 0 || wrappedLength > MAX_WRAPPED_KEY_LENGTH || blob.length < bodyStart) {
    return err('malformed');
  }
  return ok({
    aad: blob.subarray(0, ivStart),
    wrapped: blob.subarray(HEADER_FIXED_LENGTH, ivStart),
    iv: blob.subarray(ivStart, ivStart + IV_LENGTH),
    tag: blob.subarray(ivStart + IV_LENGTH, bodyStart),
    body: blob.subarray(bodyStart),
  });
}

function decrypt(parsed: ParsedEnvelope, key: Uint8Array): Result<Uint8Array, 'auth_failed'> {
  const decipher = createDecipheriv(ALGORITHM, key, parsed.iv, { authTagLength: TAG_LENGTH });
  decipher.setAAD(parsed.aad);
  decipher.setAuthTag(parsed.tag);
  const update = decipher.update(parsed.body);
  try {
    return ok(Buffer.concat([update, decipher.final()]));
  } catch (thrown) {
    // node:crypto signals a failed GCM tag check only by throwing from final().
    if (!(thrown instanceof Error)) throw thrown;
    return err('auth_failed');
  }
}

/**
 * Opens a sealed envelope. Every failure is a typed error and fails closed: no partial plaintext
 * is ever returned. Refuses non-keychain backends even when the blob would decrypt.
 */
export function openEnvelope(
  blob: Uint8Array,
  cipher: SecretCipher,
): Result<OpenedEnvelope, OpenEnvelopeError> {
  const backend = checkBackend(cipher);
  if (!backend.ok) return backend;
  const parsed = parse(Buffer.from(blob));
  if (!parsed.ok) return parsed;
  const unwrapped = cipher.unwrap(parsed.value.wrapped);
  if (!unwrapped.ok) return unwrapped;
  if (unwrapped.value.length !== KEY_LENGTH) return err('unwrap_failed');
  const plaintext = decrypt(parsed.value, unwrapped.value);
  if (!plaintext.ok) return plaintext;
  return ok({
    plaintext: plaintext.value,
    dataKey: { key: unwrapped.value, wrapped: Buffer.from(parsed.value.wrapped) },
  });
}
