import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

const validPackage: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({
    name: '@autogeek/demo',
    version: '0.0.0',
    private: true,
    type: 'module',
    exports: { '.': './src/index.ts' },
    scripts: { typecheck: 'tsc --noEmit -p tsconfig.json', test: 'vitest run' },
  }),
  'tsconfig.json': JSON.stringify({
    extends: '../../tsconfig.base.json',
    include: ['src', 'vitest.config.ts'],
  }),
  'vitest.config.ts':
    "import { createVitestConfig } from '@autogeek/tooling/vitest';\nexport default createVitestConfig();\n",
  'src/index.ts': 'export {};\n',
  'src/index.test.ts': "import { it } from 'vitest';\nit('loads', () => undefined);\n",
};

/** Writes packages/demo with `overrides` applied (a null value deletes the file). */
async function check(
  overrides: Readonly<Record<string, string | null>> = {},
): Promise<PackageViolation[]> {
  const files = { ...validPackage, ...overrides };
  for (const [name, content] of Object.entries(files)) {
    if (content === null) {
      continue;
    }
    const target = join(repo, 'packages', 'demo', name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await mkdir(join(repo, 'packages', 'demo'), { recursive: true });
  return checkPackage(repo, 'packages/demo');
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
});

describe('scripts (a package without them is silently skipped by `turbo run`)', () => {
  it.each(['typecheck', 'test'])('requires a %s script', async (script) => {
    const scripts: Record<string, string> = {
      typecheck: 'tsc --noEmit -p tsconfig.json',
      test: 'vitest run',
    };
    Reflect.deleteProperty(scripts, script);
    expect(codes(await check({ 'package.json': manifest({ scripts }) }))).toContain(
      'missing-script',
    );
  });

  it.each([
    ['a typecheck that does not run tsc', 'typecheck', 'echo ok'],
    ['a typecheck that emits', 'typecheck', 'tsc -p tsconfig.json'],
    ['watch mode', 'test', 'vitest'],
    ['passWithNoTests', 'test', 'vitest run --passWithNoTests'],
    ['allowOnly', 'test', 'vitest run --allowOnly'],
    ['a reporter override', 'test', 'vitest run --reporter=dot'],
    ['a no-op test', 'test', 'true'],
    ['any extra argument (could change reporters or filtering)', 'test', 'vitest run --silent'],
    ['a different runner prefix', 'test', 'vitest run && echo done'],
  ])('rejects %s', async (_name, script, command) => {
    const scripts = {
      typecheck: 'tsc --noEmit -p tsconfig.json',
      test: 'vitest run',
      [script]: command,
    };
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

describe('vitest configuration', () => {
  it('requires a vitest.config.ts', async () => {
    expect(codes(await check({ 'vitest.config.ts': null }))).toContain('missing-vitest-config');
  });

  it('requires it to use the shared createVitestConfig factory', async () => {
    const own = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({});\n";
    expect(codes(await check({ 'vitest.config.ts': own }))).toContain('vitest-config-bypass');
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
