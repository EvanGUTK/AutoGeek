import { access, readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import type { PackageName } from './dependency-rules.ts';

export type PackageViolationCode =
  | 'not-a-package'
  | 'bad-name'
  | 'not-private'
  | 'missing-script'
  | 'bad-script'
  | 'missing-tsconfig'
  | 'tsconfig-not-extending-base'
  | 'missing-environment'
  | 'bad-environment'
  | 'wrong-environment'
  | 'environment-mismatch'
  | 'environment-leak'
  | 'tests-in-product-config'
  | 'test-config-gap'
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
  autogeek: z.looseObject({ environment: z.unknown().optional() }).optional(),
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

export const ENVIRONMENTS = ['neutral', 'node', 'dom'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * Which runtime each known package targets. `core` is imported by main AND the untrusted
 * renderer, so it is neutral; `ui-kit` is renderer-only. A package missing from this table (a new
 * one) cannot compile until it has an entry, because the type is exhaustive over PackageName.
 */
export const REQUIRED_ENVIRONMENTS: Readonly<Record<PackageName | 'tooling', Environment>> = {
  core: 'neutral',
  'ui-kit': 'dom',
  auth: 'node',
  providers: 'node',
  agent: 'node',
  tools: 'node',
  mcp: 'node',
  workspace: 'node',
  permissions: 'node',
  tooling: 'node',
};

interface CompilerExpectation {
  readonly lib: readonly string[];
  readonly types: readonly string[];
}

/**
 * Product compiler environment per runtime. `neutral` is ES plus the web-standard APIs both Node
 * and browsers provide (AbortSignal, URL, ...) via the WebWorker lib, with no Node and no DOM.
 *
 * Known gap: the WebWorker lib also declares worker-only globals such as `self`,
 * `importScripts` and `postMessage`, which exist in neither Node main nor the renderer window.
 * TypeScript has no narrower "web platform" lib, so a stray `self.` in neutral code is not
 * caught by the compiler. Code review and the neutral package's own tests are the backstop.
 */
const PRODUCT_ENVIRONMENT: Readonly<Record<Environment, CompilerExpectation>> = {
  neutral: { lib: ['lib.es2023.d.ts', 'lib.webworker.d.ts'], types: [] },
  node: { lib: ['lib.es2023.d.ts'], types: ['node'] },
  dom: { lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: [] },
};

const TYPECHECK_SCRIPT = 'tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json';

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
  } else if (typecheck !== TYPECHECK_SCRIPT) {
    violations.push({
      dir,
      code: 'bad-script',
      detail: `typecheck must be exactly "${TYPECHECK_SCRIPT}": ${typecheck}`,
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

interface LoadedTsconfig {
  readonly parsed: ts.ParsedCommandLine;
  readonly extendsField: unknown;
}

function loadTsconfig(root: string, dir: string, name: string): LoadedTsconfig | undefined {
  const configPath = join(root, dir, name);
  const read = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (read.error !== undefined) {
    return undefined;
  }
  return {
    parsed: ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      join(root, dir),
      undefined,
      configPath,
    ),
    extendsField: TsconfigSchema.parse(read.config).extends,
  };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** Every strictness flag must survive in the EFFECTIVE config of `name`. */
function checkStrictness(
  dir: string,
  name: string,
  options: ts.CompilerOptions,
): PackageViolation[] {
  const violations: PackageViolation[] = [];
  for (const flag of REQUIRED_FLAGS) {
    if (options[flag] !== true) {
      violations.push({
        dir,
        code: 'weak-compiler-option',
        detail: `${name}: ${flag} must be true in the effective config`,
      });
    }
  }
  for (const flag of STRICT_FAMILY) {
    if ((options[flag] ?? options.strict) !== true) {
      violations.push({
        dir,
        code: 'weak-compiler-option',
        detail: `${name}: ${flag} is effectively off`,
      });
    }
  }
  return violations;
}

function checkProductTsconfig(
  root: string,
  dir: string,
  environment: Environment | undefined,
): { violations: PackageViolation[]; options?: ts.CompilerOptions } {
  const loaded = loadTsconfig(root, dir, 'tsconfig.json');
  if (loaded === undefined) {
    return {
      violations: [
        { dir, code: 'missing-tsconfig', detail: 'tsconfig.json is missing or unreadable' },
      ],
    };
  }
  const base = resolve(root, 'tsconfig.base.json');
  if (typeof loaded.extendsField !== 'string' || resolve(root, dir, loaded.extendsField) !== base) {
    return {
      violations: [
        {
          dir,
          code: 'tsconfig-not-extending-base',
          detail: 'tsconfig.json must extend the root tsconfig.base.json',
        },
      ],
    };
  }
  const { options, fileNames } = loaded.parsed;
  const violations = checkStrictness(dir, 'tsconfig.json', options);
  if (environment !== undefined) {
    const expected = PRODUCT_ENVIRONMENT[environment];
    if (
      !sameSet(options.lib ?? [], expected.lib) ||
      !sameSet(options.types ?? [], expected.types)
    ) {
      violations.push({
        dir,
        code: 'environment-mismatch',
        detail:
          `tsconfig.json does not match environment "${environment}": ` +
          `lib must be [${expected.lib.join(', ')}] and types [${expected.types.join(', ')}]`,
      });
    }
  }
  if (fileNames.some((file) => /\.(test|spec)\.[cm]?tsx?$/.test(file))) {
    violations.push({
      dir,
      code: 'tests-in-product-config',
      detail: 'tsconfig.json must exclude test files; they belong to tsconfig.test.json',
    });
  }
  return { violations, options };
}

async function listTestFiles(root: string, dir: string): Promise<string[]> {
  const entries = await readdir(join(root, dir, 'src'), { recursive: true });
  return entries
    .filter((entry) => /\.(test|spec)\.[cm]?tsx?$/.test(entry))
    .map((entry) => resolve(root, dir, 'src', entry));
}

async function checkTestTsconfig(
  root: string,
  dir: string,
  product: ts.CompilerOptions | undefined,
): Promise<PackageViolation[]> {
  const loaded = loadTsconfig(root, dir, 'tsconfig.test.json');
  if (loaded === undefined) {
    return [
      { dir, code: 'missing-tsconfig', detail: 'tsconfig.test.json is missing or unreadable' },
    ];
  }
  const gap = (detail: string): PackageViolation => ({ dir, code: 'test-config-gap', detail });
  if (
    typeof loaded.extendsField !== 'string' ||
    resolve(root, dir, loaded.extendsField) !== resolve(root, dir, 'tsconfig.json')
  ) {
    return [gap('tsconfig.test.json must extend ./tsconfig.json')];
  }
  const { options, fileNames } = loaded.parsed;
  const violations = checkStrictness(dir, 'tsconfig.test.json', options);
  if (!sameSet(options.types ?? [], ['node'])) {
    violations.push(gap('tsconfig.test.json must set types to ["node"] for tests and config'));
  }
  if (product !== undefined && !sameSet(options.lib ?? [], product.lib ?? [])) {
    violations.push(gap('tsconfig.test.json must keep the product lib'));
  }
  const covered = new Set(fileNames.map((file) => resolve(file)));
  const required = [resolve(root, dir, 'vitest.config.ts'), ...(await listTestFiles(root, dir))];
  for (const file of required) {
    if (!covered.has(file)) {
      violations.push(
        gap(`tsconfig.test.json does not include ${file.slice(resolve(root, dir).length + 1)}`),
      );
    }
  }
  return violations;
}

type EnvironmentCheck =
  | { readonly violations: PackageViolation[]; readonly environment: undefined }
  | { readonly violations: PackageViolation[]; readonly environment: Environment };

/** Reads the declared environment and checks it against the per-package requirement table. */
function checkEnvironment(dir: string, manifest: Manifest): EnvironmentCheck {
  const declared = manifest.autogeek?.environment;
  if (declared === undefined) {
    return {
      environment: undefined,
      violations: [
        { dir, code: 'missing-environment', detail: 'package.json needs autogeek.environment' },
      ],
    };
  }
  const parsed = z.enum(ENVIRONMENTS).safeParse(declared);
  if (!parsed.success) {
    return {
      environment: undefined,
      violations: [
        {
          dir,
          code: 'bad-environment',
          detail: `autogeek.environment must be one of ${ENVIRONMENTS.join(', ')}`,
        },
      ],
    };
  }
  const name = basename(dir);
  const required = (REQUIRED_ENVIRONMENTS as Readonly<Record<string, Environment | undefined>>)[
    name
  ];
  const violations: PackageViolation[] =
    required !== undefined && required !== parsed.data
      ? [
          {
            dir,
            code: 'wrong-environment',
            detail: `${name} must be "${required}", not "${parsed.data}"`,
          },
        ]
      : [];
  return { environment: parsed.data, violations };
}

/** Module that exports the shared factory, as imported from a package's vitest.config.ts. */
function vitestFactorySpecifier(dir: string): string {
  return dir === 'tooling' ? './src/vitest/config.ts' : '@autogeek/tooling/vitest';
}

/**
 * True only for a vitest.config.ts that is EXACTLY
 *   import { createVitestConfig } from '<shared module>';
 *   export default createVitestConfig();            // or ({ testTimeout: <number literal> })
 * Anything else (extra statements, aliases, other call arguments, a comment or string that merely
 * contains the name) could change what runs, so it is rejected structurally, not by substring.
 */
function isSharedVitestConfig(source: string, specifier: string): boolean {
  const file = ts.createSourceFile('vitest.config.ts', source, ts.ScriptTarget.Latest, true);
  const [importStatement, exportStatement, ...rest] = file.statements;
  if (importStatement === undefined || exportStatement === undefined || rest.length > 0) {
    return false;
  }
  if (
    !ts.isImportDeclaration(importStatement) ||
    !ts.isStringLiteral(importStatement.moduleSpecifier) ||
    importStatement.moduleSpecifier.text !== specifier ||
    importStatement.attributes !== undefined
  ) {
    return false;
  }
  const clause = importStatement.importClause;
  const bindings = clause?.namedBindings;
  if (
    clause === undefined ||
    clause.phaseModifier !== undefined ||
    clause.name !== undefined ||
    bindings === undefined ||
    !ts.isNamedImports(bindings) ||
    bindings.elements.length !== 1
  ) {
    return false;
  }
  const [element] = bindings.elements;
  if (
    element === undefined ||
    element.isTypeOnly ||
    element.propertyName !== undefined ||
    element.name.text !== 'createVitestConfig'
  ) {
    return false;
  }
  if (!ts.isExportAssignment(exportStatement) || exportStatement.isExportEquals === true) {
    return false;
  }
  const call = exportStatement.expression;
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== 'createVitestConfig' ||
    call.typeArguments !== undefined ||
    call.questionDotToken !== undefined
  ) {
    return false;
  }
  const [argument, ...extra] = call.arguments;
  if (argument === undefined) {
    return true;
  }
  return extra.length === 0 && isTestTimeoutLiteral(argument);
}

function isTestTimeoutLiteral(node: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(node) || node.properties.length !== 1) {
    return false;
  }
  const [property] = node.properties;
  return (
    property !== undefined &&
    ts.isPropertyAssignment(property) &&
    ts.isIdentifier(property.name) &&
    property.name.text === 'testTimeout' &&
    ts.isNumericLiteral(property.initializer)
  );
}

async function checkVitest(root: string, dir: string): Promise<PackageViolation[]> {
  const path = join(root, dir, 'vitest.config.ts');
  if (!(await exists(path))) {
    return [{ dir, code: 'missing-vitest-config', detail: 'vitest.config.ts is required' }];
  }
  if (!isSharedVitestConfig(await readFile(path, 'utf8'), vitestFactorySpecifier(dir))) {
    return [
      {
        dir,
        code: 'vitest-config-bypass',
        detail:
          'vitest.config.ts must be exactly `import { createVitestConfig } from "<shared module>"; ' +
          'export default createVitestConfig();` (optionally with a literal testTimeout)',
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
    return [
      {
        dir,
        code: 'not-a-package',
        detail:
          `${dir} has no package.json. If this directory is a leftover from switching branches ` +
          '(only untracked output such as node_modules or .turbo), remove it; otherwise add the manifest.',
      },
    ];
  }
  const environment = checkEnvironment(dir, manifest);
  const product = checkProductTsconfig(root, dir, environment.environment);
  return [
    ...checkIdentity(dir, manifest),
    ...checkScripts(dir, manifest),
    ...environment.violations,
    ...product.violations,
    ...(await checkTestTsconfig(root, dir, product.options)),
    ...(await checkVitest(root, dir)),
    ...(await checkForbiddenFiles(root, dir)),
    ...(await checkSurface(root, dir, manifest)),
  ];
}

export type LeakKind = 'node' | 'dom';

/** Per package directory: kinds of leak it may have, each with the reason it was reviewed. */
export type EnvironmentLeakExceptions = Readonly<
  Record<string, Partial<Readonly<Record<LeakKind, string>>>>
>;

/**
 * Explicit, reviewed exceptions. Empty on purpose: adding an entry (a dependency whose typings
 * legitimately reference Node, say) needs the reason written here and the chief's approval.
 */
export const ENVIRONMENT_LEAK_EXCEPTIONS: EnvironmentLeakExceptions = {};

/** Which global typings each environment must NOT resolve into its product program. */
const FORBIDDEN_LEAKS: Readonly<Record<Environment, readonly LeakKind[]>> = {
  neutral: ['node', 'dom'],
  dom: ['node'],
  node: ['dom'],
};

const NODE_TYPES = /[\\/]@types[\\/]node[\\/]/;
const DOM_LIB = /^lib\.dom(\.[a-z]+)*\.d\.ts$/;

function leakOf(file: string): LeakKind | undefined {
  if (NODE_TYPES.test(file)) {
    return 'node';
  }
  return DOM_LIB.test(basename(file)) ? 'dom' : undefined;
}

/**
 * Builds the TypeScript program of the package's PRODUCT tsconfig and checks which global typings
 * it really resolves, so a leak cannot hide behind a `/// <reference>` directive or a dependency's
 * .d.ts. This complements the lint ban on directives and the lib/types comparison, and catches
 * transitive leaks neither can see. It creates a full program, so it is separate from
 * `checkPackage` (which runs hundreds of times in fixtures) and is called per real package.
 */
export async function checkEnvironmentLeaks(
  root: string,
  dir: string,
  exceptions: EnvironmentLeakExceptions = ENVIRONMENT_LEAK_EXCEPTIONS,
): Promise<PackageViolation[]> {
  const manifest = await readManifest(root, dir);
  const environment =
    manifest === undefined ? undefined : checkEnvironment(dir, manifest).environment;
  const loaded = loadTsconfig(root, dir, 'tsconfig.json');
  if (environment === undefined || loaded === undefined) {
    return []; // checkPackage reports a missing or invalid environment / tsconfig
  }
  const program = ts.createProgram({
    rootNames: loaded.parsed.fileNames,
    options: loaded.parsed.options,
  });
  const forbidden = FORBIDDEN_LEAKS[environment];
  const violations: PackageViolation[] = [];
  for (const kind of forbidden) {
    const reason = exceptions[dir]?.[kind];
    if (reason !== undefined && reason.length > 0) {
      continue;
    }
    const file = program
      .getSourceFiles()
      .map((source) => source.fileName)
      .find((name) => leakOf(name) === kind);
    if (file !== undefined) {
      violations.push({
        dir,
        code: 'environment-leak',
        detail: `${dir} is "${environment}" but its program resolves ${kind} typings (${file})`,
      });
    }
  }
  return violations;
}
