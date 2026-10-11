import { access, readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';

export type PackageViolationCode =
  | 'not-a-package'
  | 'bad-name'
  | 'not-private'
  | 'missing-script'
  | 'bad-script'
  | 'missing-tsconfig'
  | 'tsconfig-not-extending-base'
  | 'weak-compiler-option'
  | 'missing-vitest-config'
  | 'vitest-config-bypass'
  | 'forbidden-config-file'
  | 'bad-exports';

export interface PackageViolation {
  readonly dir: string;
  readonly code: PackageViolationCode;
  readonly detail: string;
}

const ManifestSchema = z.object({
  name: z.string().optional(),
  private: z.boolean().optional(),
  exports: z.json().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});
type Manifest = z.infer<typeof ManifestSchema>;

/** Only `extends` is read from the raw tsconfig; the effective options come from the TS API. */
const TsconfigSchema = z.looseObject({ extends: z.unknown().optional() });

/** Compiler flags that must be on (`=== true`) in every package's effective config. */
const REQUIRED_FLAGS = [
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
] as const;

/** The members of `strict`; each defaults to the value of `strict` unless set explicitly. */
const STRICT_FAMILY = [
  'noImplicitAny',
  'strictNullChecks',
  'strictFunctionTypes',
  'strictBindCallApply',
  'strictPropertyInitialization',
  'noImplicitThis',
  'useUnknownInCatchVariables',
  'alwaysStrict',
] as const;

const FORBIDDEN_FILES = /^(vitest\.(workspace|projects)\..+|eslint\.config\..+|\.eslintrc.*)$/;

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function readManifest(root: string, dir: string): Promise<Manifest | undefined> {
  const path = join(root, dir, 'package.json');
  if (!(await exists(path))) {
    return undefined;
  }
  return ManifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

/** `tooling` plus every directory under `apps/` and `packages/`. */
export async function listWorkspaceDirectories(root: string): Promise<string[]> {
  const directories = ['tooling'];
  for (const group of ['apps', 'packages']) {
    const entries = await readdir(join(root, group), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        directories.push(`${group}/${entry.name}`);
      }
    }
  }
  return directories;
}

function checkIdentity(dir: string, manifest: Manifest): PackageViolation[] {
  const expected = `@autogeek/${basename(dir)}`;
  const violations: PackageViolation[] = [];
  if (manifest.name !== expected) {
    violations.push({ dir, code: 'bad-name', detail: `name must be ${expected}` });
  }
  if (manifest.private !== true) {
    violations.push({ dir, code: 'not-private', detail: 'package must be private' });
  }
  return violations;
}

function checkScripts(dir: string, manifest: Manifest): PackageViolation[] {
  const scripts = manifest.scripts ?? {};
  const violations: PackageViolation[] = [];
  const typecheck = scripts['typecheck'];
  const test = scripts['test'];
  if (typecheck === undefined) {
    violations.push({ dir, code: 'missing-script', detail: 'no typecheck script' });
  } else if (!/(^|\s)tsc(\s|$)/.test(typecheck) || !typecheck.includes('--noEmit')) {
    violations.push({
      dir,
      code: 'bad-script',
      detail: `typecheck must run tsc --noEmit: ${typecheck}`,
    });
  }
  if (test === undefined) {
    violations.push({ dir, code: 'missing-script', detail: 'no test script' });
  } else if (test !== 'vitest run') {
    // Exactly `vitest run`: a --reporter flag replaces the configured reporters and would drop
    // the FailOnSkippedReporter, and --passWithNoTests / --allowOnly weaken other gates.
    violations.push({
      dir,
      code: 'bad-script',
      detail: `test must be exactly "vitest run": ${test}`,
    });
  }
  return violations;
}

function checkTsconfig(root: string, dir: string): PackageViolation[] {
  const configPath = join(root, dir, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (read.error !== undefined) {
    return [{ dir, code: 'missing-tsconfig', detail: 'tsconfig.json is missing or unreadable' }];
  }
  const extendsField = TsconfigSchema.parse(read.config).extends;
  const base = resolve(root, 'tsconfig.base.json');
  if (typeof extendsField !== 'string' || resolve(root, dir, extendsField) !== base) {
    return [
      {
        dir,
        code: 'tsconfig-not-extending-base',
        detail: 'tsconfig.json must extend the root tsconfig.base.json',
      },
    ];
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    join(root, dir),
    undefined,
    configPath,
  );
  const options = parsed.options;
  const violations: PackageViolation[] = [];
  for (const flag of REQUIRED_FLAGS) {
    if (options[flag] !== true) {
      violations.push({
        dir,
        code: 'weak-compiler-option',
        detail: `${flag} must be true in the effective config`,
      });
    }
  }
  for (const flag of STRICT_FAMILY) {
    if ((options[flag] ?? options.strict) !== true) {
      violations.push({ dir, code: 'weak-compiler-option', detail: `${flag} is effectively off` });
    }
  }
  return violations;
}

async function checkVitest(root: string, dir: string): Promise<PackageViolation[]> {
  const path = join(root, dir, 'vitest.config.ts');
  if (!(await exists(path))) {
    return [{ dir, code: 'missing-vitest-config', detail: 'vitest.config.ts is required' }];
  }
  if (!(await readFile(path, 'utf8')).includes('createVitestConfig(')) {
    return [
      {
        dir,
        code: 'vitest-config-bypass',
        detail: 'vitest.config.ts must use createVitestConfig()',
      },
    ];
  }
  return [];
}

async function checkForbiddenFiles(root: string, dir: string): Promise<PackageViolation[]> {
  const entries = await readdir(join(root, dir));
  return entries
    .filter((name) => FORBIDDEN_FILES.test(name))
    .map((name) => ({
      dir,
      code: 'forbidden-config-file',
      detail: `${name} could opt this package out of the shared policy`,
    }));
}

async function checkSurface(
  root: string,
  dir: string,
  manifest: Manifest,
): Promise<PackageViolation[]> {
  const bad = (detail: string): PackageViolation[] => [{ dir, code: 'bad-exports', detail }];
  const exportsField = JSON.stringify(manifest.exports);
  if (dir.startsWith('packages/')) {
    if (exportsField !== JSON.stringify({ '.': './src/index.ts' })) {
      return bad(
        'exports must be exactly {".": "./src/index.ts"} (the boundary rules rely on source exports)',
      );
    }
    return (await exists(join(root, dir, 'src', 'index.ts'))) ? [] : bad('src/index.ts is missing');
  }
  if (dir === 'tooling') {
    const allowed = JSON.stringify({ './vitest': './src/vitest/config.ts' });
    return manifest.exports === undefined || exportsField === allowed
      ? []
      : bad('tooling may only export ./vitest');
  }
  return manifest.exports === undefined ? [] : bad('apps must not declare exports');
}

/** Checks one workspace directory against the shared policy and returns every violation found. */
export async function checkPackage(root: string, dir: string): Promise<PackageViolation[]> {
  const manifest = await readManifest(root, dir);
  if (manifest === undefined) {
    return [{ dir, code: 'not-a-package', detail: `${dir} has no package.json` }];
  }
  return [
    ...checkIdentity(dir, manifest),
    ...checkScripts(dir, manifest),
    ...checkTsconfig(root, dir),
    ...(await checkVitest(root, dir)),
    ...(await checkForbiddenFiles(root, dir)),
    ...(await checkSurface(root, dir, manifest)),
  ];
}
