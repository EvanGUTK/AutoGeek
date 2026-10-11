import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_NAMES, PACKAGE_NAMES } from './dependency-rules.ts';
import { z } from 'zod';

type Files = Readonly<Record<string, string>>;

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DEPCRUISE_CONFIG = join(REPO_ROOT, '.dependency-cruiser.mjs');
const DEPCRUISE_BIN = join(
  dirname(fileURLToPath(import.meta.resolve('dependency-cruiser'))),
  '..',
  '..',
  'bin',
  'dependency-cruiser.mjs',
);

const CruiseReport = z.object({
  summary: z.object({
    violations: z.array(
      z.object({
        rule: z.object({ name: z.string() }),
        from: z.string(),
        to: z.string(),
      }),
    ),
  }),
});

let sandbox: string;

beforeEach(async () => {
  expect(existsSync(DEPCRUISE_BIN), `missing ${DEPCRUISE_BIN}`).toBe(true);
  sandbox = await mkdtemp(join(tmpdir(), 'autogeek-deps-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function writeTree(files: Files): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(sandbox, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

/** Mimics pnpm's workspace linking: `<consumer>/node_modules/<name>` -> `<provider>`. */
async function linkWorkspacePackage(
  consumer: string,
  name: string,
  provider: string,
): Promise<void> {
  const linkPath = join(sandbox, consumer, 'node_modules', name);
  await mkdir(dirname(linkPath), { recursive: true });
  await symlink(relative(dirname(linkPath), join(sandbox, provider)), linkPath);
}

/**
 * Runs the real `depcruise` CLI with the repo config inside a fixture tree (the same invocation
 * `pnpm lint:deps` uses) and returns "rule: from -> to" lines for every violation.
 */
async function violationsFor(files: Files): Promise<string[]> {
  await writeTree({ 'package.json': '{"name":"fixture","private":true}', ...files });
  const roots = ['apps', 'packages', 'tooling'];
  await Promise.all(roots.map((root) => mkdir(join(sandbox, root), { recursive: true })));
  const args = [DEPCRUISE_BIN, '--config', DEPCRUISE_CONFIG, '--output-type', 'json', ...roots];
  const stdout = await execFileAsync(process.execPath, args, { cwd: sandbox }).then(
    (result) => result.stdout,
    (failure: unknown) => {
      // depcruise exits non-zero when it reports errors; its JSON report is still on stdout.
      if (isExecFailure(failure) && failure.stdout.trimStart().startsWith('{')) {
        return failure.stdout;
      }
      throw failure;
    },
  );
  const report = CruiseReport.parse(JSON.parse(stdout));
  return report.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`);
}

function isExecFailure(value: unknown): value is { stdout: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'stdout' in value &&
    typeof value.stdout === 'string'
  );
}

const exported = 'export const x = 1;\n';
const importer = (specifier: string): string =>
  `import { x } from '${specifier}';\nexport const y = x;\n`;

describe('allowed dependencies', () => {
  it.each([
    ['desktop -> core', 'apps/desktop/src/main.ts', '../../../packages/core/src/index.ts'],
    ['desktop -> agent', 'apps/desktop/src/main.ts', '../../../packages/agent/src/index.ts'],
    ['permissions -> core', 'packages/permissions/src/index.ts', '../../core/src/index.ts'],
    ['providers -> auth', 'packages/providers/src/index.ts', '../../auth/src/index.ts'],
    ['tools -> workspace', 'packages/tools/src/index.ts', '../../workspace/src/index.ts'],
    ['tools -> permissions', 'packages/tools/src/index.ts', '../../permissions/src/index.ts'],
    ['agent -> providers', 'packages/agent/src/index.ts', '../../providers/src/index.ts'],
    ['mcp -> permissions', 'packages/mcp/src/index.ts', '../../permissions/src/index.ts'],
    ['ui-kit -> core', 'packages/ui-kit/src/index.ts', '../../core/src/index.ts'],
  ])('%s', async (_name, from, specifier) => {
    const target = join(dirname(from), specifier);
    const violations = await violationsFor({
      [from]: importer(specifier),
      [target]: exported,
    });
    expect(violations).toEqual([]);
  });

  it('a package may import its own internals', async () => {
    const violations = await violationsFor({
      'packages/core/src/index.ts': importer('./internal/helper.ts'),
      'packages/core/src/internal/helper.ts': exported,
    });
    expect(violations).toEqual([]);
  });
});

describe('forbidden dependencies', () => {
  it.each([
    [
      'core -> auth',
      'packages/core/src/index.ts',
      '../../auth/src/index.ts',
      'layer-violation-core',
    ],
    [
      'auth -> providers',
      'packages/auth/src/index.ts',
      '../../providers/src/index.ts',
      'layer-violation-auth',
    ],
    [
      'permissions -> tools',
      'packages/permissions/src/index.ts',
      '../../tools/src/index.ts',
      'layer-violation-permissions',
    ],
    [
      'workspace -> agent',
      'packages/workspace/src/index.ts',
      '../../agent/src/index.ts',
      'layer-violation-workspace',
    ],
    [
      'tools -> agent',
      'packages/tools/src/index.ts',
      '../../agent/src/index.ts',
      'layer-violation-tools',
    ],
    [
      'agent -> tools',
      'packages/agent/src/index.ts',
      '../../tools/src/index.ts',
      'layer-violation-agent',
    ],
    [
      'mcp -> workspace',
      'packages/mcp/src/index.ts',
      '../../workspace/src/index.ts',
      'layer-violation-mcp',
    ],
    [
      'ui-kit -> agent',
      'packages/ui-kit/src/index.ts',
      '../../agent/src/index.ts',
      'layer-violation-ui-kit',
    ],
  ])('%s', async (_name, from, specifier, rule) => {
    const target = join(dirname(from), specifier);
    const violations = await violationsFor({
      [from]: importer(specifier),
      [target]: exported,
    });
    expect(violations).toEqual([`${rule}: ${from} -> ${target}`]);
  });

  it('a package importing apps/desktop', async () => {
    const violations = await violationsFor({
      'packages/core/src/index.ts': importer('../../../apps/desktop/src/main.ts'),
      'apps/desktop/src/main.ts': exported,
    });
    expect(violations.map((v) => v.split(':')[0])).toContain('no-import-of-apps');
  });

  it('tooling importing a package', async () => {
    const violations = await violationsFor({
      'tooling/src/index.ts': importer('../../packages/core/src/index.ts'),
      'packages/core/src/index.ts': exported,
    });
    expect(violations.map((v) => v.split(':')[0])).toContain('tooling-imports-nothing');
  });

  it('a package importing tooling', async () => {
    const violations = await violationsFor({
      'packages/core/src/index.ts': importer('../../../tooling/src/index.ts'),
      'tooling/src/index.ts': exported,
    });
    expect(violations.map((v) => v.split(':')[0])).toContain('nothing-imports-tooling');
  });

  it('reaching into another package internals instead of its index', async () => {
    const violations = await violationsFor({
      'packages/agent/src/index.ts': importer('../../providers/src/internal/secret.ts'),
      'packages/providers/src/internal/secret.ts': exported,
    });
    expect(violations).toEqual([
      'public-api-only: packages/agent/src/index.ts -> packages/providers/src/internal/secret.ts',
    ]);
  });

  it('the desktop app reaching into package internals', async () => {
    const violations = await violationsFor({
      'apps/desktop/src/main.ts': importer('../../../packages/core/src/internal/x.ts'),
      'packages/core/src/internal/x.ts': exported,
    });
    expect(violations).toEqual([
      'public-api-only: apps/desktop/src/main.ts -> packages/core/src/internal/x.ts',
    ]);
  });

  it('circular imports inside a package', async () => {
    const violations = await violationsFor({
      'packages/core/src/index.ts': importer('./a.ts'),
      'packages/core/src/a.ts': "import { y } from './b.ts';\nexport const x = y;\n",
      'packages/core/src/b.ts': "import { x } from './a.ts';\nexport const y = x;\n",
    });
    expect(violations.some((v) => v.startsWith('no-circular:'))).toBe(true);
  });

  it('unresolvable imports', async () => {
    const violations = await violationsFor({
      'packages/core/src/index.ts': importer('./does-not-exist.ts'),
    });
    expect(violations.map((v) => v.split(':')[0])).toContain('not-to-unresolvable');
  });

  it('npm packages missing from package.json', async () => {
    const violations = await violationsFor({
      'packages/core/package.json': '{"name":"@autogeek/core","dependencies":{}}',
      'packages/core/src/index.ts': "import { lib } from 'fake-lib';\nexport const y = lib;\n",
      'packages/core/node_modules/fake-lib/package.json':
        '{"name":"fake-lib","version":"1.0.0","main":"index.js"}',
      'packages/core/node_modules/fake-lib/index.js': 'exports.lib = 1;\n',
    });
    expect(violations.map((v) => v.split(':')[0])).toContain('no-undeclared-dependencies');
  });
});

describe('circumventions of the dependency rules', () => {
  const consumer = {
    'packages/agent/package.json':
      '{"name":"@autogeek/agent","dependencies":{"@autogeek/tools":"workspace:*"}}',
    'packages/agent/src/index.ts': "import { x } from '@autogeek/tools';\nexport const y = x;\n",
    'packages/tools/src/index.ts': 'export const x = 1;\n',
    'packages/tools/dist/index.js': 'export const x = 1;\n',
  };

  it('an undeclared npm package whose entry point lives under dist/ is still reported', async () => {
    const violations = await violationsFor({
      'packages/core/package.json': '{"name":"@autogeek/core","dependencies":{}}',
      'packages/core/src/index.ts': "import { lib } from 'fake-dist-lib';\nexport const y = lib;\n",
      'packages/core/node_modules/fake-dist-lib/package.json':
        '{"name":"fake-dist-lib","version":"1.0.0","main":"dist/index.js"}',
      'packages/core/node_modules/fake-dist-lib/dist/index.js': 'exports.lib = 1;\n',
    });
    expect(violations.map((v) => v.split(':')[0])).toContain('no-undeclared-dependencies');
  });

  it('a bare @autogeek import through a workspace link is caught when exports point at src', async () => {
    await writeTree({
      ...consumer,
      'packages/tools/package.json': '{"name":"@autogeek/tools","exports":{".":"./src/index.ts"}}',
    });
    await linkWorkspacePackage('packages/agent', '@autogeek/tools', 'packages/tools');
    const violations = await violationsFor({});
    expect(violations.map((v) => v.split(':')[0])).toContain('layer-violation-agent');
  });

  it('the same import is still caught when exports point at a build output under dist/', async () => {
    await writeTree({
      ...consumer,
      'packages/tools/package.json':
        '{"name":"@autogeek/tools","exports":{".":{"import":"./dist/index.js","types":"./dist/index.d.ts"}}}',
    });
    await linkWorkspacePackage('packages/agent', '@autogeek/tools', 'packages/tools');
    const violations = await violationsFor({});
    expect(violations.map((v) => v.split(':')[0])).toContain('layer-violation-agent');
  });

  it.each([
    'tooling/coverage/lcov-report/block.js',
    'tooling/dist/index.js',
    'apps/desktop/out/main/index.js',
  ])('build output at %s is not crawled as source either', async (output) => {
    const violations = await violationsFor({
      [output]: "import { x } from '../../../packages/core/src/index.ts';\nexport const y = x;\n",
      'packages/core/src/index.ts': exported,
    });
    expect(violations).toEqual([]);
  });

  it('build output inside a package is not crawled as source', async () => {
    const violations = await violationsFor({
      'packages/core/src/index.ts': exported,
      'packages/core/dist/index.js':
        "import { y } from '../../agent/src/index.ts';\nexport const x = y;\n",
      'packages/agent/src/index.ts': exported,
    });
    expect(violations).toEqual([]);
  });
});

describe('unknown workspace directories (fail closed)', () => {
  it('a packages/ directory missing from the matrix may not import anything', async () => {
    const violations = await violationsFor({
      'packages/editor/src/index.ts': importer('../../agent/src/index.ts'),
      'packages/agent/src/index.ts': exported,
    });
    expect(violations.map((v) => v.split(':')[0])).toContain('unknown-package');
  });

  it('an apps/ directory missing from the list may not import anything', async () => {
    const violations = await violationsFor({
      'apps/rogue/src/main.ts': importer('../../../packages/core/src/index.ts'),
      'packages/core/src/index.ts': exported,
    });
    expect(violations.map((v) => v.split(':')[0])).toContain('unknown-app');
  });

  it('every directory under packages/ and apps/ in this repo is declared', async () => {
    const root = join(import.meta.dirname, '..', '..');
    const list = async (dir: string): Promise<string[]> =>
      (await readdir(join(root, dir), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    const undeclaredPackages = (await list('packages')).filter(
      (name) => !(PACKAGE_NAMES as readonly string[]).includes(name),
    );
    const undeclaredApps = (await list('apps')).filter(
      (name) => !(APP_NAMES as readonly string[]).includes(name),
    );
    expect([...undeclaredPackages, ...undeclaredApps]).toEqual([]);
  });
});

describe('the vitest.config.ts exception for the shared test config', () => {
  const entry = 'tooling/src/vitest/config.ts';
  const internal = 'tooling/src/eslint-config.ts';
  const names = (violations: string[]): string[] => violations.map((v) => v.split(':')[0] ?? '');

  it.each(['packages/auth/vitest.config.ts', 'apps/desktop/vitest.config.ts'])(
    'allows %s to import the tooling config entry point',
    async (config) => {
      const violations = await violationsFor({
        [config]: importer(relative(dirname(config), entry)),
        [entry]: exported,
      });
      expect(violations).toEqual([]);
    },
  );

  it('still forbids a product source file importing the same entry point', async () => {
    const violations = await violationsFor({
      'packages/auth/src/index.ts': importer('../../../tooling/src/vitest/config.ts'),
      [entry]: exported,
    });
    expect(names(violations)).toContain('nothing-imports-tooling');
  });

  it.each([
    'packages/auth/src/vitest.config.ts',
    'packages/auth/vite.config.ts',
    'packages/auth/vitest.config.mts',
    'packages/auth/not-vitest.config.ts',
  ])('only the exact file name qualifies: %s is still forbidden', async (config) => {
    const violations = await violationsFor({
      [config]: importer(relative(dirname(config), entry)),
      [entry]: exported,
    });
    expect(names(violations)).toContain('nothing-imports-tooling');
  });

  it('forbids a vitest.config.ts importing anything in tooling except the entry point', async () => {
    const violations = await violationsFor({
      'packages/auth/vitest.config.ts': importer('../../tooling/src/eslint-config.ts'),
      [internal]: exported,
    });
    expect(names(violations)).toContain('config-imports-only-tooling-entry');
  });

  it('allows the import through a workspace link when the entry is a package export', async () => {
    await writeTree({
      'packages/auth/package.json':
        '{"name":"@autogeek/auth","devDependencies":{"@autogeek/tooling":"workspace:*"}}',
      'packages/auth/vitest.config.ts':
        "import { x } from '@autogeek/tooling/vitest';\nexport default x;\n",
      'tooling/package.json':
        '{"name":"@autogeek/tooling","exports":{"./vitest":"./src/vitest/config.ts"}}',
      [entry]: exported,
    });
    await linkWorkspacePackage('packages/auth', '@autogeek/tooling', 'tooling');
    expect(await violationsFor({})).toEqual([]);
  });

  it('rejects the import through a workspace link when it reaches an internal file', async () => {
    await writeTree({
      'packages/auth/package.json':
        '{"name":"@autogeek/auth","devDependencies":{"@autogeek/tooling":"workspace:*"}}',
      'packages/auth/vitest.config.ts':
        "import { x } from '@autogeek/tooling/internal';\nexport default x;\n",
      'tooling/package.json':
        '{"name":"@autogeek/tooling","exports":{"./internal":"./src/eslint-config.ts"}}',
      [internal]: exported,
    });
    await linkWorkspacePackage('packages/auth', '@autogeek/tooling', 'tooling');
    expect(names(await violationsFor({}))).toContain('config-imports-only-tooling-entry');
  });

  it('requires the devDependency: pnpm links only declared deps, so an undeclared import cannot resolve', async () => {
    const violations = await violationsFor({
      'packages/auth/package.json': '{"name":"@autogeek/auth"}',
      'packages/auth/vitest.config.ts':
        "import { x } from '@autogeek/tooling/vitest';\nexport default x;\n",
      'tooling/package.json':
        '{"name":"@autogeek/tooling","exports":{"./vitest":"./src/vitest/config.ts"}}',
      [entry]: exported,
    });
    expect(names(violations)).toContain('not-to-unresolvable');
  });
});

describe('nothing may import a vitest.config.ts (it would reach tooling transitively)', () => {
  const names = (violations: string[]): string[] => violations.map((v) => v.split(':')[0] ?? '');

  it.each([
    ['product source of the same package', 'packages/auth/src/index.ts', '../vitest.config.ts'],
    [
      'product source of another package',
      'packages/agent/src/index.ts',
      '../../auth/vitest.config.ts',
    ],
    ['another config file', 'packages/agent/vitest.config.ts', '../auth/vitest.config.ts'],
    ['an app', 'apps/desktop/src/main.ts', '../../../packages/auth/vitest.config.ts'],
  ])('forbids %s importing it', async (_name, from, specifier) => {
    const target = join(dirname(from), specifier);
    const violations = await violationsFor({
      [from]: importer(specifier),
      [target]: exported,
    });
    expect(names(violations)).toContain('nothing-imports-vitest-config');
  });
});

describe('the smoke test config and smoke files', () => {
  const names = (violations: string[]): string[] => violations.map((v) => v.split(':')[0] ?? '');
  const smokeEntry = 'tooling/src/vitest/smoke-config.ts';
  const testEntry = 'tooling/src/vitest/config.ts';

  it.each(['packages/auth/vitest.smoke.config.ts', 'apps/desktop/vitest.smoke.config.ts'])(
    'allows %s to import the tooling smoke entry point',
    async (config) => {
      const violations = await violationsFor({
        [config]: importer(relative(dirname(config), smokeEntry)),
        [smokeEntry]: exported,
      });
      expect(violations).toEqual([]);
    },
  );

  it('allows the import through a workspace link when the entry is a package export', async () => {
    await writeTree({
      'packages/auth/package.json':
        '{"name":"@autogeek/auth","devDependencies":{"@autogeek/tooling":"workspace:*"}}',
      'packages/auth/vitest.smoke.config.ts':
        "import { x } from '@autogeek/tooling/vitest-smoke';\nexport default x;\n",
      'tooling/package.json':
        '{"name":"@autogeek/tooling","exports":{"./vitest-smoke":"./src/vitest/smoke-config.ts"}}',
      [smokeEntry]: exported,
    });
    await linkWorkspacePackage('packages/auth', '@autogeek/tooling', 'tooling');
    expect(await violationsFor({})).toEqual([]);
  });

  it('keeps the two configs to their own entry points', async () => {
    const smokeUsingTestEntry = await violationsFor({
      'packages/auth/vitest.smoke.config.ts': importer('../../tooling/src/vitest/config.ts'),
      [testEntry]: exported,
    });
    expect(names(smokeUsingTestEntry)).toContain('config-imports-only-tooling-entry');
  });

  it('forbids the plain vitest.config.ts from importing the smoke entry', async () => {
    const violations = await violationsFor({
      'packages/auth/vitest.config.ts': importer('../../tooling/src/vitest/smoke-config.ts'),
      [smokeEntry]: exported,
    });
    expect(names(violations)).toContain('config-imports-only-tooling-entry');
  });

  it('forbids the smoke config from importing a tooling internal', async () => {
    const violations = await violationsFor({
      'packages/auth/vitest.smoke.config.ts': importer('../../tooling/src/eslint-config.ts'),
      'tooling/src/eslint-config.ts': exported,
    });
    expect(names(violations)).toContain('config-imports-only-tooling-entry');
  });

  it.each([
    'packages/auth/src/vitest.smoke.config.ts',
    'packages/auth/vitest.smoke.config.mts',
    'packages/auth/not-vitest.smoke.config.ts',
  ])(
    'only the exact file name qualifies for the exception: %s is still forbidden',
    async (config) => {
      const violations = await violationsFor({
        [config]: importer(relative(dirname(config), smokeEntry)),
        [smokeEntry]: exported,
      });
      expect(names(violations)).toContain('nothing-imports-tooling');
    },
  );

  it('forbids product source from importing the smoke entry', async () => {
    const violations = await violationsFor({
      'packages/auth/src/index.ts': importer('../../../tooling/src/vitest/smoke-config.ts'),
      [smokeEntry]: exported,
    });
    expect(names(violations)).toContain('nothing-imports-tooling');
  });

  it.each([
    [
      'product source of the same package',
      'packages/auth/src/index.ts',
      '../vitest.smoke.config.ts',
    ],
    [
      'product source of another package',
      'packages/agent/src/index.ts',
      '../../auth/vitest.smoke.config.ts',
    ],
    ['another config file', 'packages/agent/vitest.config.ts', '../auth/vitest.smoke.config.ts'],
  ])('forbids %s importing a smoke config', async (_name, from, specifier) => {
    const violations = await violationsFor({
      [from]: importer(specifier),
      [join(dirname(from), specifier)]: exported,
    });
    expect(names(violations)).toContain('nothing-imports-vitest-config');
  });

  it.each([
    ['product source', 'packages/auth/src/index.ts', '../smoke/live.smoke.ts'],
    ['a unit test', 'packages/auth/src/index.test.ts', '../smoke/live.smoke.ts'],
    ['another package', 'packages/agent/src/index.ts', '../../auth/smoke/live.smoke.ts'],
    ['a vitest config', 'packages/auth/vitest.config.ts', './smoke/live.smoke.ts'],
  ])('forbids %s importing a smoke file', async (_name, from, specifier) => {
    const violations = await violationsFor({
      [from]: importer(specifier),
      [join(dirname(from), specifier)]: exported,
    });
    expect(names(violations)).toContain('nothing-imports-smoke');
  });

  it('lets a smoke file import product code and other smoke files of its own package', async () => {
    const violations = await violationsFor({
      'packages/auth/smoke/live.smoke.ts':
        "import { x } from '../src/index.ts';\nimport { y } from './helpers.smoke.ts';\nexport const z = [x, y];\n",
      'packages/auth/smoke/helpers.smoke.ts': 'export const y = 1;\n',
      'packages/auth/src/index.ts': exported,
    });
    expect(violations).toEqual([]);
  });
});
