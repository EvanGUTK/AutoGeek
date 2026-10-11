import { describe, expect, it } from 'vitest';
import { kindForStatus, readRequestId, readShouldRetry } from './errors.ts';

describe('kindForStatus', () => {
  it.each([
    [400, 'invalid_request'],
    [401, 'auth'],
    [402, 'quota'],
    [403, 'permission'],
    [404, 'not_found'],
    [408, 'timeout'],
    [409, 'unknown'],
    [413, 'invalid_request'],
    [422, 'invalid_request'],
    [429, 'rate_limit'],
    [500, 'server'],
    [502, 'server'],
    [503, 'overloaded'],
    [504, 'server'],
    [529, 'overloaded'],
    [418, 'unknown'],
    [302, 'invalid_response'],
    [200, 'invalid_response'],
  ] as const)('maps %i to %s', (status, kind) => {
    expect(kindForStatus(status)).toBe(kind);
  });
});

describe('readRequestId', () => {
  it('reads the first vendor request id header present', () => {
    expect(readRequestId(new Headers({ 'request-id': 'req_011CX' }))).toBe('req_011CX');
    expect(readRequestId(new Headers({ 'x-request-id': 'abc-123:4.5' }))).toBe('abc-123:4.5');
  });

  it('drops ids that are too long or contain unexpected characters', () => {
    expect(readRequestId(new Headers({ 'request-id': 'a'.repeat(129) }))).toBeUndefined();
    expect(readRequestId(new Headers({ 'request-id': 'id with spaces' }))).toBeUndefined();
    expect(readRequestId(new Headers({ 'request-id': '<script>' }))).toBeUndefined();
    expect(readRequestId(new Headers())).toBeUndefined();
  });
});

describe('readShouldRetry', () => {
  it('reads x-should-retry', () => {
    expect(readShouldRetry(new Headers({ 'x-should-retry': 'true' }))).toBe(true);
    expect(readShouldRetry(new Headers({ 'x-should-retry': 'FALSE' }))).toBe(false);
    expect(readShouldRetry(new Headers({ 'x-should-retry': 'maybe' }))).toBeUndefined();
    expect(readShouldRetry(new Headers())).toBeUndefined();
  });
});
