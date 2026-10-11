/**
 * Coalesces concurrent work per key: while a run for `key` is in flight, every caller shares its
 * outcome instead of starting another. Used for OAuth token refresh, where two concurrent refreshes
 * with a rotating refresh token would invalidate each other.
 */
export interface SingleFlight<K, T> {
  /**
   * Joins the in-flight run for `key`, or starts `work` if there is none. `signal` only stops THIS
   * caller waiting (it rejects with an AbortError); the shared run continues for the others.
   */
  run(key: K, work: () => Promise<T>, signal: AbortSignal): Promise<T>;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function waitUnlessAborted<T>(shared: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    shared.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (reason: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(reason instanceof Error ? reason : new Error('single-flight run failed'));
      },
    );
  });
}

export function createSingleFlight<K, T>(): SingleFlight<K, T> {
  const inFlight = new Map<K, Promise<T>>();
  return {
    run(key, work, signal) {
      if (signal.aborted) return Promise.reject(abortError());
      let shared = inFlight.get(key);
      if (shared === undefined) {
        const started = Promise.resolve().then(work);
        shared = started.finally(() => {
          inFlight.delete(key);
        });
        inFlight.set(key, shared);
      }
      return waitUnlessAborted(shared, signal);
    },
  };
}
