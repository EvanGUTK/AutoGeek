/**
 * Structured, metadata-only logging. Fields carry ids, statuses, counts and durations, NEVER
 * request or response bodies: those contain user code and prompts. Vendor error text goes only in
 * a `detail` field after `redactSecrets`, and only at debug level.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
}

export const NOOP_LOGGER: Logger = {
  debug() {
    // Intentionally empty: the no-op logger drops everything.
  },
  info() {
    // Intentionally empty: the no-op logger drops everything.
  },
  warn() {
    // Intentionally empty: the no-op logger drops everything.
  },
};
