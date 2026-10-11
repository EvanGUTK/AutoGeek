import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import { createDataKey, openEnvelope, sealEnvelope } from './envelope.ts';
import type { DataKey } from './envelope.ts';
import type { CipherBackend, SecretCipher } from './secret-cipher.ts';

/** Stands in for safeStorage: a real AES-GCM wrap under a per-instance master key. */
function fakeCipher(backend: CipherBackend = 'os_keychain'): SecretCipher {
  const master = randomBytes(32);
  return {
    backend: () => backend,
    wrap(key: Uint8Array): Result<Uint8Array, 'wrap_failed'> {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', master, iv);
      const body = Buffer.concat([c.update(key), c.final()]);
      return ok(Buffer.concat([iv, c.getAuthTag(), body]));
    },
    unwrap(wrapped: Uint8Array): Result<Uint8Array, 'unwrap_failed'> {
      const buf = Buffer.from(wrapped);
      try {
        const d = createDecipheriv('aes-256-gcm', master, buf.subarray(0, 12), {
          authTagLength: 16,
        });
        d.setAuthTag(buf.subarray(12, 28));
        return ok(Buffer.concat([d.update(buf.subarray(28)), d.final()]));
      } catch (thrown) {
        if (!(thrown instanceof Error)) throw thrown;
        return err('unwrap_failed');
      }
    },
  };
}

function newKey(cipher: SecretCipher): DataKey {
  const created = createDataKey(cipher);
  if (!created.ok) throw new Error(`createDataKey failed: ${created.error}`);
  return created.value;
}

const PLAINTEXT = Buffer.from('{"credentials":[{"secret":"sk-ant-api03-EXAMPLE"}]}', 'utf8');

// Layout constants mirrored from the format spec so the tests pin the on-disk format.
const HEADER_FIXED = 4 + 1 + 2; // magic, version, wrapped-key length
const IV_LENGTH = 12;

function ivOf(blob: Uint8Array): string {
  const wrappedLength = Buffer.from(blob).readUInt16BE(5);
  const start = HEADER_FIXED + wrappedLength;
  return Buffer.from(blob.subarray(start, start + IV_LENGTH)).toString('hex');
}

describe('envelope', () => {
  it('round-trips plaintext and returns the data key for later writes', () => {
    const cipher = fakeCipher();
    const key = newKey(cipher);
    const opened = openEnvelope(sealEnvelope(PLAINTEXT, key), cipher);
    expect(opened.ok && Buffer.from(opened.value.plaintext).equals(PLAINTEXT)).toBe(true);
    expect(opened.ok && Buffer.from(opened.value.dataKey.wrapped).equals(key.wrapped)).toBe(true);
  });

  it('round-trips an empty plaintext', () => {
    const cipher = fakeCipher();
    const opened = openEnvelope(sealEnvelope(Buffer.alloc(0), newKey(cipher)), cipher);
    expect(opened.ok && opened.value.plaintext.length === 0).toBe(true);
  });

  it('starts with the magic and version 1', () => {
    const blob = sealEnvelope(PLAINTEXT, newKey(fakeCipher()));
    expect(Buffer.from(blob.subarray(0, 5)).toString('hex')).toBe('41474b5601');
  });

  it('does not contain the plaintext', () => {
    const blob = Buffer.from(sealEnvelope(PLAINTEXT, newKey(fakeCipher())));
    expect(blob.includes(Buffer.from('sk-ant-api03-EXAMPLE'))).toBe(false);
  });

  it('uses a fresh IV on every seal with the same key and plaintext', () => {
    const key = newKey(fakeCipher());
    const ivs = new Set(Array.from({ length: 2000 }, () => ivOf(sealEnvelope(PLAINTEXT, key))));
    expect(ivs.size).toBe(2000);
  });

  it('fails closed when any single bit of the blob is flipped', () => {
    const cipher = fakeCipher();
    const blob = Buffer.from(sealEnvelope(Buffer.from('small'), newKey(cipher)));
    for (let index = 0; index < blob.length; index += 1) {
      for (const mask of [0x01, 0x80]) {
        const tampered = Buffer.from(blob);
        tampered.writeUInt8((tampered.readUInt8(index) ^ mask) & 0xff, index);
        expect(
          openEnvelope(tampered, cipher).ok,
          `byte ${String(index)} mask ${String(mask)}`,
        ).toBe(false);
      }
    }
  });

  it('fails closed on every truncation', () => {
    const cipher = fakeCipher();
    const blob = sealEnvelope(Buffer.from('small'), newKey(cipher));
    for (let length = 0; length < blob.length; length += 1) {
      expect(openEnvelope(blob.subarray(0, length), cipher).ok, `length ${String(length)}`).toBe(
        false,
      );
    }
  });

  it('fails closed on trailing bytes', () => {
    const cipher = fakeCipher();
    const blob = sealEnvelope(PLAINTEXT, newKey(cipher));
    expect(openEnvelope(Buffer.concat([blob, Buffer.from([0])]), cipher)).toEqual(
      err('auth_failed'),
    );
  });

  it('reports a bad magic as malformed', () => {
    const cipher = fakeCipher();
    const blob = Buffer.from(sealEnvelope(PLAINTEXT, newKey(cipher)));
    blob.write('XXXX', 0, 'latin1');
    expect(openEnvelope(blob, cipher)).toEqual(err('malformed'));
  });

  it('reports an unknown version as unsupported_version', () => {
    const cipher = fakeCipher();
    const blob = Buffer.from(sealEnvelope(PLAINTEXT, newKey(cipher)));
    blob.writeUInt8(2, 4);
    expect(openEnvelope(blob, cipher)).toEqual(err('unsupported_version'));
  });

  it('reports a zero wrapped-key length as malformed', () => {
    const cipher = fakeCipher();
    const blob = Buffer.from(sealEnvelope(PLAINTEXT, newKey(cipher)));
    blob.writeUInt16BE(0, 5);
    expect(openEnvelope(blob, cipher)).toEqual(err('malformed'));
  });

  it('cannot be opened under a different master key', () => {
    const blob = sealEnvelope(PLAINTEXT, newKey(fakeCipher()));
    expect(openEnvelope(blob, fakeCipher())).toEqual(err('unwrap_failed'));
  });

  it('binds the wrapped key into the authenticated data', () => {
    // Re-wrap the SAME data key (wrapping is randomized): unwrap still yields the right key, so
    // only the AAD can detect that the header changed.
    const cipher = fakeCipher();
    const key = newKey(cipher);
    const blob = Buffer.from(sealEnvelope(PLAINTEXT, key));
    const rewrapped = cipher.wrap(key.key);
    if (!rewrapped.ok) throw new Error('wrap failed');
    expect(Buffer.from(rewrapped.value).equals(key.wrapped)).toBe(false);
    expect(rewrapped.value.length).toBe(blob.readUInt16BE(5));
    Buffer.from(rewrapped.value).copy(blob, HEADER_FIXED);
    expect(openEnvelope(blob, cipher)).toEqual(err('auth_failed'));
  });

  it('fails closed when a different validly wrapped key is swapped in', () => {
    const cipher = fakeCipher();
    const blob = Buffer.from(sealEnvelope(PLAINTEXT, newKey(cipher)));
    Buffer.from(newKey(cipher).wrapped).copy(blob, HEADER_FIXED);
    expect(openEnvelope(blob, cipher)).toEqual(err('auth_failed'));
  });

  it('rejects an unwrapped key that is not 32 bytes', () => {
    const cipher = fakeCipher();
    const shortKey: SecretCipher = { ...cipher, unwrap: () => ok(randomBytes(16)) };
    const blob = sealEnvelope(PLAINTEXT, newKey(cipher));
    expect(openEnvelope(blob, shortKey)).toEqual(err('unwrap_failed'));
  });

  describe('backend gate', () => {
    it.each([
      ['basic_text', 'insecure_backend'],
      ['unavailable', 'encryption_unavailable'],
    ] as const)('refuses to create a key on %s', (backend, expected) => {
      expect(createDataKey(fakeCipher(backend))).toEqual(err(expected));
    });

    it.each([
      ['basic_text', 'insecure_backend'],
      ['unavailable', 'encryption_unavailable'],
    ] as const)('refuses to open on %s even with a valid blob', (backend, expected) => {
      const good = fakeCipher();
      const blob = sealEnvelope(PLAINTEXT, newKey(good));
      expect(openEnvelope(blob, { ...good, backend: () => backend })).toEqual(err(expected));
    });

    it('surfaces a wrap failure', () => {
      const failing: SecretCipher = { ...fakeCipher(), wrap: () => err('wrap_failed') };
      expect(createDataKey(failing)).toEqual(err('wrap_failed'));
    });
  });
});
