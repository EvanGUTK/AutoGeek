import { describe, expect, it } from 'vitest';
import { classifyPath, isExecVector, type PathClassification, type PathOp } from './classifier.ts';
import { PATH_RULES, type PathAccess, type PathCategory } from './rules.ts';

function classify(path: string, op: PathOp): PathClassification {
  return classifyPath(path.split('/'), op);
}

interface Expectation {
  readonly path: string;
  /** Category reported for a read; a write reports `writeCategory` when it differs. */
  readonly category: PathCategory | null;
  readonly writeCategory?: PathCategory | null;
  readonly read: PathAccess;
  readonly write: PathAccess;
  readonly elevated: boolean;
}

// Each row is checked for both operations: read access, write access, and elevation of a write.
const TABLE: readonly Expectation[] = [
  // 7.1 / 7.2 / 7.23: .env files at any depth, and a .env directory
  { path: '.env', category: 'env_file', read: 'confirm', write: 'confirm', elevated: true },
  { path: '.env.local', category: 'env_file', read: 'confirm', write: 'confirm', elevated: true },
  {
    path: '.env.production',
    category: 'env_file',
    read: 'confirm',
    write: 'confirm',
    elevated: true,
  },
  { path: 'sub/dir/.env', category: 'env_file', read: 'confirm', write: 'confirm', elevated: true },
  { path: '.env/key', category: 'env_file', read: 'confirm', write: 'confirm', elevated: true },
  // 7.1 template family: readable without a dialog, writes still need approval
  {
    path: '.env.example',
    category: 'env_template',
    read: 'free',
    write: 'confirm',
    elevated: true,
  },
  {
    path: 'apps/web/.env.sample',
    category: 'env_template',
    read: 'free',
    write: 'confirm',
    elevated: true,
  },
  // 7.3 / 7a.5
  { path: '.envrc', category: 'env_file', read: 'confirm', write: 'confirm', elevated: true },
  // 7.4 .git/config and 7.4b the gitlink file; 7.5 hooks
  {
    path: '.git/config',
    category: 'git_config',
    read: 'confirm',
    write: 'confirm',
    elevated: true,
  },
  { path: '.git', category: 'git_config', read: 'free', write: 'confirm', elevated: true },
  { path: 'sub/.git', category: 'git_config', read: 'free', write: 'confirm', elevated: true },
  {
    path: '.git/hooks/pre-commit',
    category: 'git_hook',
    read: 'free',
    write: 'confirm',
    elevated: true,
  },
  { path: '.git/hooks', category: 'git_hook', read: 'free', write: 'confirm', elevated: true },
  // 7.6 default-deny under .git for writes, reads free
  { path: '.git/HEAD', category: 'git_internal', read: 'free', write: 'deny', elevated: false },
  { path: '.git/index', category: 'git_internal', read: 'free', write: 'deny', elevated: false },
  {
    path: '.git/objects/ab/cdef',
    category: 'git_internal',
    read: 'free',
    write: 'deny',
    elevated: false,
  },
  {
    path: '.git/refs/heads/main',
    category: 'git_internal',
    read: 'free',
    write: 'deny',
    elevated: false,
  },
  {
    path: '.git/packed-refs',
    category: 'git_internal',
    read: 'free',
    write: 'deny',
    elevated: false,
  },
  { path: '.git/shallow', category: 'git_internal', read: 'free', write: 'deny', elevated: false },
  {
    path: '.git/info/grafts',
    category: 'git_internal',
    read: 'free',
    write: 'deny',
    elevated: false,
  },
  {
    path: 'nested/.git/refs/x',
    category: 'git_internal',
    read: 'free',
    write: 'deny',
    elevated: false,
  },
  // 7.6b confirm allowlist
  {
    path: '.git/info/exclude',
    category: 'git_config',
    read: 'free',
    write: 'confirm',
    elevated: true,
  },
  {
    path: '.git/info/attributes',
    category: 'git_config',
    read: 'free',
    write: 'confirm',
    elevated: true,
  },
  {
    path: '.git/modules/lib/hooks/post-commit',
    category: 'git_config',
    read: 'free',
    write: 'confirm',
    elevated: true,
  },
  {
    path: '.git/worktrees/w1/config.worktree',
    category: 'git_remote_credentials',
    writeCategory: 'git_config',
    read: 'confirm',
    write: 'confirm',
    elevated: true,
  },
  // 7.7 and 7a.2
  { path: '.gitmodules', category: 'git_config', read: 'free', write: 'confirm', elevated: true },
  {
    path: '.gitattributes',
    category: 'git_config',
    read: 'free',
    write: 'confirm',
    elevated: true,
  },
  // 7.25 credential-bearing git reads
  {
    path: '.git/FETCH_HEAD',
    category: 'git_remote_credentials',
    writeCategory: 'git_internal',
    read: 'confirm',
    write: 'deny',
    elevated: false,
  },
  {
    path: '.git/logs/HEAD',
    category: 'git_remote_credentials',
    writeCategory: 'git_internal',
    read: 'confirm',
    write: 'deny',
    elevated: false,
  },
  {
    path: '.git/modules/lib/logs/HEAD',
    category: 'git_remote_credentials',
    writeCategory: 'git_internal',
    read: 'confirm',
    write: 'deny',
    elevated: false,
  },
  {
    path: '.git-credentials',
    category: 'git_remote_credentials',
    read: 'confirm',
    write: 'free',
    elevated: false,
  },
  // 7.8 private keys
  { path: 'id_rsa', category: 'private_key', read: 'confirm', write: 'confirm', elevated: false },
  {
    path: 'ssh/id_ed25519',
    category: 'private_key',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  {
    path: 'certs/server.pem',
    category: 'private_key',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  {
    path: 'keys/app.p12',
    category: 'private_key',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  {
    path: 'a.keystore',
    category: 'private_key',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  // 7.9 - 7.14 credentials
  {
    path: '.ssh/config',
    category: 'credential_dir',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  {
    path: 'home/.gnupg/pubring.kbx',
    category: 'credential_dir',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  {
    path: '.aws/credentials',
    category: 'credential_file',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  {
    path: '.pypirc',
    category: 'credential_file',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  {
    path: '.netrc',
    category: 'credential_file',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  {
    path: '.docker/config.json',
    category: 'credential_file',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  {
    path: '.kube/config',
    category: 'credential_file',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  {
    path: '.config/gcloud/credentials.db',
    category: 'credential_dir',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  {
    path: '.azure/accessTokens.json',
    category: 'credential_dir',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  {
    path: 'secrets.yaml',
    category: 'credential_file',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  {
    path: 'service-account-prod.json',
    category: 'credential_file',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  {
    path: 'infra/terraform.tfstate',
    category: 'credential_file',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  {
    path: 'infra/prod.tfvars',
    category: 'credential_file',
    read: 'confirm',
    write: 'confirm',
    elevated: false,
  },
  // .npmrc is both a credential file (7.11) and an exec vector (7a.9): most restrictive wins
  {
    path: '.npmrc',
    category: 'credential_file',
    read: 'confirm',
    write: 'confirm',
    elevated: true,
  },
  // 7a exec vectors: reads are ordinary, writes elevated
  {
    path: '.github/workflows/ci.yml',
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    elevated: true,
  },
  {
    path: '.husky/pre-commit',
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    elevated: true,
  },
  { path: 'package.json', category: 'exec_vector', read: 'free', write: 'free', elevated: true },
  {
    path: 'apps/web/package.json',
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    elevated: true,
  },
  { path: 'Makefile', category: 'exec_vector', read: 'free', write: 'free', elevated: true },
  { path: 'pnpm-lock.yaml', category: 'exec_vector', read: 'free', write: 'free', elevated: true },
  {
    path: 'node_modules/left-pad/index.js',
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    elevated: true,
  },
  {
    path: 'scripts/deploy.sh',
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    elevated: true,
  },
  { path: 'CLAUDE.md', category: 'exec_vector', read: 'free', write: 'free', elevated: true },
  // ordinary paths
  { path: 'src/a.ts', category: null, read: 'free', write: 'free', elevated: false },
  { path: 'README.md', category: null, read: 'free', write: 'free', elevated: false },
];

describe('classifier table (docs/workspace-path-cases.md section 7 and 7a)', () => {
  it.each(TABLE)('$path', (row) => {
    const read = classify(row.path, 'read');
    const write = classify(row.path, 'write');
    expect(read.access).toBe(row.read);
    expect(write.access).toBe(row.write);
    expect(read.category).toBe(row.category);
    expect(write.category).toBe(row.writeCategory ?? row.category);
    expect(write.elevated).toBe(row.elevated);
    expect(read.elevated).toBe(false);
  });
});

describe('7.18 / 7.19 / 7.24 / 7a.19 / X.2: no false positives', () => {
  it.each([
    'env.ts',
    'environment.ts',
    'my.env.d.ts',
    'keyboard.ts',
    'monkey.ts',
    'x.pem.txt',
    'id_rsa.pub',
    'docs/Makefile.md',
    'src/makefile-utils.ts',
    'husky.ts',
    'src/husky/index.ts',
    'dist/x.js',
    'target/debug/app',
    'conftest.py',
    'tox.ini',
    'noxfile.py',
    'vitest.setup.ts',
    'vite.config.ts',
    'eslint.config.js',
    'src/a.ts',
    '.gitignore',
    'packages/workspace/src/index.ts',
    '.github/CODEOWNERS',
    '.git-blame-ignore-revs',
    '.envoy/config.yaml',
    'environment/prod.md',
    'node_modules_backup/x.js',
  ])('%s is an ordinary path', (path) => {
    expect(classify(path, 'write')).toMatchObject({
      category: null,
      access: 'free',
      elevated: false,
      execVector: false,
    });
    expect(isExecVector(path)).toBe(false);
  });
});

describe('7.20 / 7.21-style: matching ignores case and Unicode normalization', () => {
  it.each([
    ['.ENV', 'env_file'],
    ['.Env.Local', 'env_file'],
    ['ID_RSA', 'private_key'],
    ['.GIT/config', 'git_config'],
    ['.Git/Config', 'git_config'],
    ['.GIT/HEAD', 'git_internal'],
    ['MAKEFILE', 'exec_vector'],
    ['Package.JSON', 'exec_vector'],
    ['.GitHub/Workflows/ci.yml', 'exec_vector'],
    ['NODE_MODULES/x', 'exec_vector'],
  ] as const)('%s', (path, category) => {
    expect(classify(path, 'write').category).toBe(category);
  });

  it('matches an NFD spelling of a name the table spells with a composed character', () => {
    // No table name contains a non-ASCII letter, so check the fold through a glob's wildcard part.
    expect(classify('service-account-é.json', 'read').category).toBe('credential_file');
    expect(classify('service-account-é.json', 'read').category).toBe('credential_file');
  });
});

describe('7.6 default-deny with an explicit confirm allowlist (fail closed)', () => {
  it('denies an unknown file added under .git by a future git version', () => {
    expect(classify('.git/some-new-file', 'write').access).toBe('deny');
    expect(classify('.git/new-dir/x', 'write').access).toBe('deny');
  });

  it('keeps every allowlist entry confirmable and elevated', () => {
    for (const path of [
      '.git/config',
      '.git/hooks/pre-push',
      '.git/info/exclude',
      '.git/info/attributes',
      '.git/modules/a/config',
      '.git/modules/a/hooks/x',
      '.git/worktrees/b/config.worktree',
    ]) {
      const result = classify(path, 'write');
      expect(result.access, path).toBe('confirm');
      expect(result.elevated, path).toBe(true);
    }
  });

  it('reads of git objects and refs are free', () => {
    for (const path of [
      '.git/HEAD',
      '.git/refs/heads/main',
      '.git/objects/ab/cd',
      '.git/packed-refs',
    ]) {
      expect(classify(path, 'read').access, path).toBe('free');
    }
  });

  it('classifies a .git directory at any depth the same way', () => {
    expect(classify('vendor/lib/.git/HEAD', 'write').access).toBe('deny');
    expect(classify('vendor/lib/.git/hooks/x', 'write').access).toBe('confirm');
  });
});

describe('7a.1 / X: the .git gitlink FILE', () => {
  it('is confirmable and elevated for writes, ordinary for reads', () => {
    expect(classify('.git', 'write')).toMatchObject({ access: 'confirm', elevated: true });
    expect(classify('.git', 'read').access).toBe('free');
  });
});

describe('W4 precedence: access is the most restrictive, elevated is OR, category is first', () => {
  it('.npmrc: credential_file wins the category, access confirm, elevated', () => {
    const write = classify('.npmrc', 'write');
    expect(write).toMatchObject({ category: 'credential_file', access: 'confirm', elevated: true });
    expect(write.rules).toEqual(expect.arrayContaining(['7.11', '7a.9']));
  });

  it('.envrc: env_file with confirm reads and an elevated write', () => {
    expect(classify('.envrc', 'read').access).toBe('confirm');
    expect(classify('.envrc', 'write').elevated).toBe(true);
  });

  it('.git/config: git_config wins over the remote-credentials read rule', () => {
    const read = classify('.git/config', 'read');
    expect(read.category).toBe('git_config');
    expect(read.access).toBe('confirm');
  });

  it('.git/logs/HEAD: remote-credentials read confirm, write denied by the git default', () => {
    expect(classify('.git/logs/HEAD', 'read').access).toBe('confirm');
    expect(classify('.git/logs/HEAD', 'write').access).toBe('deny');
  });

  it('enumerates multi-match paths with a combined result', () => {
    const multi = ['.npmrc', '.envrc', '.git/config', '.gitmodules', '.vscode/settings.json'];
    for (const path of multi) {
      const write = classify(path, 'write');
      expect(write.rules.length, path).toBeGreaterThan(0);
      expect(write.elevated, path).toBe(true);
    }
  });
});

// Positive examples per rule id: each must match its rule (X.1, a row without an example fails).
const EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  '7.1': ['.env', '.env.local', 'a/.env.production', '.env/x'],
  '7.1t': ['.env.example', '.env.sample', '.env.template', '.env.dist'],
  '7.3': ['.envrc', 'a/.envrc'],
  '7.8': [
    'id_rsa',
    'id_ed25519',
    'id_ecdsa',
    'id_dsa',
    'a.pem',
    'a.key',
    'a.p12',
    'a.pfx',
    'a.keystore',
    'a.jks',
  ],
  '7.9': ['.ssh/id_rsa', '.gnupg/x'],
  '7.10': ['.aws/credentials', '.aws/config'],
  '7.11': ['.npmrc', '.pypirc', '.netrc', '.docker/config.json', '.kube/config'],
  '7.12': ['.config/gcloud/x', '.azure/x'],
  '7.13': [
    'credentials.json',
    'secrets.json',
    'secrets.yaml',
    'secrets.yml',
    'service-account-x.json',
  ],
  '7.14': ['terraform.tfstate', 'terraform.tfstate.backup', 'prod.tfvars'],
  '7.4': ['.git/config', '.git/config.worktree'],
  '7.4b': ['.git', 'sub/.git'],
  '7.5': ['.git/hooks/pre-commit', '.git/hooks'],
  '7.6b': [
    '.git/info/exclude',
    '.git/info/attributes',
    '.git/modules/a/config',
    '.git/modules/a/hooks/x',
    '.git/worktrees/a/config.worktree',
  ],
  '7.6': ['.git/HEAD', '.git/objects/ab/cd', '.git/refs/heads/x', '.git/index'],
  '7.7': ['.gitmodules', '.gitattributes'],
  '7.25': [
    '.git/FETCH_HEAD',
    '.git/logs/HEAD',
    '.git/modules/a/config',
    '.git/modules/a/FETCH_HEAD',
    '.git/modules/a/logs/HEAD',
    '.git/worktrees/a/config.worktree',
    '.git-credentials',
  ],
  '7a.3': ['.github/workflows/ci.yml', '.github/actions/x/action.yml'],
  '7a.4': [
    '.husky/pre-commit',
    '.githooks/x',
    'lefthook.yml',
    'lefthook.yaml',
    '.pre-commit-config.yaml',
    '.lintstagedrc',
    '.lintstagedrc.json',
  ],
  '7a.6': [
    '.bashrc',
    '.bash_profile',
    '.bash_login',
    '.profile',
    '.zshrc',
    '.zshenv',
    '.zprofile',
    '.zlogin',
    '.config/fish/config.fish',
    '.inputrc',
  ],
  '7a.7': [
    '.vscode/tasks.json',
    '.vscode/settings.json',
    '.vscode/launch.json',
    '.vscode/mcp.json',
    '.devcontainer/devcontainer.json',
    '.exrc',
    '.nvimrc',
    '.nvim.lua',
    '.dir-locals.el',
    '.zed/tasks.json',
  ],
  '7a.8': [
    '.gitlab-ci.yml',
    '.circleci/config.yml',
    'azure-pipelines.yml',
    '.travis.yml',
    'Jenkinsfile',
    'bitbucket-pipelines.yml',
    '.buildkite/pipeline.yml',
    '.drone.yml',
  ],
  '7a.9': [
    'Makefile',
    'GNUmakefile',
    'justfile',
    'Taskfile.yml',
    'Taskfile.yaml',
    'package.json',
    'pnpm-workspace.yaml',
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    '.pnpmfile.cjs',
    'bunfig.toml',
  ],
  '7a.9b': [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'Gemfile',
    'Gemfile.lock',
    'x.gemspec',
    'requirements.txt',
    'requirements-dev.txt',
    'Pipfile',
    'Pipfile.lock',
    'poetry.lock',
    'uv.lock',
  ],
  '7a.10': [
    'Dockerfile',
    'Dockerfile.dev',
    'docker-compose.yml',
    'docker-compose.prod.yaml',
    'compose.yaml',
    'compose.override.yml',
  ],
  '7a.11': ['setup.py', 'pyproject.toml', 'setup.cfg'],
  '7a.12': ['a.sh', 'a.bash', 'a.zsh', 'a.fish', 'a.ps1', 'a.bat', 'a.cmd'],
  '7a.13': [
    '.claude/settings.json',
    '.cursor/rules',
    '.cursorrules',
    '.gemini/x',
    '.continue/x',
    '.codex/x',
    'AGENTS.md',
    'AUTOGEEK.md',
    'CLAUDE.md',
    '.mcp.json',
    '.autogeek/mcp.json',
    '.autogeek/mcp-servers.json',
  ],
  '7a.14': [
    '.cargo/config.toml',
    '.cargo/config',
    'build.rs',
    'rust-toolchain',
    'rust-toolchain.toml',
    '.bazelrc',
    'WORKSPACE',
    'WORKSPACE.bazel',
    'MODULE.bazel',
    'BUILD',
    'BUILD.bazel',
  ],
  '7a.15': [
    '.gradle/x',
    'gradle.properties',
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'pom.xml',
    '.mvn/wrapper/x',
  ],
  '7a.20': [
    'node_modules/a/b.js',
    '.venv/lib/x.py',
    'venv/bin/x',
    '.tox/x',
    '.nox/x',
    '__pypackages__/x',
    'site-packages/x.pth',
    'a.pth',
  ],
};

describe('X.1 every rule has positive examples and each one matches its rule', () => {
  it('has examples for every rule id and no example for an unknown id', () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual(PATH_RULES.map((rule) => rule.id).sort());
  });

  it.each(Object.entries(EXAMPLES))('%s', (id, paths) => {
    for (const path of paths) {
      expect(classify(path, 'write').rules, path).toContain(id);
    }
  });
});

describe('X.3 / X.5 isExecVector', () => {
  it('is true exactly for the paths whose rules are exec vectors', () => {
    for (const [id, paths] of Object.entries(EXAMPLES)) {
      const rule = PATH_RULES.find((candidate) => candidate.id === id);
      for (const path of paths) {
        const result = classify(path, 'write');
        if (rule?.execVector === true) {
          expect(isExecVector(path), `${id} ${path}`).toBe(true);
          expect(result.elevated, `${id} ${path}`).toBe(true);
        }
        // implication in both directions on the whole result
        expect(isExecVector(path), `${id} ${path}`).toBe(result.execVector);
        expect(result.elevated, `${id} ${path}`).toBe(result.execVector);
      }
    }
  });

  it('is case- and Unicode-insensitive', () => {
    expect(isExecVector('PACKAGE.JSON')).toBe(true);
    expect(isExecVector('.GitHub/WORKFLOWS/ci.yml')).toBe(true);
    expect(isExecVector('Src/A.ts')).toBe(false);
  });

  it('is true for the .env family and the dependency directories (7a.16, 7a.20)', () => {
    expect(isExecVector('.env')).toBe(true);
    expect(isExecVector('.env.example')).toBe(true);
    expect(isExecVector('node_modules/x/y.js')).toBe(true);
    expect(isExecVector('.venv/lib/x.pth')).toBe(true);
  });

  it('is false for credential-only paths that run no code', () => {
    expect(isExecVector('id_rsa')).toBe(false);
    expect(isExecVector('.aws/credentials')).toBe(false);
    expect(isExecVector('.git/HEAD')).toBe(false);
    expect(isExecVector('.git/logs/HEAD')).toBe(false);
  });

  it('returns true (fail closed) for malformed input', () => {
    for (const bad of [
      '',
      '/etc/passwd',
      './package.json',
      'a/./b',
      'a/../b',
      '..',
      'a//b',
      'a/',
      'a\\b',
      'a\u0000b',
      'a\nb',
      'a\u0085b',
      `${'a'.repeat(256)}/x`,
      `${'a/'.repeat(2049)}x`,
    ]) {
      expect(isExecVector(bad), JSON.stringify(bad)).toBe(true);
    }
  });

  it('returns false for a valid path that matches no rule', () => {
    for (const path of ['src/a.ts', 'README.md', 'docs/guide.md', 'a/b/c/d.txt']) {
      expect(isExecVector(path), path).toBe(false);
    }
  });
});

describe('classifier edge cases', () => {
  it('treats the root itself (no segments) as ordinary', () => {
    expect(classifyPath([], 'write')).toMatchObject({ category: null, access: 'free' });
  });

  it('does not mutate its input', () => {
    const segments = Object.freeze(['.git', 'HEAD']);
    expect(classifyPath(segments, 'write').access).toBe('deny');
  });

  it('matches in linear time on a pathological glob input', () => {
    const name = `${'a'.repeat(200)}.sh`;
    const started = performance.now();
    for (let index = 0; index < 200; index += 1) {
      classify(`${'x/'.repeat(100)}${name}`, 'write');
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
