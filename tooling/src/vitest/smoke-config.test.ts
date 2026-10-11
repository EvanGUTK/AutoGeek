import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SMOKE_NOT_RUN_MESSAGE, resolveSmokeSelection } from './smoke-config.ts';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const VITEST_BIN = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);
const SMOKE_CONFIG = pathToFileURL(
  join(REPO_ROOT, 'tooling', 'src', 'vitest', 'smoke-config.ts'),
).href;

const EXISTING = ['anthropic', 'openai', 'google'];

describe('resolveSmokeSelection (AUTOGEEK_SMOKE selects files, so no test ever needs to skip)', () => {
  it.each([undefined, ''])('is "not run" when AUTOGEEK_SMOKE is %j', (value) => {
    expect(resolveSmokeSelection(value, EXISTING)).toEqual({ kind: 'not_run' });
  });

  it('runs every smoke file for "all"', () => {
    expect(resolveSmokeSelection('all', EXISTING)).toEqual({ kind: 'all' });
  });

  it('selects exactly the named files from a comma list, in the order given and de-duplicated', () => {
    expect(resolveSmokeSelection('anthropic', EXISTING)).toEqual({
      kind: 'files',
      files: ['smoke/anthropic.smoke.ts'],
    });
    expect(resolveSmokeSelection('openai,anthropic,openai', EXISTING)).toEqual({
      kind: 'files',
      files: ['smoke/openai.smoke.ts', 'smoke/anthropic.smoke.ts'],
    });
  });

  it('tolerates spaces around the names', () => {
    expect(resolveSmokeSelection(' anthropic , openai ', EXISTING)).toEqual({
      kind: 'files',
      files: ['smoke/anthropic.smoke.ts', 'smoke/openai.smoke.ts'],
    });
  });

  it('fails on a listed name with no matching file: a typo is never a silent no-op', () => {
    expect(resolveSmokeSelection('anthropic,ghost', EXISTING)).toEqual({
      kind: 'unknown',
      names: ['ghost'],
    });
    expect(resolveSmokeSelection('ghost,phantom', EXISTING)).toEqual({
      kind: 'unknown',
      names: ['ghost', 'phantom'],
    });
  });

  it.each([
    'a,,b',
    ',',
    'anthropic,',
    '../secret',
    'a/b',
    'a b',
    'Anthropic',
    'all,anthropic',
    'anthropic,all',
    '1',
    'true',
  ])('rejects the malformed value %j', (value) => {
    const selection = resolveSmokeSelection(value, EXISTING);
    expect(['invalid', 'unknown']).toContain(selection.kind);
    expect(
      selection.kind === 'files' || selection.kind === 'all' || selection.kind === 'not_run',
    ).toBe(false);
  });

  it('does not let "all" be mixed into a list: it is reserved', () => {
    expect(resolveSmokeSelection('all,anthropic', EXISTING)).toEqual({
      kind: 'invalid',
      entries: ['all'],
    });
    expect(resolveSmokeSelection('anthropic,all', EXISTING)).toEqual({
      kind: 'invalid',
      entries: ['all'],
    });
  });

  it('reports every malformed entry, not just the first', () => {
    expect(resolveSmokeSelection('a b,../x,ok', EXISTING)).toEqual({
      kind: 'invalid',
      entries: ['a b', '../x'],
    });
  });

  it('states the NOT RUN reason in one stable line', () => {
    expect(SMOKE_NOT_RUN_MESSAGE).toMatch(/^NOT RUN: /);
    expect(SMOKE_NOT_RUN_MESSAGE).toContain('AUTOGEEK_SMOKE');
    expect(SMOKE_NOT_RUN_MESSAGE).not.toContain('\n');
  });
});

describe('createSmokeVitestConfig through the real vitest CLI', () => {
  let sandbox: string;
  let counter = 0;

  beforeAll(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'autogeek-smoke-'));
  });

  afterAll(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  interface Outcome {
    readonly exitCode: number;
    readonly output: string;
  }

  async function runSmoke(
    files: Record<string, string>,
    options: { readonly selection: string | undefined; readonly configArgs?: string } = {
      selection: 'all',
    },
  ): Promise<Outcome> {
    counter += 1;
    const dir = join(sandbox, `case-${String(counter)}`);
    await mkdir(dir, { recursive: true });
    await symlink(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
    await writeFile(
      join(dir, 'vitest.smoke.config.ts'),
      `import { createSmokeVitestConfig } from ${JSON.stringify(SMOKE_CONFIG)};\nexport default createSmokeVitestConfig(${options.configArgs ?? ''});\n`,
    );
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), content);
    }
    // Colour codes (turbo sets FORCE_COLOR) would split the text the assertions look for.
    const env: Record<string, string | undefined> = {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      AUTOGEEK_SMOKE: options.selection,
    };
    return execFileAsync(process.execPath, [VITEST_BIN, 'run', '-c', 'vitest.smoke.config.ts'], {
      cwd: dir,
      env,
    }).then(
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

  const header = "import { expect, it } from 'vitest';\n";
  const failing = {
    'smoke/a.smoke.ts': `${header}it('really fails', () => { expect(1).toBe(2); });\n`,
  };
  const passing = {
    'smoke/a.smoke.ts': `${header}it('really passes', () => { expect(1).toBe(1); });\n`,
  };

  it('with AUTOGEEK_SMOKE unset: prints NOT RUN, exits 0 and collects nothing', async () => {
    const outcome = await runSmoke(failing, { selection: undefined });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain('NOT RUN');
    expect(outcome.output).not.toContain('really fails');
  });

  it('with AUTOGEEK_SMOKE=all: runs the smoke tests and a failure fails the run', async () => {
    const outcome = await runSmoke(failing);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toContain('really fails');
  });

  it('with AUTOGEEK_SMOKE=all: a passing smoke test exits 0', async () => {
    const outcome = await runSmoke(passing);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toMatch(/Tests\s+1 passed/);
  });

  it.each([
    ['it.skip', `${header}it.skip('a', () => undefined);\nit('b', () => undefined);\n`],
    ['it.todo', `${header}it.todo('a');\nit('b', () => undefined);\n`],
    [
      'a runtime ctx.skip()',
      `${header}it('a', (ctx) => { ctx.skip(); });\nit('b', () => undefined);\n`,
    ],
  ])('fails the run when a smoke test is skipped via %s', async (_name, source) => {
    const outcome = await runSmoke({ 'smoke/a.smoke.ts': source });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toMatch(/skipped/i);
  });

  it('fails when there are no smoke files at all (an empty run is not a pass)', async () => {
    const outcome = await runSmoke({ 'smoke/readme.md': 'nothing here\n' });
    expect(outcome.exitCode).not.toBe(0);
  });

  it('collects only smoke/**/*.smoke.ts: other test files are not run', async () => {
    const outcome = await runSmoke({
      ...passing,
      'other.test.ts': `${header}it('outside smoke', () => { expect(1).toBe(2); });\n`,
      'smoke/mine.test.ts': `${header}it('wrong suffix', () => { expect(1).toBe(2); });\n`,
      'src/x.smoke.ts': `${header}it('wrong directory', () => { expect(1).toBe(2); });\n`,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).not.toContain('outside smoke');
    expect(outcome.output).not.toContain('wrong suffix');
    expect(outcome.output).not.toContain('wrong directory');
  });

  it('picks up nested smoke files', async () => {
    const outcome = await runSmoke({
      'smoke/deep/er/b.smoke.ts': `${header}it('nested fails', () => { expect(1).toBe(2); });\n`,
    });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toContain('nested fails');
  });

  describe('selecting files with a comma list', () => {
    const two = {
      'smoke/alpha.smoke.ts': `${header}it('alpha runs', () => { expect(1).toBe(1); });\n`,
      'smoke/beta.smoke.ts': `${header}it('beta runs and fails', () => { expect(1).toBe(2); });\n`,
    };

    it('runs only the named file', async () => {
      const outcome = await runSmoke(two, { selection: 'alpha' });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.output).toMatch(/Tests\s+1 passed/);
      expect(outcome.output).not.toContain('beta');
    });

    it('runs several named files, and a failing one fails the run', async () => {
      const outcome = await runSmoke(two, { selection: 'alpha,beta' });
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.output).toContain('beta runs and fails');
    });

    it('prints one line listing exactly the files it collects', async () => {
      const outcome = await runSmoke(two, { selection: 'alpha' });
      expect(outcome.output).toContain('AUTOGEEK_SMOKE: collecting smoke/alpha.smoke.ts');
      expect(outcome.output).not.toContain('smoke/beta.smoke.ts');
    });

    it('fails with a clear message when a listed name has no file (a typo is never a no-op)', async () => {
      const outcome = await runSmoke(two, { selection: 'alpha,gamma' });
      expect(outcome.exitCode).toBe(1);
      expect(outcome.output).toContain('AUTOGEEK_SMOKE names unknown smoke file(s): gamma');
      expect(outcome.output).not.toContain('alpha runs');
    });

    it('fails on a malformed value instead of running something', async () => {
      const outcome = await runSmoke(two, { selection: '../alpha' });
      expect(outcome.exitCode).toBe(1);
      expect(outcome.output).toContain('AUTOGEEK_SMOKE');
      expect(outcome.output).not.toContain('alpha runs');
    });

    it('does not select a nested file by basename (only smoke/<name>.smoke.ts)', async () => {
      const outcome = await runSmoke(
        { 'smoke/deep/gamma.smoke.ts': `${header}it('gamma', () => undefined);\n` },
        { selection: 'gamma' },
      );
      expect(outcome.exitCode).toBe(1);
      expect(outcome.output).toContain('unknown smoke file(s): gamma');
    });
  });

  it('ignores overrides even when the types are bypassed', async () => {
    const outcome = await runSmoke(failing, {
      selection: 'all',
      configArgs: "{ include: ['nothing/**'], passWithNoTests: true, retry: 5 }",
    });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toContain('really fails');
  });
});
