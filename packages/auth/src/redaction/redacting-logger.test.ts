import { describe, expect, it } from 'vitest';
import { REDACTED, createSecretRegistry } from './redact.ts';
import { REDACTION_FAILED, createRedactingLogger } from './redacting-logger.ts';
import type { LogLevel, Logger } from './redacting-logger.ts';

interface Entry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: unknown;
}

function capture(): { readonly logger: Logger; readonly entries: Entry[] } {
  const entries: Entry[] = [];
  return {
    entries,
    logger: {
      log(level, message, fields) {
        entries.push({ level, message, fields });
      },
    },
  };
}

const KEY = 'sk-ant-api03-Zq9xY8wV7uT6sR5pZq9xY8wV7uT6sR5p';

describe('createRedactingLogger', () => {
  it('redacts the message and every field before the inner logger sees them', () => {
    const { logger, entries } = capture();
    const registry = createSecretRegistry();
    registry.add('custom-local-token');
    const redacting = createRedactingLogger(logger, registry);
    redacting.log('warn', `validate failed for ${KEY}`, {
      header: 'x-api-key: custom-local-token',
      nested: { error: new Error(`401 echoed ${KEY}`) },
    });
    expect(entries).toHaveLength(1);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('Zq9xY8wV7uT6');
    expect(serialized).not.toContain('custom-local-token');
    expect(entries[0]?.level).toBe('warn');
    expect(entries[0]?.message).toBe(`validate failed for ${REDACTED}`);
  });

  it('passes no fields when none were given', () => {
    const { logger, entries } = capture();
    createRedactingLogger(logger, createSecretRegistry()).log('info', 'vault opened');
    expect(entries).toEqual([{ level: 'info', message: 'vault opened', fields: undefined }]);
  });

  it('logs a marker instead of the original when redaction throws', () => {
    const { logger, entries } = capture();
    const hostile = {
      get boom(): string {
        throw new Error(`getter leaked ${KEY}`);
      },
    };
    createRedactingLogger(logger, createSecretRegistry()).log('error', `msg ${KEY}`, { hostile });
    expect(entries).toEqual([{ level: 'error', message: REDACTION_FAILED, fields: undefined }]);
  });
});
