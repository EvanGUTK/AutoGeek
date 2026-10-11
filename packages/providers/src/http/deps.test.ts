import { describe, expect, it } from 'vitest';
import { abortableSleep, createTransportDeps } from './deps.ts';
import { NOOP_LOGGER } from './logger.ts';

describe('abortableSleep', () => {
  it('waits for the delay', async () => {
    const started = Date.now();
    await abortableSleep(30, new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('resolves early on abort', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = abortableSleep(10_000, controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 10);
    await sleeping;
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('resolves at once when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await abortableSleep(10_000, controller.signal);
    expect(controller.signal.aborted).toBe(true);
  });
});

describe('createTransportDeps', () => {
  it('uses the global fetch and a random source in [0, 1)', () => {
    const deps = createTransportDeps(NOOP_LOGGER);
    expect(deps.fetch).toBe(globalThis.fetch);
    const sample = deps.random();
    expect(sample).toBeGreaterThanOrEqual(0);
    expect(sample).toBeLessThan(1);
  });
});
