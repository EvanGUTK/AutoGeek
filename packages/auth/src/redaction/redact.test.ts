import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { REDACTED, createSecretRegistry, redactText, redactValue } from './redact.ts';

const hex = (n: number) => 'a1b2c3d4e5f60789'.repeat(Math.ceil(n / 16)).slice(0, n);
const alnum = (n: number) => 'Zq9xY8wV7uT6sR5p'.repeat(Math.ceil(n / 16)).slice(0, n);

/** Realistic shapes. Each `marker` is a fragment that must never survive redaction. */
const SHAPES = [
  ['anthropic', `sk-ant-api03-${alnum(86)}-${alnum(6)}AA`],
  ['openai project', `sk-proj-${alnum(48)}_${alnum(20)}`],
  ['openai legacy', `sk-${alnum(48)}`],
  ['openai service account', `sk-svcacct-${alnum(40)}`],
  ['openrouter', `sk-or-v1-${hex(64)}`],
  ['google api key', `AIza${alnum(35)}`],
  ['google access token', `ya29.${alnum(60)}`],
  ['google refresh token', `1//${alnum(40)}`],
  ['jwt', `eyJ${alnum(20)}.eyJ${alnum(30)}.${alnum(43)}`],
] as const;

const empty = createSecretRegistry();

describe('redactText', () => {
  it.each(SHAPES)('redacts a bare %s key', (_name, key) => {
    const out = redactText(`using key ${key} now`, empty);
    expect(out).not.toContain(key.slice(8, 24));
    expect(out).toContain(REDACTED);
    expect(out.startsWith('using key ')).toBe(true);
  });

  it.each(SHAPES)('redacts a %s key inside JSON, URLs and headers', (_name, key) => {
    const samples = [
      JSON.stringify({ apiKey: key }),
      `https://example.com/v1?key=${key}&x=1`,
      `Authorization: Bearer ${key}`,
      `x-api-key: ${key}`,
      `"${key}"`,
    ];
    for (const sample of samples) {
      expect(redactText(sample, empty)).not.toContain(key.slice(8, 24));
    }
  });

  it('redacts Bearer tokens and sensitive key/value pairs of unknown shape', () => {
    const out = redactText(
      'Authorization: Bearer opaque-token-value; x-goog-api-key=whatever123 refresh_token="r3fr3sh" client_secret: s3cr3t code_verifier=v3r1f13r',
      empty,
    );
    for (const fragment of ['opaque-token-value', 'whatever123', 'r3fr3sh', 's3cr3t', 'v3r1f13r']) {
      expect(out).not.toContain(fragment);
    }
    expect(out).toContain('Authorization: Bearer ');
  });

  it('redacts registered secrets of any shape, longest first', () => {
    const registry = createSecretRegistry();
    registry.add('local');
    registry.add('local-ollama-token');
    expect(redactText('using local-ollama-token and local', registry)).toBe(
      `using ${REDACTED} and ${REDACTED}`,
    );
  });

  it('redacts every occurrence of a registered secret', () => {
    const registry = createSecretRegistry();
    registry.add('repeat-me-123');
    expect(redactText('repeat-me-123/repeat-me-123', registry)).toBe(`${REDACTED}/${REDACTED}`);
  });

  it('redacts a Basic authorization header and a bare authorization value', () => {
    for (const sample of [
      'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      'authorization=opaqueValue42',
    ]) {
      const out = redactText(sample, empty);
      expect(out).not.toContain('dXNlcjpwYXNzd29yZA');
      expect(out).not.toContain('opaqueValue42');
    }
  });

  it('redacts a Bearer token outside any header', () => {
    expect(redactText('retrying with Bearer opaque-123', empty)).toBe(
      `retrying with Bearer ${REDACTED}`,
    );
  });

  it('stops redacting a secret once it is removed', () => {
    const registry = createSecretRegistry();
    registry.add('my-custom-key-xyz');
    registry.remove('my-custom-key-xyz');
    expect(redactText('my-custom-key-xyz', registry)).toBe('my-custom-key-xyz');
  });

  it('keeps a secret registered until every add is matched by a remove', () => {
    const registry = createSecretRegistry();
    registry.add('shared-secret-1');
    registry.add('shared-secret-1');
    registry.remove('shared-secret-1');
    expect(redactText('shared-secret-1', registry)).toBe(REDACTED);
  });

  it('ignores the empty string', () => {
    const registry = createSecretRegistry();
    registry.add('');
    expect(redactText('plain text', registry)).toBe('plain text');
  });

  it('treats registered secrets with regex metacharacters literally', () => {
    const registry = createSecretRegistry();
    registry.add('a.b*c(d)');
    expect(redactText('xa.b*c(d)y aXbbbcd', registry)).toBe(`x${REDACTED}y aXbbbcd`);
  });

  it('leaves ordinary text alone', () => {
    const text = 'Opened /Users/me/project in 12ms; model claude-opus-5-5 returned 200';
    expect(redactText(text, empty)).toBe(text);
  });
});

describe('redactValue', () => {
  const key = SHAPES[0][1];

  it('walks nested objects and arrays', () => {
    const out = redactValue({ a: [{ b: `x ${key}` }], n: 3, ok: true, nil: null }, empty);
    expect(JSON.stringify(out)).not.toContain(key.slice(8, 24));
    expect(out).toMatchObject({ n: 3, ok: true, nil: null });
  });

  it('replaces the whole value under a sensitive field name', () => {
    const out = redactValue(
      {
        secret: 'short',
        apiKey: 'k',
        password: 'p',
        authorization: 'a',
        accessToken: 't',
        label: 'Work',
      },
      empty,
    );
    expect(out).toEqual({
      secret: REDACTED,
      apiKey: REDACTED,
      password: REDACTED,
      authorization: REDACTED,
      accessToken: REDACTED,
      label: 'Work',
    });
  });

  it('redacts errors including message, stack and cause chain', () => {
    const error = new Error(`request failed for ${key}`, {
      cause: new Error(`inner ${key}`),
    });
    const out = JSON.stringify(redactValue(error, empty));
    expect(out).not.toContain(key.slice(8, 24));
    expect(out).toContain('request failed for');
  });

  it('never emits binary contents', () => {
    expect(redactValue({ key: Buffer.from(key) }, empty)).toEqual({ key: REDACTED });
    expect(redactValue({ blob: new Uint8Array(32) }, empty)).toEqual({ blob: '[binary 32 bytes]' });
  });

  it('handles cycles and depth without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(redactValue(cyclic, empty)).toEqual({ name: 'loop', self: '[circular]' });
    let deep: Record<string, unknown> = { leaf: key };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    expect(JSON.stringify(redactValue(deep, empty))).not.toContain(key.slice(8, 24));
  });

  it('renders an object shared by two branches in both places', () => {
    const shared = { model: 'm1' };
    expect(redactValue({ a: shared, b: shared }, empty)).toEqual({
      a: { model: 'm1' },
      b: { model: 'm1' },
    });
  });

  it('summarizes values it cannot walk without stringifying them', () => {
    const out = redactValue({ fn: () => key, sym: Symbol(key), map: new Map([[1, key]]) }, empty);
    expect(inspect(out)).not.toContain(key.slice(8, 24));
  });
});
