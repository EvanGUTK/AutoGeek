import { describe, expect, it } from 'vitest';
import { checkCredential, endpoint } from './credential.ts';
import type { ProviderCredential } from './credential.ts';

function credential(overrides: Partial<ProviderCredential> = {}): ProviderCredential {
  return {
    credentialId: 'cred_1',
    providerId: 'anthropic',
    kind: 'api_key',
    baseUrl: 'https://api.anthropic.com',
    reveal: () => 'sk-ant-api03-x',
    ...overrides,
  };
}

const ANTHROPIC = {
  providerId: 'anthropic',
  kinds: ['api_key'],
  fixedOrigin: 'https://api.anthropic.com',
} as const;

describe('checkCredential', () => {
  it('accepts a matching credential and returns its parsed base URL', () => {
    const result = checkCredential(
      credential({ baseUrl: 'https://api.anthropic.com/' }),
      ANTHROPIC,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.href).toBe('https://api.anthropic.com/');
  });

  it.each([
    ['another provider', { providerId: 'openai' }],
    ['an unaccepted kind', { kind: 'none' as const }],
    ['another origin', { baseUrl: 'https://evil.example' }],
    ['plain http to the fixed host', { baseUrl: 'http://api.anthropic.com' }],
    ['another port', { baseUrl: 'https://api.anthropic.com:8443' }],
    ['userinfo', { baseUrl: 'https://user:pw@api.anthropic.com' }],
    ['an unparseable URL', { baseUrl: 'not a url' }],
    ['a non-http scheme', { baseUrl: 'file:///etc/passwd' }],
  ])('rejects %s as credential_mismatch without calling reveal()', (_label, overrides) => {
    let revealed = false;
    const result = checkCredential(
      credential({
        ...overrides,
        reveal: () => {
          revealed = true;
          return 'x';
        },
      }),
      ANTHROPIC,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'credential_mismatch', providerId: 'anthropic' },
    });
    expect(revealed).toBe(false);
  });

  it('lets editable providers use any http(s) base URL with a path', () => {
    const result = checkCredential(
      credential({ providerId: 'ollama', kind: 'none', baseUrl: 'http://127.0.0.1:11434/' }),
      { providerId: 'ollama', kinds: ['none'] },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a query or fragment on an editable base URL', () => {
    for (const baseUrl of ['http://127.0.0.1:1234/v1?x=1', 'http://127.0.0.1:1234/v1#f']) {
      expect(
        checkCredential(credential({ providerId: 'lmstudio', kind: 'none', baseUrl }), {
          providerId: 'lmstudio',
          kinds: ['none'],
        }).ok,
      ).toBe(false);
    }
  });
});

describe('endpoint', () => {
  it('appends the suffix to the origin and any path prefix', () => {
    expect(endpoint(new URL('https://api.anthropic.com'), 'v1/messages')).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(endpoint(new URL('http://127.0.0.1:1234/v1/'), '/chat/completions')).toBe(
      'http://127.0.0.1:1234/v1/chat/completions',
    );
  });
});
