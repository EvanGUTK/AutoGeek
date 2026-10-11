import { redactText, redactValue } from './redact.ts';
import type { Redacted, SecretRegistry } from './redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * The structured logger auth writes to. Main-process only; never forwarded to the renderer.
 * Kept minimal and local until core defines a shared logging port.
 */
export interface Logger {
  log(level: LogLevel, message: string, fields?: Readonly<Record<string, Redacted>>): void;
}

/** Logged in place of an entry whose redaction threw, so the original never reaches the sink. */
export const REDACTION_FAILED = '[log entry dropped: redaction failed]';

export interface RedactingLogger {
  log(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void;
}

function redactFields(
  fields: Readonly<Record<string, unknown>>,
  registry: Pick<SecretRegistry, 'secrets'>,
): Readonly<Record<string, Redacted>> {
  // A plain record at depth 0 always redacts to an object; anything else is dropped, not logged.
  const redacted = redactValue(fields, registry);
  const out: Record<string, Redacted> = {};
  if (typeof redacted === 'object' && redacted !== null && !Array.isArray(redacted)) {
    Object.assign(out, redacted);
  }
  return out;
}

/**
 * Wraps `inner` so every message and field is redacted (registered secrets, credential-bearing
 * headers and fields, known key shapes) before it is written. If redaction itself throws (a
 * hostile getter, for example), a fixed marker is logged instead and the original is dropped.
 */
export function createRedactingLogger(
  inner: Logger,
  registry: Pick<SecretRegistry, 'secrets'>,
): RedactingLogger {
  return {
    log(level, message, fields) {
      let safeMessage: string;
      let safeFields: Readonly<Record<string, Redacted>> | undefined;
      try {
        safeMessage = redactText(message, registry);
        safeFields = fields === undefined ? undefined : redactFields(fields, registry);
      } catch {
        // Whatever was thrown (it may itself carry a secret) is dropped with the entry.
        inner.log(level, REDACTION_FAILED);
        return;
      }
      if (safeFields === undefined) inner.log(level, safeMessage);
      else inner.log(level, safeMessage, safeFields);
    },
  };
}
