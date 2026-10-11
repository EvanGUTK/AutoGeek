import { describe, expect, it } from 'vitest';
import { isInsecureRemote, isLoopbackUrl } from './loopback.ts';

describe('isLoopbackUrl', () => {
  it.each([
    'http://127.0.0.1:1234',
    'http://127.255.0.9',
    'http://127.1',
    'http://0x7f.0.0.1',
    'http://2130706433',
    'http://localhost:8080/v1',
    'http://LOCALHOST',
    'http://localhost.:11434',
    'http://[::1]:1234',
    'http://[::ffff:127.0.0.1]',
    'http://[0:0:0:0:0:0:0:1]',
  ])('treats %s as loopback', (url) => {
    expect(isLoopbackUrl(new URL(url))).toBe(true);
  });

  it.each([
    'http://0.0.0.0:1234',
    'http://192.168.1.10',
    'http://128.0.0.1',
    'http://localhost.evil.example',
    'http://127.0.0.1.nip.io',
    'http://[::2]',
    'http://[::ffff:10.0.0.1]',
    'https://example.com',
    'http://xn--localhost-9za.example',
  ])('does not treat %s as loopback', (url) => {
    expect(isLoopbackUrl(new URL(url))).toBe(false);
  });
});

describe('isInsecureRemote', () => {
  it('flags plain http to a remote host only', () => {
    expect(isInsecureRemote(new URL('http://10.0.0.5:1234/v1'))).toBe(true);
    expect(isInsecureRemote(new URL('http://127.0.0.1:1234/v1'))).toBe(false);
    expect(isInsecureRemote(new URL('https://10.0.0.5/v1'))).toBe(false);
  });
});
