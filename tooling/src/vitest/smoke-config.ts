import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { FailOnSkippedReporter } from './fail-on-skipped-reporter.ts';

export const SMOKE_NOT_RUN_MESSAGE =
  'NOT RUN: AUTOGEEK_SMOKE is not set, so the real-API smoke tests were not collected ' +
  '(set AUTOGEEK_SMOKE=all, or a comma list of smoke file names such as anthropic,openai)';

const SMOKE_SUFFIX = '.smoke.ts';
const NAME = /^[a-z0-9][a-z0-9_-]*$/;

export type SmokeSelection =
  | { readonly kind: 'not_run' }
  | { readonly kind: 'all' }
  | { readonly kind: 'files'; readonly files: readonly string[] }
  | { readonly kind: 'unknown'; readonly names: readonly string[] }
  | { readonly kind: 'invalid'; readonly entries: readonly string[] };

/**
 * Turns the AUTOGEEK_SMOKE value into what to run. The value SELECTS files, so a test never has
 * to skip itself when a vendor key is missing (skips are banned): unset or empty runs nothing,
 * `all` runs every smoke file, and a comma list of file names runs exactly
 * `smoke/<name>.smoke.ts` for each. A name without a file is `unknown` and a malformed entry is
 * `invalid`; both must fail the run, because a typo must never become a silent no-op.
 * `existing` lists the names of the top-level smoke files.
 */
export function resolveSmokeSelection(
  value: string | undefined,
  existing: readonly string[],
): SmokeSelection {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') {
    return { kind: 'not_run' };
  }
  if (trimmed === 'all') {
    return { kind: 'all' };
  }
  const entries = trimmed.split(',').map((entry) => entry.trim());
  const invalid = entries.filter((entry) => !NAME.test(entry) || entry === 'all');
  if (invalid.length > 0) {
    return { kind: 'invalid', entries: invalid };
  }
  const names = [...new Set(entries)];
  const unknown = names.filter((name) => !existing.includes(name));
  if (unknown.length > 0) {
    return { kind: 'unknown', names: unknown };
  }
  return { kind: 'files', files: names.map((name) => `smoke/${name}${SMOKE_SUFFIX}`) };
}

/** Every `*.smoke.ts` under `<cwd>/smoke`, as POSIX paths relative to `cwd`, found iteratively. */
function listSmokeFiles(cwd: string): string[] {
  const found: string[] = [];
  const pending = ['smoke'];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    let entries;
    try {
      entries = readdirSync(join(cwd, directory), { withFileTypes: true });
    } catch {
      continue; // no smoke directory: nothing to list
    }
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.name.endsWith(SMOKE_SUFFIX)) {
        found.push(path);
      }
    }
  }
  return found.sort();
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  return process.exit(1);
}

/**
 * The one Vitest configuration for opt-in real-API smoke tests, used only by a package's
 * `vitest.smoke.config.ts` and run only by its `smoke` script, never by `test`, `typecheck` or
 * `verify`. It takes NO options. Like createVitestConfig it fails the run on any skipped test and
 * on an empty run, never retries, and forbids `.only`. Test discovery is limited to
 * `smoke/**\/*.smoke.ts`, files run one at a time (real APIs rate-limit), and timeouts are long.
 *
 * The AUTOGEEK_SMOKE gate lives here so every package behaves the same: unset prints one
 * `NOT RUN` line and exits 0 without collecting anything.
 */
export function createSmokeVitestConfig(): ReturnType<typeof defineConfig> {
  const all = listSmokeFiles(process.cwd());
  const topLevel = all
    .filter((file) => file.split('/').length === 2)
    .map((file) => file.slice('smoke/'.length, -SMOKE_SUFFIX.length));
  const selection = resolveSmokeSelection(process.env['AUTOGEEK_SMOKE'], topLevel);
  switch (selection.kind) {
    case 'not_run':
      process.stderr.write(`${SMOKE_NOT_RUN_MESSAGE}\n`);
      return process.exit(0);
    case 'invalid':
      return fail(
        `AUTOGEEK_SMOKE must be "all" or a comma list of smoke file names; invalid: ${selection.entries.join(', ')}`,
      );
    case 'unknown':
      return fail(`AUTOGEEK_SMOKE names unknown smoke file(s): ${selection.names.join(', ')}`);
    case 'all':
    case 'files': {
      const include = selection.kind === 'all' ? ['smoke/**/*.smoke.ts'] : [...selection.files];
      const collected = selection.kind === 'all' ? all : selection.files;
      process.stderr.write(`AUTOGEEK_SMOKE: collecting ${collected.join(', ') || 'nothing'}\n`);
      return defineConfig({
        test: {
          include,
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
          allowOnly: false,
          passWithNoTests: false,
          retry: 0,
          reporters: ['default', new FailOnSkippedReporter()],
        },
      });
    }
  }
}
