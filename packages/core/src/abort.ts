/**
 * The reason an aborted signal carries, as a real `Error`. `AbortSignal.reason` is typed `any`
 * and callers may abort with any value; this normalizes it so it can be thrown or used to reject.
 * Calling it on a signal that has not aborted is a programmer error.
 */
export function abortReason(signal: AbortSignal): Error {
  if (!signal.aborted) {
    throw new Error('abortReason called on a signal that is not aborted');
  }
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error('The operation was aborted.', { cause: reason });
  error.name = 'AbortError';
  return error;
}
