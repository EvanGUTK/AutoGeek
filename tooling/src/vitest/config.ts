import { defineConfig } from 'vitest/config';
import type { TestUserConfig } from 'vitest/config';
import { FailOnSkippedReporter } from './fail-on-skipped-reporter.ts';

/**
 * The one Vitest configuration every package uses. `.only` is a hard error and any skipped test
 * fails the run. Packages may add options (timeouts, environment) but not weaken these two.
 *
 * Limitations, by design of Vitest:
 * - A `--reporter=...` CLI flag REPLACES the configured reporters and so drops the skip gate.
 *   Every package's `test` script must therefore be exactly `vitest run`; package-policy.test.ts
 *   enforces that.
 * - `-t <pattern>` makes the filtered-out tests count as skipped, so a filtered run fails. That
 *   is the intended default; run a single file (`vitest run path/to/file.test.ts`) instead.
 */
export function createVitestConfig(options: TestUserConfig = {}): ReturnType<typeof defineConfig> {
  return defineConfig({
    test: {
      ...options,
      allowOnly: false,
      reporters: ['default', new FailOnSkippedReporter()],
    },
  });
}
