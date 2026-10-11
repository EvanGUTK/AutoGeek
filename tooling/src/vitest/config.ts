import { defineConfig } from 'vitest/config';
import type { TestUserConfig } from 'vitest/config';
import { FailOnSkippedReporter } from './fail-on-skipped-reporter.ts';

/**
 * The one Vitest configuration every package uses. `.only` is a hard error and any skipped test
 * fails the run. Packages may add options (timeouts, environment) but not weaken these two.
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
