import { abortReason } from './abort.ts';

export type Unsubscribe = () => void;

export interface ListenOptions {
  /** Removes the listener (or rejects `once`) when aborted. */
  readonly signal?: AbortSignal | undefined;
}

export interface EmitterOptions<E extends object> {
  /**
   * Called when a listener throws. The emitter never swallows a listener failure and never lets
   * one listener stop the others; the owner decides how to surface it (log, event, ...).
   * If this callback itself throws, the error propagates out of `emit`.
   */
  readonly onListenerError: (error: unknown, type: keyof E & string) => void;
}

export interface TypedEmitter<E extends object> {
  on<K extends keyof E & string>(
    type: K,
    listener: (payload: E[K]) => void,
    options?: ListenOptions,
  ): Unsubscribe;
  /** Resolves with the next payload of `type`; rejects with the abort reason if aborted first. */
  once<K extends keyof E & string>(type: K, options?: ListenOptions): Promise<E[K]>;
  /** Delivers synchronously, in registration order, to a snapshot of the current listeners. */
  emit<K extends keyof E & string>(type: K, payload: E[K]): void;
  listenerCount(type: keyof E & string): number;
}

interface Registration<P> {
  readonly listener: (payload: P) => void;
  active: boolean;
}

export function createEmitter<E extends object>(options: EmitterOptions<E>): TypedEmitter<E> {
  const registrations: { [K in keyof E & string]?: Set<Registration<E[K]>> } = {};

  function on<K extends keyof E & string>(
    type: K,
    listener: (payload: E[K]) => void,
    listenOptions: ListenOptions = {},
  ): Unsubscribe {
    const { signal } = listenOptions;
    if (signal?.aborted === true) {
      return () => undefined;
    }
    const registration: Registration<E[K]> = { listener, active: true };
    const set = registrations[type] ?? new Set<Registration<E[K]>>();
    set.add(registration);
    registrations[type] = set;

    const unsubscribe = (): void => {
      registration.active = false;
      set.delete(registration);
      signal?.removeEventListener('abort', unsubscribe);
    };
    signal?.addEventListener('abort', unsubscribe, { once: true });
    return unsubscribe;
  }

  function once<K extends keyof E & string>(
    type: K,
    listenOptions: ListenOptions = {},
  ): Promise<E[K]> {
    const { signal } = listenOptions;
    return new Promise<E[K]>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = (): void => {
        unsubscribe();
        if (signal !== undefined) {
          reject(abortReason(signal));
        }
      };
      const unsubscribe = on(
        type,
        (payload) => {
          unsubscribe();
          signal?.removeEventListener('abort', onAbort);
          resolve(payload);
        },
        { signal },
      );
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function emit<K extends keyof E & string>(type: K, payload: E[K]): void {
    const set = registrations[type];
    if (set === undefined) {
      return;
    }
    for (const registration of [...set]) {
      if (!registration.active) {
        continue;
      }
      try {
        registration.listener(payload);
      } catch (error) {
        options.onListenerError(error, type);
      }
    }
  }

  function listenerCount(type: keyof E & string): number {
    return registrations[type]?.size ?? 0;
  }

  return { on, once, emit, listenerCount };
}
