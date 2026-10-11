import { describe, expect, it } from 'vitest';
import { MAX_DETAIL_BYTES, redactSecrets, toDetail } from './redact.ts';

describe('redactSecrets', () => {
  it.each([
    ['sk-ant-api03-AbCdEf0123456789_xyz', 'key sk-ant-api03-AbCdEf0123456789_xyz expired'],
    ['sk-proj-AbCdEf0123456789', 'Incorrect API key provided: sk-proj-AbCdEf0123456789.'],
    ['sk-or-v1-0123456789abcdef', '{"error":"sk-or-v1-0123456789abcdef"}'],
    ['AIzaSyA-0123456789abcdefghijklmnopqrstu', 'key=AIzaSyA-0123456789abcdefghijklmnopqrstu'],
    [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
    ],
  ])('removes the vendor key %s', (secret, text) => {
    const redacted = redactSecrets(text, []);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain('[REDACTED]');
  });

  it('removes bearer tokens and keyed secret fields but keeps the field name', () => {
    const text =
      'Authorization: Bearer abc.def-ghi {"api_key": "plain123", "x-api-key":"zzz", token=t0k}';
    const redacted = redactSecrets(text, []);
    for (const secret of ['abc.def-ghi', 'plain123', 'zzz', 't0k']) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('api_key');
    expect(redacted).toContain('Authorization');
  });

  it('removes every occurrence of a known secret, whatever its shape', () => {
    expect(redactSecrets('a lmstudio-local-key b lmstudio-local-key', ['lmstudio-local-key'])).toBe(
      'a [REDACTED] b [REDACTED]',
    );
  });

  it('ignores empty known secrets', () => {
    expect(redactSecrets('unchanged', [''])).toBe('unchanged');
  });

  it('leaves ordinary error text alone', () => {
    const text = 'messages.3.content: Input should be a valid list (request_id req_011CX)';
    expect(redactSecrets(text, [])).toBe(text);
  });
});

describe('toDetail', () => {
  it('redacts and truncates to at most 2 KiB on a character boundary', () => {
    const detail = toDetail('🙂'.repeat(1000) + ' sk-ant-api03-AbCdEf0123456789', []);
    expect(new TextEncoder().encode(detail).length).toBeLessThanOrEqual(MAX_DETAIL_BYTES);
    expect(detail).not.toContain('�');
    expect(detail.endsWith('…')).toBe(true);
  });

  it('redacts before truncating, so a secret cut at the limit cannot leak a prefix', () => {
    const secret = 'sk-ant-api03-' + 'A'.repeat(64);
    const text = 'x'.repeat(MAX_DETAIL_BYTES - 20) + secret;
    expect(toDetail(text, [])).not.toContain('sk-ant-api03-AAAA');
  });

  it('keeps short text intact', () => {
    expect(toDetail('overloaded_error', [])).toBe('overloaded_error');
  });
});
