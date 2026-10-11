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
    `import { createEslintConfig } from ${JSON.stringify(POLICY_MODULE)};\nexport default createEslintConfig({ tsconfigRootDir: ${JSON.stringify(sandbox)}, projects: ['./tsconfig.json', './packages/*/tsconfig*.json', './modules/*/tsconfig*.json'] });\n`,
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

let fixtureCounter = 0;

/** Lints one file through the real CLI, exactly as `pnpm lint:eslint` does, and returns the output. */
async function lintFile(source: string, suffix = '.ts'): Promise<CliOutcome> {
  fixtureCounter += 1;
  const relative = join('packages', 'policy', 'src', `case${String(fixtureCounter)}${suffix}`);
  await mkdir(join(sandbox, 'packages', 'policy', 'src'), { recursive: true });
  await writeFile(join(sandbox, relative), source);
  return runEslint(['--config', 'eslint.config.js', relative, '--max-warnings', '0']);
}

describe('unsafe type assertions (real CLI)', () => {
  it.each([
    ['JSON.parse laundering', 'export const config = JSON.parse("{}") as { a: number };\n'],
    [
      'a generic cast helper',
      'export function cast<T>(value: unknown): T {\n  return value as T;\n}\n',
    ],
    [
      'narrowing a union',
      'export function f(value: string | number): string {\n  return value as string;\n}\n',
    ],
    [
      'narrowing to a subtype',
      'interface Base { id: string }\ninterface Derived extends Base { extra: number }\nexport function f(base: Base): Derived {\n  return base as Derived;\n}\n',
    ],
  ])('rejects %s', async (_name, source) => {
    const outcome = await lintFile(source);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toContain('@typescript-eslint/no-unsafe-type-assertion');
  });

  it.each([
    ['as const', 'export const tuple = [1, 2] as const;\n'],
    [
      'widening to a supertype',
      'interface Base { id: string }\ninterface Derived extends Base { extra: number }\nexport function f(d: Derived): Base {\n  return d as Base;\n}\n',
    ],
    ['widening to unknown', 'export const value = "x" as unknown;\n'],
  ])('allows %s', async (_name, source) => {
    const outcome = await lintFile(source);
    expect(outcome.output).not.toContain('no-unsafe-type-assertion');
  });
});

describe('skipped-test lint is scoped to test files (real CLI)', () => {
  const product =
    'declare const cursor: { skip: (n: number) => number };\ndeclare const filter: { only: boolean; todo: string[] };\n' +
    'export const next = cursor.skip(2);\nexport const n = filter.only ? filter.todo.length : 0;\n';

  it('leaves product code that has skip/only/todo members alone', async () => {
    const outcome = await lintFile(product);
    expect(outcome.exitCode).toBe(0);
  });

  it.each(['.test.ts', '.spec.ts'])('still bans skipping in a %s file', async (suffix) => {
    const outcome = await lintFile(
      "declare const it: { skip: (name: string) => void };\nit.skip('x');\n",
      suffix,
    );
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toContain('Skipped, focused, or todo tests are not allowed');
  });
});

describe('packages with a product tsconfig and a separate test tsconfig (real CLI)', () => {
  beforeAll(async () => {
    // Outside the sandbox root tsconfig's include, so only the package's own configs can cover it.
    const pkg = join(sandbox, 'modules', 'split');
    await mkdir(join(pkg, 'src'), { recursive: true });
    await writeFile(
      join(pkg, 'tsconfig.json'),
      JSON.stringify({
        extends: '../../tsconfig.json',
        include: ['src'],
        exclude: ['src/**/*.test.ts'],
      }),
    );
    await writeFile(
      join(pkg, 'tsconfig.test.json'),
      JSON.stringify({ extends: './tsconfig.json', include: ['src'], exclude: [] }),
    );
    await writeFile(join(pkg, 'src', 'index.ts'), 'export const value = 1;\n');
    await writeFile(
      join(pkg, 'src', 'index.test.ts'),
      "declare const it: (name: string, fn: () => void) => void;\nit('works', () => undefined);\n",
    );
  });

  it('type-aware lints both product and test files without "not found by project" errors', async () => {
    const outcome = await runEslint([
      '--config',
      'eslint.config.js',
      'modules/split',
      '--max-warnings',
      '0',
    ]);
    expect(outcome.output).not.toMatch(
      /parserOptions\.project|was not found by the project service|Parsing error/,
    );
    expect(outcome.exitCode).toBe(0);
  });

  it('still applies the type-aware rules to the test file', async () => {
    await writeFile(
      join(sandbox, 'modules', 'split', 'src', 'bad.test.ts'),
      'export const value: any = JSON.parse("1");\n',
    );
    const outcome = await runEslint([
      '--config',
      'eslint.config.js',
      'modules/split/src/bad.test.ts',
    ]);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toContain('@typescript-eslint/no-explicit-any');
  });
});

describe('triple-slash directives cannot change a package environment (real CLI)', () => {
  it.each([
    ['types="node"', '/// <reference types="node" />\nexport const home = process.env["HOME"];\n'],
    ['lib="dom"', '/// <reference lib="dom" />\nexport const title = document.title;\n'],
    ['lib="webworker"', '/// <reference lib="webworker" />\nexport const v = 1;\n'],
    ['path=...', '/// <reference path="./extra.d.ts" />\nexport const v = 1;\n'],
  ])('rejects /// <reference %s />', async (_name, source) => {
    const outcome = await lintFile(source);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toContain('@typescript-eslint/triple-slash-reference');
  });

  it('does not flag an ordinary comment that starts with three slashes', async () => {
    const outcome = await lintFile('/// A documentation comment.\nexport const v = 1;\n');
    expect(outcome.output).not.toContain('triple-slash-reference');
  });
});
