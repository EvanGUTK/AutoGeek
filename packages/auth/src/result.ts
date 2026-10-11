/**
 * Structural twin of `@autogeek/core`'s `Result` (same field names and constructors), used until
 * the core base slice merges. Replacing this module with a re-export from core must not change any
 * behavior; delete it then.
 */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}
