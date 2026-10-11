import type { Logger } from './logger.ts';
import type { TransportDeps } from './transport.ts';

/** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Production transport dependencies: global fetch (undici), wall clock, Math.random. */
export function createTransportDeps(logger: Logger): TransportDeps {
  return {
    fetch: globalThis.fetch,
    now: () => Date.now(),
    sleep: abortableSleep,
    random: () => Math.random(),
    logger,
  };
}
