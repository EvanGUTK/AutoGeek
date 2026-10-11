import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const VITEST_BIN = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);
const SHARED_CONFIG = pathToFileURL(join(REPO_ROOT, 'tooling', 'src', 'vitest', 'config.ts')).href;

let sandbox: string;
let counter = 0;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'autogeek-vitest-'));
  await symlink(join(REPO_ROOT, 'node_modules'), join(sandbox, 'node_modules'));
  await writeFile(
    join(sandbox, 'vitest.config.ts'),
    `import { createVitestConfig } from ${JSON.stringify(SHARED_CONFIG)};\nexport default createVitestConfig();\n`,
  );
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

interface RunOutcome {
  readonly exitCode: number;
  readonly output: string;
}

/** Runs the real `vitest run` CLI over a single fixture test file. */
async function runFixture(source: string): Promise<RunOutcome> {
  counter += 1;
  const file = `case${String(counter)}.test.ts`;
  await writeFile(join(sandbox, file), source);
  return execFileAsync(process.execPath, [VITEST_BIN, 'run', file], { cwd: sandbox }).then(
    (result) => ({ exitCode: 0, output: result.stdout + result.stderr }),
    (failure: unknown) => {
      // vitest exits non-zero when the run fails; the report is on stdout/stderr.
      if (typeof failure === 'object' && failure !== null && 'code' in failure) {
        const { code } = failure;
        const stdout =
          'stdout' in failure && typeof failure.stdout === 'string' ? failure.stdout : '';
        const stderr =
          'stderr' in failure && typeof failure.stderr === 'string' ? failure.stderr : '';
        if (typeof code === 'number') {
          return { exitCode: code, output: stdout + stderr };
        }
      }
      throw failure;
    },
  );
}

const header = "import { describe, expect, it, test } from 'vitest';\n";

describe('shared vitest config', () => {
  it('control: a fully passing file exits 0', async () => {
    const outcome = await runFixture(`${header}it('passes', () => { expect(1).toBe(1); });\n`);
    expect(outcome.exitCode).toBe(0);
  });

  it.each([
    ['it.skip', `${header}it.skip('a', () => undefined);\nit('b', () => undefined);\n`],
    ['it.todo', `${header}it.todo('a');\nit('b', () => undefined);\n`],
    [
      'it.concurrent.skip',
      `${header}it.concurrent.skip('a', () => undefined);\nit('b', () => undefined);\n`,
    ],
    [
      'an aliased import',
      `import { it as spec } from 'vitest';\nspec.skip('a', () => undefined);\nspec('b', () => undefined);\n`,
    ],
    [
      'an extended test',
      `${header}const mine = test.extend({});\nmine.skip('a', () => undefined);\nmine('b', () => undefined);\n`,
    ],
    [
      'a runtime ctx.skip()',
      `${header}it('a', (ctx) => { ctx.skip(); });\nit('b', () => undefined);\n`,
    ],
    [
      'describe.skip',
      `${header}describe.skip('s', () => { it('a', () => undefined); });\nit('b', () => undefined);\n`,
    ],
    ['it.skipIf', `${header}it.skipIf(true)('a', () => undefined);\nit('b', () => undefined);\n`],
  ])('fails the run when a test is skipped via %s', async (_name, source) => {
    const outcome = await runFixture(source);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toMatch(/skipped/i);
  });

  it('fails the run on .only (allowOnly is false)', async () => {
    const outcome = await runFixture(
      `${header}it.only('a', () => undefined);\nit('b', () => undefined);\n`,
    );
    expect(outcome.exitCode).not.toBe(0);
  });
});

describe('createVitestConfig ignores options that would hide tests (real CLI)', () => {
  /** Runs vitest in a fresh directory whose config calls the factory with `args`. */
  async function runWithConfig(args: string, files: Record<string, string>): Promise<RunOutcome> {
    counter += 1;
    const dir = join(sandbox, `config-case-${String(counter)}`);
    await mkdir(dir, { recursive: true });
    await symlink(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
    await writeFile(
      join(dir, 'vitest.config.ts'),
      `import { createVitestConfig } from ${JSON.stringify(SHARED_CONFIG)};\nexport default createVitestConfig(${args});\n`,
    );
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    return execFileAsync(process.execPath, [VITEST_BIN, 'run'], { cwd: dir }).then(
      (result) => ({ exitCode: 0, output: result.stdout + result.stderr }),
      (failure: unknown) => {
        if (typeof failure === 'object' && failure !== null && 'code' in failure) {
          const { code } = failure;
          const stdout =
            'stdout' in failure && typeof failure.stdout === 'string' ? failure.stdout : '';
          const stderr =
            'stderr' in failure && typeof failure.stderr === 'string' ? failure.stderr : '';
          if (typeof code === 'number') {
            return { exitCode: code, output: stdout + stderr };
          }
        }
        throw failure;
      },
    );
  }

  const failing = {
    'broken.test.ts': `${header}it('really fails', () => { expect(1).toBe(2); });\n`,
  };

  it('control: with no options a failing test fails the run', async () => {
    const outcome = await runWithConfig('', failing);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toContain('really fails');
  });

  it('passWithNoTests: true cannot make an empty run succeed', async () => {
    const outcome = await runWithConfig('{ passWithNoTests: true }', {});
    expect(outcome.exitCode).not.toBe(0);
  });

  it('an include pattern that matches nothing cannot hide a failing test', async () => {
    const outcome = await runWithConfig(
      "{ include: ['nothing/**'], passWithNoTests: true }",
      failing,
    );
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toContain('really fails');
  });

  it('retry cannot turn a failing test into a pass', async () => {
    const flaky = {
      'flaky.test.ts': `${header}let n = 0;\nit('fails twice', () => { n += 1; expect(n).toBeGreaterThan(2); });\n`,
    };
    const outcome = await runWithConfig('{ retry: 5 }', flaky);
    expect(outcome.exitCode).not.toBe(0);
  });

  it('allowOnly cannot be turned back on', async () => {
    const only = {
      'only.test.ts': `${header}it.only('a', () => undefined);\nit('b', () => undefined);\n`,
    };
    const outcome = await runWithConfig('{ allowOnly: true }', only);
    expect(outcome.exitCode).not.toBe(0);
  });
});
