import type { ICruiseOptions, IFlattenedRuleSet, IForbiddenRuleType } from 'dependency-cruiser';

export const PACKAGE_NAMES = [
  'core',
  'auth',
  'providers',
  'agent',
  'tools',
  'mcp',
  'workspace',
  'permissions',
  'ui-kit',
] as const;

/** Applications under apps/. A new app needs an entry here before it may import anything. */
export const APP_NAMES = ['desktop'] as const;

export type PackageName = (typeof PACKAGE_NAMES)[number];

/**
 * Which workspace packages each package may import (ARCHITECTURE.md §4). `core` is imported by
 * everything and imports nothing; `apps/desktop` may import any package and is not listed here.
 * Keep this table and the §4 prose in sync — the table is the enforced version.
 */
export const ALLOWED_PACKAGE_DEPENDENCIES: Readonly<Record<PackageName, readonly PackageName[]>> = {
  core: [],
  permissions: ['core'],
  workspace: ['core'],
  auth: ['core'],
  providers: ['core', 'auth'],
  tools: ['core', 'permissions', 'workspace'],
  agent: ['core', 'permissions', 'workspace', 'providers'],
  mcp: ['core', 'permissions'],
  'ui-kit': ['core'],
};

function layerRule(name: PackageName): IForbiddenRuleType {
  const permitted = [name, ...ALLOWED_PACKAGE_DEPENDENCIES[name]].join('|');
  return {
    name: `layer-violation-${name}`,
    comment: `packages/${name} may only import: ${ALLOWED_PACKAGE_DEPENDENCIES[name].join(', ') || 'no other workspace package'}.`,
    severity: 'error',
    from: { path: `^packages/${name}/` },
    to: { path: '^packages/[^/]+/', pathNot: `^packages/(${permitted})/` },
  };
}

const PUBLIC_API_ENTRY = '^packages/[^/]+/src/index\\.ts$';

export function createDependencyRuleSet(): IFlattenedRuleSet {
  return {
    forbidden: [
      ...PACKAGE_NAMES.map(layerRule),
      {
        name: 'unknown-package',
        comment:
          'A packages/ directory that is not in the layering matrix may not import anything. Add it to ALLOWED_PACKAGE_DEPENDENCIES first.',
        severity: 'error',
        from: { path: '^packages/', pathNot: `^packages/(${PACKAGE_NAMES.join('|')})/` },
        to: {},
      },
      {
        name: 'unknown-app',
        comment: 'An apps/ directory that is not in APP_NAMES may not import anything.',
        severity: 'error',
        from: { path: '^apps/', pathNot: `^apps/(${APP_NAMES.join('|')})/` },
        to: {},
      },
      {
        name: 'no-import-of-apps',
        comment:
          'No package may import an application; apps depend on packages, never the reverse.',
        severity: 'error',
        from: { path: '^packages/' },
        to: { path: '^apps/' },
      },
      {
        name: 'tooling-imports-nothing',
        comment: 'tooling is repo infrastructure and must not depend on product code.',
        severity: 'error',
        from: { path: '^tooling/' },
        to: { path: '^(packages|apps)/' },
      },
      {
        name: 'nothing-imports-tooling',
        comment: 'Product code must not depend on repo tooling.',
        severity: 'error',
        from: { path: '^(packages|apps)/' },
        to: { path: '^tooling/' },
      },
      {
        name: 'public-api-only',
        comment:
          'Import another package only through its public src/index.ts, never its internals.',
        severity: 'error',
        from: { path: '^(apps/[^/]+|packages/[^/]+)/' },
        to: { path: '^packages/[^/]+/', pathNot: ['^$1/', PUBLIC_API_ENTRY] },
      },
      {
        name: 'no-circular',
        comment: 'Circular imports are forbidden, including type-only cycles.',
        severity: 'error',
        from: {},
        to: { circular: true },
      },
      {
        name: 'not-to-unresolvable',
        comment: 'Every import must resolve; a missing module is a bug or a missing dependency.',
        severity: 'error',
        from: {},
        to: { couldNotResolve: true },
      },
      {
        name: 'no-undeclared-dependencies',
        comment: 'Imported npm packages must be declared in the importing package.json.',
        severity: 'error',
        from: {},
        to: { dependencyTypes: ['npm-no-pkg'] },
      },
    ],
  };
}

/**
 * Workspace build output. These are NOT excluded: `exclude` drops edges into matching modules,
 * which blinded the rules to npm packages (and to workspace packages whose `exports` point at a
 * build) that resolve under a `dist/` directory. `doNotFollow` keeps the edge, so every rule still
 * sees it, but does not crawl the build output as source.
 */
const WORKSPACE_BUILD_OUTPUT = '^(apps/[^/]+|packages/[^/]+|tooling)/(dist|out|coverage)/';

export const CRUISE_OPTIONS: ICruiseOptions = {
  doNotFollow: { path: ['node_modules', WORKSPACE_BUILD_OUTPUT] },
  tsPreCompilationDeps: true,
  enhancedResolveOptions: {
    exportsFields: ['exports'],
    conditionNames: ['import', 'require', 'node', 'default', 'types'],
    extensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
  },
};
