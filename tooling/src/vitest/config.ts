import { defineConfig } from 'vitest/config';
import { FailOnSkippedReporter } from './fail-on-skipped-reporter.ts';

/** The only option packages may pass. Everything else is fixed by the shared policy. */
export interface VitestConfigOptions {
  readonly testTimeout?: number;
}

/**
 * The one Vitest configuration every package uses. `.only` is a hard error, any skipped test
 * fails the run, an empty run fails, and failed tests are never retried into a pass. Test
 * discovery is Vitest's default. Only `testTimeout` is read from `options`; every other key is
 * ignored even if a caller bypasses the type (nothing that could hide or re-run tests can be
 * passed through).
 *
 * Limitations, by design of Vitest:
 * - A `--reporter=...` CLI flag REPLACES the configured reporters and so drops the skip gate.
 *   Every package's `test` script must therefore be exactly `vitest run`; package-policy.test.ts
 *   enforces that.
 * - `-t <pattern>` makes the filtered-out tests count as skipped, so a filtered run fails. That
 *   is the intended default; run a single file (`vitest run path/to/file.test.ts`) instead.
 */
export function createVitestConfig(
  options: VitestConfigOptions = {},
): ReturnType<typeof defineConfig> {
  const { testTimeout } = options;
  return defineConfig({
    test: {
      ...(typeof testTimeout === 'number' ? { testTimeout } : {}),
      allowOnly: false,
      passWithNoTests: false,
      retry: 0,
      reporters: ['default', new FailOnSkippedReporter()],
    },
  });
}
