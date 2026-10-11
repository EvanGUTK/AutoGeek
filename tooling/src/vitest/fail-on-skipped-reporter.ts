import type { Reporter, TestModule } from 'vitest/node';

/**
 * Fails the run when any test ends up skipped, however it got there: `skip`, `todo`, `skipIf`,
 * a chained or aliased modifier, a describe-level skip, or a runtime `ctx.skip()`. Lint can only
 * see some of these; this sees all of them because it looks at test outcomes, not syntax.
 */
export class FailOnSkippedReporter implements Reporter {
  onTestRunEnd(testModules: readonly TestModule[]): void {
    const skipped = testModules.flatMap((module) =>
      [...module.children.allTests('skipped')].map(
        (test) => `${module.moduleId} > ${test.fullName}`,
      ),
    );
    if (skipped.length === 0) {
      return;
    }
    process.stderr.write(
      `\nSkipped tests are not allowed (${String(skipped.length)}). Write the test or delete it:\n` +
        skipped.map((name) => `  - ${name}\n`).join(''),
    );
    process.exitCode = 1;
  }
}
