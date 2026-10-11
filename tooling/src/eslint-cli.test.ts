import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const ESLINT_BIN = join(
  dirname(createRequire(import.meta.url).resolve('eslint/package.json')),
  'bin',
  'eslint.js',
);
const POLICY_MODULE = pathToFileURL(join(REPO_ROOT, 'tooling', 'src', 'eslint-config.ts')).href;

const PackageJson = z.object({ scripts: z.record(z.string(), z.string()) });

let sandbox: string;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'autogeek-eslint-cli-'));
  await mkdir(join(sandbox, 'packages', 'sneaky', 'src'), { recursive: true });
  await writeFile(
    join(sandbox, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        types: [],
      },
      include: ['packages'],
    }),
  );
  await writeFile(
    join(sandbox, 'eslint.config.js'),
    `import { createEslintConfig } from ${JSON.stringify(POLICY_MODULE)};\nexport default createEslintConfig({ tsconfigRootDir: ${JSON.stringify(sandbox)} });\n`,
  );
  // A package that tries to opt out of the root policy with its own (empty) flat config.
  await writeFile(
    join(sandbox, 'packages', 'sneaky', 'eslint.config.js'),
    'export default [{}];\n',
  );
  await writeFile(
    join(sandbox, 'packages', 'sneaky', 'src', 'index.ts'),
    'export const value: any = JSON.parse("1");\n',
  );
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

interface CliOutcome {
  readonly exitCode: number;
  readonly output: string;
}

async function runEslint(args: readonly string[]): Promise<CliOutcome> {
  return execFileAsync(process.execPath, [ESLINT_BIN, ...args], { cwd: sandbox }).then(
    (result) => ({ exitCode: 0, output: result.stdout + result.stderr }),
    (failure: unknown) => {
      // ESLint exits non-zero when it reports problems; the report is on stdout.
      if (
        typeof failure === 'object' &&
        failure !== null &&
        'code' in failure &&
        'stdout' in failure
      ) {
        const { code, stdout } = failure;
        if (typeof code === 'number' && typeof stdout === 'string') {
          return { exitCode: code, output: stdout };
        }
      }
      throw failure;
    },
  );
}

describe('lint:eslint script', () => {
  it('pins the root config so a nested eslint.config.js cannot replace the policy', async () => {
    const raw: unknown = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
    const script = PackageJson.parse(raw).scripts['lint:eslint'];
    expect(script).toMatch(/--config eslint\.config\.js\b/);
    expect(script).toContain('--max-warnings 0');
  });
});

describe('real ESLint CLI over a tree with a nested config', () => {
  it('control: without --config the nested config silently disables the policy', async () => {
    const outcome = await runEslint(['.', '--max-warnings', '0']);
    expect(outcome.exitCode).toBe(0);
  });

  it('with --config the root policy still applies to the nested package', async () => {
    const outcome = await runEslint(['--config', 'eslint.config.js', '.', '--max-warnings', '0']);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toContain('@typescript-eslint/no-explicit-any');
  });
});
