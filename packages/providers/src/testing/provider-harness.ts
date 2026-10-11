import type { LogFields, Logger } from '../http/logger.ts';
import type { TransportDeps } from '../http/transport.ts';

export interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn';
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/**
 * Transport deps for adapter tests. Requests to `fixedOrigin` are sent to the fake server
 * instead, so fixed-endpoint adapters keep their real origin check. Sleeps are instant and
 * recorded; every log line is captured for leak assertions.
 */
export function testDeps(target: { fixedOrigin?: string; serverOrigin: string }): {
  deps: TransportDeps;
  logs: LogEntry[];
  sleeps: number[];
} {
  const logs: LogEntry[] = [];
  const sleeps: number[] = [];
  const logger: Logger = {
    debug: (message, fields) => logs.push({ level: 'debug', message, fields }),
    info: (message, fields) => logs.push({ level: 'info', message, fields }),
    warn: (message, fields) => logs.push({ level: 'warn', message, fields }),
  };
  const deps: TransportDeps = {
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const routed =
        target.fixedOrigin !== undefined && url.startsWith(target.fixedOrigin)
          ? target.serverOrigin + url.slice(target.fixedOrigin.length)
          : url;
      return globalThis.fetch(routed, init);
    },
    now: () => Date.now(),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    logger,
  };
  return { deps, logs, sleeps };
}
