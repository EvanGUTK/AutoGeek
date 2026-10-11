import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
