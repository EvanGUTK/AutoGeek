import { describe, expect, it } from 'vitest';
import { createCodeVerifier, createState, deriveCodeChallenge } from './pkce.ts';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe('deriveCodeChallenge', () => {
  it('matches the S256 example in RFC 7636 Appendix B', () => {
    expect(deriveCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('rejects a verifier outside the RFC 7636 length bounds', () => {
    expect(() => deriveCodeChallenge('a'.repeat(42))).toThrow(RangeError);
    expect(() => deriveCodeChallenge('a'.repeat(129))).toThrow(RangeError);
  });

  it('rejects a verifier with characters outside the unreserved set', () => {
    expect(() => deriveCodeChallenge(`${'a'.repeat(42)}+`)).toThrow(RangeError);
  });
});

describe('createCodeVerifier', () => {
  it('encodes 32 random bytes as 43 base64url characters', () => {
    const verifier = createCodeVerifier();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(BASE64URL);
  });

  it('is accepted by deriveCodeChallenge', () => {
    expect(deriveCodeChallenge(createCodeVerifier())).toMatch(BASE64URL);
  });

  it('never repeats across calls', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => createCodeVerifier()));
    expect(seen.size).toBe(1000);
  });
});

describe('createState', () => {
  it('encodes 32 random bytes as 43 base64url characters', () => {
    const state = createState();
    expect(state).toHaveLength(43);
    expect(state).toMatch(BASE64URL);
  });

  it('never repeats across calls', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => createState()));
    expect(seen.size).toBe(1000);
  });
});
