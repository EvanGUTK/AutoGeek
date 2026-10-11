import { format, inspect } from 'node:util';
import { serialize } from 'node:v8';
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_KINDS,
  CredentialRefSchema,
  createResolvedCredential,
  isResolvedCredential,
} from './credentials.ts';
import type { ResolvedCredentialInput } from './credentials.ts';

const SECRET = 'sk-ant-api03-SPEC-SECRET-0123456789abcdef';
const BASE = 'https://api.anthropic.com/';

const input = (overrides: Partial<ResolvedCredentialInput> = {}): ResolvedCredentialInput => ({
  credentialId: 'cred_test',
  providerId: 'anthropic',
  kind: 'api_key',
  secret: SECRET,
  baseUrl: BASE,
  ...overrides,
});
const make = () => createResolvedCredential(input());

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (thrown) {
    return thrown;
  }
  return undefined;
}

describe('CREDENTIAL_KINDS', () => {
  it('is exactly api_key, oauth_pkce and none', () => {
    expect(CREDENTIAL_KINDS).toEqual(['api_key', 'oauth_pkce', 'none']);
  });
});

describe('CredentialRefSchema', () => {
  const ref = {
    id: 'cred_AbCdEfGhIjKlMnOpQrStUv',
    label: 'Work key',
    providerId: 'openai_compatible',
    kind: 'api_key',
    baseUrl: 'http://127.0.0.1:11434/v1',
    createdAt: '2026-10-11T12:00:00.000Z',
    monthlyCapUsdMicros: 5_000_000,
  };

  it('accepts a full ref and a minimal one', () => {
    expect(CredentialRefSchema.parse(ref)).toEqual(ref);
    const minimal = {
      id: ref.id,
      label: ref.label,
      providerId: 'ollama',
      kind: 'none',
      createdAt: ref.createdAt,
    };
    expect(CredentialRefSchema.safeParse(minimal).success).toBe(true);
  });

  it.each([
    ['an extra field (a secret riding along)', { secret: SECRET }],
    ['a malformed id', { id: 'cred_short' }],
    ['an id with another prefix', { id: 'key_AbCdEfGhIjKlMnOpQrStUv' }],
    ['an empty label', { label: '' }],
    ['a label over 100 characters', { label: 'x'.repeat(101) }],
    ['a label with a control character', { label: 'Work\u0000key' }],
    ['a label with a bidi override', { label: 'Work‮key' }],
    ['an unknown kind', { kind: 'subscription' }],
    ['an uppercase provider id', { providerId: 'OpenAI' }],
    ['a non-ISO createdAt', { createdAt: 'yesterday' }],
    ['a negative cap', { monthlyCapUsdMicros: -1 }],
    ['a fractional cap', { monthlyCapUsdMicros: 1.5 }],
    ['a baseUrl with credentials', { baseUrl: 'https://user:pw@host/v1' }],
    ['a baseUrl with a query', { baseUrl: 'https://host/v1?key=abc' }],
    ['a baseUrl with a fragment', { baseUrl: 'https://host/v1#x' }],
    ['a non-http baseUrl', { baseUrl: 'file:///etc/passwd' }],
    ['a non-canonical baseUrl (unicode host)', { baseUrl: 'https://bücher.de/v1' }],
    ['a non-canonical baseUrl (uppercase host)', { baseUrl: 'https://HOST/v1' }],
    ['an unparseable baseUrl', { baseUrl: 'not a url' }],
  ])('rejects %s', (_name, change) => {
    expect(CredentialRefSchema.safeParse({ ...ref, ...change }).success).toBe(false);
  });
});

describe('createResolvedCredential', () => {
  it('reveals the secret only through reveal()', () => {
    expect(make().reveal()).toBe(SECRET);
  });

  it('exposes the non-secret fields', () => {
    const credential = make();
    expect([
      credential.credentialId,
      credential.providerId,
      credential.kind,
      credential.baseUrl,
    ]).toEqual(['cred_test', 'anthropic', 'api_key', BASE]);
  });

  it('is frozen', () => {
    const credential = make();
    expect(Object.isFrozen(credential)).toBe(true);
    expect(() => {
      Object.defineProperty(credential, 'baseUrl', { value: 'https://evil.example/' });
    }).toThrow(TypeError);
  });

  it('has no own property whose value is the secret', () => {
    const credential = make();
    const values = Reflect.ownKeys(credential).map((key): unknown => Reflect.get(credential, key));
    expect(values).not.toContain(SECRET);
  });

  it.each([
    [
      'structuredClone',
      (c: unknown) => {
        structuredClone(c);
      },
    ],
    [
      'v8.serialize',
      (c: unknown) => {
        serialize(c);
      },
    ],
    [
      'MessagePort.postMessage',
      (c: unknown) => {
        const { port1, port2 } = new MessageChannel();
        try {
          port1.postMessage(c);
        } finally {
          port1.close();
          port2.close();
        }
      },
    ],
    ['JSON.stringify', (c: unknown) => JSON.stringify(c)],
    ['JSON.stringify nested', (c: unknown) => JSON.stringify({ a: [c] })],
    [
      'copy then structuredClone',
      (c: unknown) => {
        structuredClone(Object.assign({}, c));
      },
    ],
  ])('%s throws, without the secret in the error', (_name, run) => {
    const thrown = thrownBy(() => {
      run(make());
    });
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(SECRET);
    expect(inspect(thrown)).not.toContain(SECRET);
  });

  it.each([
    ['String()', (c: unknown) => String(c)],
    ['util.inspect', (c: unknown) => inspect(c)],
    ['util.inspect nested', (c: unknown) => inspect({ a: { b: { c } } }, { depth: 20 })],
    ['util.inspect showHidden', (c: unknown) => inspect(c, { showHidden: true })],
    ['util.format %s', (c: unknown) => format('%s', c)],
    ['util.format %o', (c: unknown) => format('%o', c)],
    ['util.format %O', (c: unknown) => format('%O', c)],
    ['error cause', (c: unknown) => inspect(new Error('x', { cause: c }))],
  ])('%s prints a redacted placeholder', (_name, render) => {
    const out = render(make());
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[ResolvedCredential redacted]');
  });

  it.each(['default', 'string', 'number'])(
    'Symbol.toPrimitive with hint %s (template literals, concatenation) is redacted',
    (hint) => {
      const toPrimitive: unknown = Reflect.get(make(), Symbol.toPrimitive);
      expect(typeof toPrimitive === 'function' && Reflect.apply(toPrimitive, make(), [hint])).toBe(
        '[ResolvedCredential redacted]',
      );
    },
  );

  it('kind none has no secret, and reveal() throws a programmer error', () => {
    const credential = createResolvedCredential(
      input({
        providerId: 'ollama',
        kind: 'none',
        secret: undefined,
        baseUrl: 'http://127.0.0.1:11434/',
      }),
    );
    expect(() => credential.reveal()).toThrow(TypeError);
  });

  it.each([
    ['an empty secret for api_key', input({ secret: '' })],
    ['a missing secret for oauth_pkce', input({ kind: 'oauth_pkce', secret: undefined })],
    ['a secret for kind none', input({ kind: 'none' })],
    ['an empty credential id', input({ credentialId: '' })],
    ['an empty provider id', input({ providerId: '' })],
    ['an unknown kind', Object.assign(input(), { kind: 'subscription' })],
    ['a baseUrl with credentials', input({ baseUrl: 'https://u:p@api.example.com/' })],
    ['a non-http baseUrl', input({ baseUrl: 'ftp://api.example.com/' })],
    ['an unparseable baseUrl', input({ baseUrl: 'nope' })],
  ])('rejects %s without leaking the secret', (_name, bad) => {
    const thrown = thrownBy(() => createResolvedCredential(bad));
    expect(thrown).toBeInstanceOf(TypeError);
    expect(inspect(thrown)).not.toContain(SECRET);
  });
});

describe('isResolvedCredential', () => {
  it('accepts a factory-made credential', () => {
    expect(isResolvedCredential(make())).toBe(true);
  });

  it('rejects look-alikes, including a spread copy carrying every own property', () => {
    const credential = make();
    expect(isResolvedCredential({ ...credential })).toBe(false);
    expect(isResolvedCredential(Object.create(credential))).toBe(false);
    expect(
      isResolvedCredential({
        credentialId: 'c',
        providerId: 'p',
        kind: 'api_key',
        baseUrl: BASE,
        reveal: () => 'x',
      }),
    ).toBe(false);
    expect(isResolvedCredential(null)).toBe(false);
    expect(isResolvedCredential('cred')).toBe(false);
  });
});
