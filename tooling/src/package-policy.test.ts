import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkPackage, listWorkspaceDirectories } from './package-policy.ts';
import type { PackageViolation } from './package-policy.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'autogeek-package-policy-'));
  await cp(join(REPO_ROOT, 'tsconfig.base.json'), join(repo, 'tsconfig.base.json'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

type Environment = 'neutral' | 'node' | 'dom';

const LIBS: Readonly<Record<Environment, readonly string[]>> = {
  neutral: ['ES2023', 'WebWorker'],
  node: ['ES2023'],
  dom: ['ES2023', 'DOM', 'DOM.Iterable'],
};

/** A fully valid package for `environment`, as the generator for real packages would write it. */
function packageFiles(name: string, environment: Environment): Record<string, string> {
  return {
    'package.json': JSON.stringify({
      name: `@autogeek/${name}`,
      version: '0.0.0',
      private: true,
      type: 'module',
      autogeek: { environment },
      exports: { '.': './src/index.ts' },
      scripts: {
        typecheck: 'tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json',
        test: 'vitest run',
      },
    }),
    'tsconfig.json': JSON.stringify({
      extends: '../../tsconfig.base.json',
      compilerOptions: { lib: LIBS[environment], types: environment === 'node' ? ['node'] : [] },
      include: ['src'],
      exclude: ['src/**/*.test.ts'],
    }),
    'tsconfig.test.json': JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { types: ['node'] },
      include: ['src', 'vitest.config.ts'],
      exclude: [],
    }),
    'vitest.config.ts':
      "import { createVitestConfig } from '@autogeek/tooling/vitest';\nexport default createVitestConfig();\n",
    'src/index.ts': 'export {};\n',
    'src/index.test.ts': "import { it } from 'vitest';\nit('loads', () => undefined);\n",
  };
}

const TYPECHECK = 'tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json';

const validPackage = packageFiles('demo', 'node');

/** Writes packages/<name> with `overrides` applied (a null value skips the file). */
async function checkNamed(
  name: string,
  files: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string | null>> = {},
): Promise<PackageViolation[]> {
  for (const [file, content] of Object.entries({ ...files, ...overrides })) {
    if (content === null) {
      continue;
    }
    const target = join(repo, 'packages', name, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await mkdir(join(repo, 'packages', name), { recursive: true });
  return checkPackage(repo, `packages/${name}`);
}

async function check(
  overrides: Readonly<Record<string, string | null>> = {},
): Promise<PackageViolation[]> {
  return checkNamed('demo', validPackage, overrides);
}

const codes = (violations: PackageViolation[]): string[] => violations.map((v) => v.code);

const JsonRecord = z.record(z.string(), z.unknown());

const validManifest = (): Record<string, unknown> =>
  JsonRecord.parse(JSON.parse(validPackage['package.json'] ?? '{}'));

const manifest = (patch: Record<string, unknown>): string =>
  JSON.stringify({ ...validManifest(), ...patch });

describe('checkPackage on a well-formed package', () => {
  it('reports nothing', async () => {
    expect(await check()).toEqual([]);
  });
});

describe('manifest', () => {
  it('requires the @autogeek/<dir> name', async () => {
    expect(codes(await check({ 'package.json': manifest({ name: 'demo' }) }))).toContain(
      'bad-name',
    );
  });

  it('requires private: true', async () => {
    expect(codes(await check({ 'package.json': manifest({ private: false }) }))).toContain(
      'not-private',
    );
  });

  it('fails closed on a directory without package.json', async () => {
    expect(codes(await check({ 'package.json': null }))).toContain('not-a-package');
  });

  it('explains how to clean up a leftover directory from a branch switch', async () => {
    const result = await check({ 'package.json': null });
    const detail = result.find((v) => v.code === 'not-a-package')?.detail ?? '';
    expect(detail).toMatch(/branch/i);
    expect(detail).toMatch(/node_modules|\.turbo/);
    expect(detail).toMatch(/remove|delete/i);
  });
});

describe('scripts (a package without them is silently skipped by `turbo run`)', () => {
  it.each(['typecheck', 'test'])('requires a %s script', async (script) => {
    const scripts: Record<string, string> = { typecheck: TYPECHECK, test: 'vitest run' };
    Reflect.deleteProperty(scripts, script);
    expect(codes(await check({ 'package.json': manifest({ scripts }) }))).toContain(
      'missing-script',
    );
  });

  it.each([
    ['a typecheck that does not run tsc', 'typecheck', 'echo ok'],
    ['a typecheck that emits', 'typecheck', 'tsc -p tsconfig.json && tsc -p tsconfig.test.json'],
    ['a typecheck of the product config only', 'typecheck', 'tsc --noEmit -p tsconfig.json'],
    ['a typecheck whose failure is swallowed with || true', 'typecheck', `${TYPECHECK} || true`],
    ['a typecheck followed by a statement separator', 'typecheck', `${TYPECHECK}; true`],
    ['a typecheck piped to cat', 'typecheck', `${TYPECHECK} | cat`],
    ['a test whose failure is swallowed with || true', 'test', 'vitest run || true'],
    ['a typecheck of the test config only', 'typecheck', 'tsc --noEmit -p tsconfig.test.json'],
    ['watch mode', 'test', 'vitest'],
    ['passWithNoTests', 'test', 'vitest run --passWithNoTests'],
    ['allowOnly', 'test', 'vitest run --allowOnly'],
    ['a reporter override', 'test', 'vitest run --reporter=dot'],
    ['a no-op test', 'test', 'true'],
    ['any extra argument (could change reporters or filtering)', 'test', 'vitest run --silent'],
    ['a different runner prefix', 'test', 'vitest run && echo done'],
  ])('rejects %s', async (_name, script, command) => {
    const scripts = { typecheck: TYPECHECK, test: 'vitest run', [script]: command };
    expect(codes(await check({ 'package.json': manifest({ scripts }) }))).toContain('bad-script');
  });
});

describe('tsconfig', () => {
  it('requires a tsconfig.json', async () => {
    expect(codes(await check({ 'tsconfig.json': null }))).toContain('missing-tsconfig');
  });

  it('requires extending the root tsconfig.base.json', async () => {
    const tsconfig = JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] });
    expect(codes(await check({ 'tsconfig.json': tsconfig }))).toContain(
      'tsconfig-not-extending-base',
    );
  });

  it('requires extending the root base directly, not another file that might weaken it', async () => {
    const result = await check({
      'tsconfig.local.json': JSON.stringify({ extends: '../../tsconfig.base.json' }),
      'tsconfig.json': JSON.stringify({
        extends: './tsconfig.local.json',
        include: ['src', 'vitest.config.ts'],
      }),
    });
    expect(codes(result)).toContain('tsconfig-not-extending-base');
  });

  it('rejects an extends array', async () => {
    const tsconfig = JSON.stringify({
      extends: ['../../tsconfig.base.json'],
      include: ['src', 'vitest.config.ts'],
    });
    expect(codes(await check({ 'tsconfig.json': tsconfig }))).toContain(
      'tsconfig-not-extending-base',
    );
  });

  it.each([
    'strict',
    'noUncheckedIndexedAccess',
    'exactOptionalPropertyTypes',
    'noImplicitOverride',
    'noImplicitReturns',
    'noFallthroughCasesInSwitch',
    'noUnusedLocals',
    'noUnusedParameters',
    'noPropertyAccessFromIndexSignature',
    'verbatimModuleSyntax',
    'isolatedModules',
    'erasableSyntaxOnly',
  ])('detects a package weakening %s in the effective config', async (flag) => {
    const tsconfig = JSON.stringify({
      extends: '../../tsconfig.base.json',
      compilerOptions: { [flag]: false },
      include: ['src', 'vitest.config.ts'],
    });
    const result = await check({ 'tsconfig.json': tsconfig });
    expect(codes(result)).toContain('weak-compiler-option');
    expect(result.map((v) => v.detail).join('\n')).toContain(flag);
  });

  it.each([
    'noImplicitAny',
    'strictNullChecks',
    'strictFunctionTypes',
    'strictBindCallApply',
    'strictPropertyInitialization',
    'noImplicitThis',
    'useUnknownInCatchVariables',
    'alwaysStrict',
  ])('detects strict staying on while %s is switched off', async (flag) => {
    const tsconfig = JSON.stringify({
      extends: '../../tsconfig.base.json',
      compilerOptions: { [flag]: false },
      include: ['src', 'vitest.config.ts'],
    });
    const result = await check({ 'tsconfig.json': tsconfig });
    expect(result.map((v) => v.detail).join('\n')).toContain(flag);
  });

  it('detects a package turning checking off with a looser strict', async () => {
    const tsconfig = JSON.stringify({
      extends: '../../tsconfig.base.json',
      compilerOptions: { strict: false, strictNullChecks: false },
      include: ['src'],
    });
    expect(codes(await check({ 'tsconfig.json': tsconfig }))).toContain('weak-compiler-option');
  });
});

describe('runtime environment', () => {
  const withEnvironment = (environment: unknown): string => manifest({ autogeek: { environment } });

  it('requires every package to declare its environment', async () => {
    const withoutBlock = validManifest();
    Reflect.deleteProperty(withoutBlock, 'autogeek');
    const result = await check({ 'package.json': JSON.stringify(withoutBlock) });
    expect(codes(result)).toContain('missing-environment');
  });

  it.each(['browser', 'both', '', 'Node'])('rejects the unknown environment %j', async (value) => {
    expect(codes(await check({ 'package.json': withEnvironment(value) }))).toContain(
      'bad-environment',
    );
  });

  it.each(['neutral', 'node', 'dom'] as const)('accepts a well-formed %s package', async (env) => {
    expect(await checkNamed('demo', packageFiles('demo', env))).toEqual([]);
  });

  it.each([
    ['core', 'node', 'neutral'],
    ['core', 'dom', 'neutral'],
    ['ui-kit', 'node', 'dom'],
    ['ui-kit', 'neutral', 'dom'],
    ['agent', 'dom', 'node'],
    ['auth', 'neutral', 'node'],
  ] as const)('rejects %s declared as %s (required: %s)', async (name, declared, required) => {
    const result = await checkNamed(name, packageFiles(name, declared));
    expect(codes(result)).toContain('wrong-environment');
    expect(result.map((v) => v.detail).join('\n')).toContain(required);
  });

  it.each([
    ['core', 'neutral'],
    ['ui-kit', 'dom'],
    ['agent', 'node'],
    ['permissions', 'node'],
  ] as const)('accepts %s as %s', async (name, env) => {
    expect(await checkNamed(name, packageFiles(name, env))).toEqual([]);
  });

  it.each([
    [
      'neutral',
      'a product tsconfig that adds node types',
      { lib: ['ES2023', 'WebWorker'], types: ['node'] },
    ],
    [
      'neutral',
      'a product tsconfig that adds the DOM lib',
      { lib: ['ES2023', 'WebWorker', 'DOM'], types: [] },
    ],
    ['neutral', 'a product tsconfig without the web-standard lib', { lib: ['ES2023'], types: [] }],
    [
      'dom',
      'a product tsconfig that adds node types',
      { lib: ['ES2023', 'DOM', 'DOM.Iterable'], types: ['node'] },
    ],
    ['dom', 'a product tsconfig without the DOM lib', { lib: ['ES2023'], types: [] }],
    ['node', 'a product tsconfig without node types', { lib: ['ES2023'], types: [] }],
    [
      'node',
      'a product tsconfig that adds the DOM lib',
      { lib: ['ES2023', 'DOM'], types: ['node'] },
    ],
    [
      'node',
      'a product tsconfig with extra ambient types',
      { lib: ['ES2023'], types: ['node', 'vitest/globals'] },
    ],
  ] as const)('detects %s declared with %s', async (env, _name, compilerOptions) => {
    const tsconfig = JSON.stringify({
      extends: '../../tsconfig.base.json',
      compilerOptions,
      include: ['src'],
      exclude: ['src/**/*.test.ts'],
    });
    const result = await checkNamed('demo', packageFiles('demo', env), {
      'tsconfig.json': tsconfig,
    });
    expect(codes(result)).toContain('environment-mismatch');
  });
});

describe('test tsconfig (tests and config get Node without leaking it into product code)', () => {
  it('requires tsconfig.test.json', async () => {
    expect(codes(await check({ 'tsconfig.test.json': null }))).toContain('missing-tsconfig');
  });

  it('requires it to extend the product tsconfig.json', async () => {
    const tsconfig = JSON.stringify({
      extends: '../../tsconfig.base.json',
      compilerOptions: { types: ['node'] },
      include: ['src', 'vitest.config.ts'],
    });
    expect(codes(await check({ 'tsconfig.test.json': tsconfig }))).toContain('test-config-gap');
  });

  it('requires Node types for tests', async () => {
    const tsconfig = JSON.stringify({
      extends: './tsconfig.json',
      include: ['src', 'vitest.config.ts'],
      exclude: [],
    });
    const result = await checkNamed('demo', packageFiles('demo', 'dom'), {
      'tsconfig.test.json': tsconfig,
    });
    expect(codes(result)).toContain('test-config-gap');
  });

  it('requires it to cover the test files and vitest.config.ts', async () => {
    const tsconfig = JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { types: ['node'] },
      include: ['src'],
      exclude: ['src/**/*.test.ts'],
    });
    expect(codes(await check({ 'tsconfig.test.json': tsconfig }))).toContain('test-config-gap');
  });

  it('keeps test files out of the product tsconfig', async () => {
    const tsconfig = JSON.stringify({
      extends: '../../tsconfig.base.json',
      compilerOptions: { types: ['node'] },
      include: ['src'],
    });
    expect(codes(await check({ 'tsconfig.json': tsconfig }))).toContain('tests-in-product-config');
  });

  it('applies the strictness flags to the test config too', async () => {
    const tsconfig = JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { types: ['node'], noUncheckedIndexedAccess: false },
      include: ['src', 'vitest.config.ts'],
      exclude: [],
    });
    const result = await check({ 'tsconfig.test.json': tsconfig });
    expect(codes(result)).toContain('weak-compiler-option');
    expect(result.map((v) => v.detail).join('\n')).toContain('tsconfig.test.json');
  });
});

describe('environment enforcement through the real compiler', () => {
  const execFileAsync = promisify(execFile);
  const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

  interface TscOutcome {
    readonly ok: boolean;
    readonly output: string;
  }

  async function runTsc(packageDir: string, project: string): Promise<TscOutcome> {
    return execFileAsync(process.execPath, [tsc, '--noEmit', '-p', project], {
      cwd: packageDir,
    }).then(
      (result) => ({ ok: true, output: result.stdout + result.stderr }),
      (failure: unknown) => {
        // tsc exits non-zero on type errors; the diagnostics are on stdout.
        if (typeof failure === 'object' && failure !== null && 'stdout' in failure) {
          const { stdout } = failure;
          if (typeof stdout === 'string') {
            return { ok: false, output: stdout };
          }
        }
        throw failure;
      },
    );
  }

  /** A real package from the fixture generator, with extra source files and the repo's node_modules. */
  async function fixture(
    env: Environment,
    sources: Readonly<Record<string, string>>,
  ): Promise<string> {
    const files = packageFiles('probe', env);
    await checkNamed('probe', files, {
      ...sources,
      // The probe's vitest.config.ts cannot resolve @autogeek/tooling outside the real workspace.
      'vitest.config.ts': 'export default {};\n',
    });
    const nodeModules = join(repo, 'node_modules');
    const linked = await lstat(nodeModules).then(
      () => true,
      () => false,
    );
    if (!linked) {
      await symlink(join(REPO_ROOT, 'node_modules'), nodeModules);
    }
    return join(repo, 'packages', 'probe');
  }

  const stray = {
    'process.env': "export const home = process.env['HOME'];\n",
    "import 'node:fs'": "import { readFileSync } from 'node:fs';\nexport const f = readFileSync;\n",
    Buffer: "export const b = Buffer.from('x');\n",
  };
  const web =
    'export const s: AbortSignal = AbortSignal.abort();\nexport const u = new URL("https://x.test");\n';

  describe.each(['neutral', 'dom'] as const)('a %s package', (env) => {
    it.each(Object.entries(stray))('fails typecheck on a stray %s', async (_name, source) => {
      const dir = await fixture(env, { 'src/stray.ts': source });
      const outcome = await runTsc(dir, 'tsconfig.json');
      expect(outcome.ok).toBe(false);
      expect(outcome.output).toMatch(/TS(2591|2580|2307|2304)/);
    });

    it('still gets the web-standard AbortSignal and URL', async () => {
      const dir = await fixture(env, { 'src/web.ts': web });
      expect((await runTsc(dir, 'tsconfig.json')).ok).toBe(true);
    });

    it('lets its tests and config use Node through tsconfig.test.json', async () => {
      const dir = await fixture(env, { 'src/probe.test.ts': stray['process.env'] });
      expect((await runTsc(dir, 'tsconfig.json')).ok).toBe(true);
      expect((await runTsc(dir, 'tsconfig.test.json')).ok).toBe(true);
    });
  });

  it.each([
    ['document', 'export const t = document.title;\n'],
    ['window', 'export const w = window.location;\n'],
    ['localStorage', "export const v = localStorage.getItem('k');\n"],
  ])('a neutral package has no DOM global %s', async (_name, source) => {
    const dir = await fixture('neutral', { 'src/dom.ts': source });
    const outcome = await runTsc(dir, 'tsconfig.json');
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toMatch(/TS(2304|2584|2591)/);
  });

  it('a dom package has the DOM', async () => {
    const dir = await fixture('dom', { 'src/dom.ts': 'export const t = document.title;\n' });
    expect((await runTsc(dir, 'tsconfig.json')).ok).toBe(true);
  });

  it('a node package has Node but not the DOM', async () => {
    const withNode = await fixture('node', { 'src/node.ts': stray['process.env'] });
    expect((await runTsc(withNode, 'tsconfig.json')).ok).toBe(true);
    const withDom = await fixture('node', { 'src/dom.ts': 'export const t = document.title;\n' });
    expect((await runTsc(withDom, 'tsconfig.json')).ok).toBe(false);
  });

  it('holds for the real ui-kit package: a stray process.env or node: import fails its typecheck', async () => {
    const probe = join(REPO_ROOT, 'packages', 'ui-kit');
    for (const source of Object.values(stray)) {
      const dir = await mkdtemp(join(tmpdir(), 'autogeek-real-env-'));
      await writeFile(join(dir, 'stray.ts'), source);
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          extends: join(probe, 'tsconfig.json'),
          include: [join(dir, 'stray.ts')],
          exclude: [],
        }),
      );
      const outcome = await runTsc(dir, 'tsconfig.json');
      expect(outcome.ok, source).toBe(false);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('vitest configuration', () => {
  it('requires a vitest.config.ts', async () => {
    expect(codes(await check({ 'vitest.config.ts': null }))).toContain('missing-vitest-config');
  });

  it('requires it to use the shared createVitestConfig factory', async () => {
    const own = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({});\n";
    expect(codes(await check({ 'vitest.config.ts': own }))).toContain('vitest-config-bypass');
  });

  const shared = "import { createVitestConfig } from '@autogeek/tooling/vitest';\n";

  it.each([
    [
      'B: its own defineConfig with createVitestConfig( only in a comment',
      "// createVitestConfig(\nimport { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['nothing/**'], passWithNoTests: true } });\n",
    ],
    [
      'B2: a string that contains createVitestConfig(',
      "import { defineConfig } from 'vitest/config';\nconst note = 'createVitestConfig(';\nexport default defineConfig({ test: { include: [note] } });\n",
    ],
    [
      'C: createVitestConfig with include and passWithNoTests options',
      `${shared}export default createVitestConfig({ include: ['nothing/**'], passWithNoTests: true });\n`,
    ],
    [
      'C2: options other than testTimeout',
      `${shared}export default createVitestConfig({ retry: 5 });\n`,
    ],
    [
      'C3: a non-literal testTimeout',
      `${shared}export default createVitestConfig({ testTimeout: Number('1') });\n`,
    ],
    [
      'a spread that can inject options',
      `${shared}const extra = { include: [] };\nexport default createVitestConfig({ ...extra });\n`,
    ],
    [
      'a side effect before the export',
      `${shared}process.exitCode = 0;\nexport default createVitestConfig();\n`,
    ],
    [
      'the result mutated after creation',
      `${shared}const config = createVitestConfig();\nconfig.test = {};\nexport default config;\n`,
    ],
    [
      'a config object that merely contains the call',
      `${shared}export default { ...createVitestConfig(), test: { include: [] } };\n`,
    ],
    [
      'a createVitestConfig imported from somewhere else',
      "import { createVitestConfig } from './fake.ts';\nexport default createVitestConfig();\n",
    ],
    [
      'an aliased import',
      "import { createVitestConfig as cfg } from '@autogeek/tooling/vitest';\nexport default cfg();\n",
    ],
    [
      'a statement after the export',
      `${shared}export default createVitestConfig();\nprocess.exitCode = 0;\n`,
    ],
    [
      'another export imported under the createVitestConfig name',
      "import { defineConfig as createVitestConfig } from '@autogeek/tooling/vitest';\nexport default createVitestConfig();\n",
    ],
    [
      'a type-only import',
      "import type { createVitestConfig } from '@autogeek/tooling/vitest';\nexport default createVitestConfig();\n",
    ],
    [
      'a named export instead of the default export',
      `${shared}export const config = createVitestConfig();\n`,
    ],
  ])('rejects a vitest.config.ts that bypasses the shared factory (%s)', async (_name, source) => {
    expect(codes(await check({ 'vitest.config.ts': source }))).toContain('vitest-config-bypass');
  });

  it.each([
    ['no options', `${shared}export default createVitestConfig();\n`],
    [
      'a literal testTimeout',
      `${shared}export default createVitestConfig({ testTimeout: 60_000 });\n`,
    ],
  ])('accepts a vitest.config.ts that is exactly the factory call (%s)', async (_name, source) => {
    expect(await check({ 'vitest.config.ts': source })).toEqual([]);
  });

  it.each(['vitest.workspace.ts', 'vitest.projects.ts', 'vitest.workspace.json'])(
    'forbids %s, which could define projects that skip the shared config',
    async (file) => {
      expect(codes(await check({ [file]: 'export default [];\n' }))).toContain(
        'forbidden-config-file',
      );
    },
  );
});

describe('other opt-out files', () => {
  it.each(['eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts', '.eslintrc.json'])(
    'forbids a package-level %s',
    async (file) => {
      expect(codes(await check({ [file]: 'export default [{}];\n' }))).toContain(
        'forbidden-config-file',
      );
    },
  );
});

describe('public surface shape (the boundary rules depend on it)', () => {
  it('requires packages/* to export their source entry point', async () => {
    const pkg = manifest({
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    });
    expect(codes(await check({ 'package.json': pkg }))).toContain('bad-exports');
  });

  it('requires packages/* to have exports at all', async () => {
    const withoutExports = validManifest();
    Reflect.deleteProperty(withoutExports, 'exports');
    expect(codes(await check({ 'package.json': JSON.stringify(withoutExports) }))).toContain(
      'bad-exports',
    );
  });

  it('requires src/index.ts', async () => {
    expect(codes(await check({ 'src/index.ts': null }))).toContain('bad-exports');
  });
});

describe('the real workspace', () => {
  it('has no policy violations in any package, app, or tooling', async () => {
    const directories = await listWorkspaceDirectories(REPO_ROOT);
    expect(directories).toContain('tooling');
    const violations = (
      await Promise.all(directories.map((dir) => checkPackage(REPO_ROOT, dir)))
    ).flat();
    expect(violations).toEqual([]);
  });
});
