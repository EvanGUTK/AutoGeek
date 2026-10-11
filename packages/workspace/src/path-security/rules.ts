/**
 * The rule data behind the sensitive-path classifier and `isExecVector`
 * (docs/workspace-path-cases.md section 7, 7a). One table drives every consumer: the editor
 * channels use `access`, the agent tools use `elevated`, and `isExecVector` is derived from the same
 * rows. There is no second list.
 *
 * Pattern syntax: `/`-separated segments; `*` inside a segment matches any characters; a trailing
 * `**` segment means "this directory and everything beneath it". A pattern without a trailing `**`
 * must end at the last segment of the path (a file or directory entry with that name). A pattern
 * can start at any depth unless noted. All matching is case- and Unicode-insensitive (NFC plus
 * lowercase), so the patterns below are written in lowercase.
 */

export type PathCategory =
  | 'git_internal'
  | 'git_config'
  | 'git_hook'
  | 'private_key'
  | 'credential_dir'
  | 'credential_file'
  | 'git_remote_credentials'
  | 'env_file'
  | 'exec_vector'
  | 'env_template';

export type PathAccess = 'free' | 'confirm' | 'deny';

/** Category precedence when several rules match, first wins (reviewer W4). */
export const CATEGORY_ORDER: readonly PathCategory[] = [
  'git_internal',
  'git_config',
  'git_hook',
  'private_key',
  'credential_dir',
  'credential_file',
  'git_remote_credentials',
  'env_file',
  'exec_vector',
  'env_template',
];

export interface PathRule {
  /** Row id in docs/workspace-path-cases.md, e.g. `7.1` or `7a.3`. */
  readonly id: string;
  readonly patterns: readonly string[];
  readonly category: PathCategory;
  /** Access imposed on a read. `free` means this rule does not restrict reads. */
  readonly read: PathAccess;
  /** Access imposed on a write, delete, rename or chmod. */
  readonly write: PathAccess;
  /** True for every code-execution vector (section 7a): a write is elevated and clears grants. */
  readonly execVector: boolean;
  /** Rules this one replaces when both match (a template wins over the generic `.env` rule). */
  readonly supersedes?: readonly string[];
  /** The rule applies only if no rule of this group matched (default-deny with an allowlist). */
  readonly unlessGroupMatched?: string;
  /** Members of a group are what `unlessGroupMatched` looks at. */
  readonly group?: string;
}

const GIT_ALLOW = 'git-confirm-allowlist';

export const PATH_RULES: readonly PathRule[] = [
  // ---- 7.x sensitive files --------------------------------------------------------------------
  {
    id: '7.1',
    patterns: ['.env/**', '.env.*/**'],
    category: 'env_file',
    read: 'confirm',
    write: 'confirm',
    execVector: true,
  },
  {
    id: '7.1t',
    patterns: ['.env.example/**', '.env.sample/**', '.env.template/**', '.env.dist/**'],
    category: 'env_template',
    read: 'free',
    write: 'confirm',
    execVector: true,
    supersedes: ['7.1'],
  },
  {
    id: '7.3',
    patterns: ['.envrc'],
    category: 'env_file',
    read: 'confirm',
    write: 'confirm',
    execVector: true,
  },
  {
    id: '7.8',
    patterns: [
      'id_rsa',
      'id_ed25519',
      'id_ecdsa',
      'id_dsa',
      '*.pem',
      '*.key',
      '*.p12',
      '*.pfx',
      '*.keystore',
      '*.jks',
    ],
    category: 'private_key',
    read: 'confirm',
    write: 'confirm',
    execVector: false,
  },
  {
    id: '7.9',
    patterns: ['.ssh/**', '.gnupg/**'],
    category: 'credential_dir',
    read: 'confirm',
    write: 'confirm',
    execVector: false,
  },
  {
    id: '7.10',
    patterns: ['.aws/credentials', '.aws/config'],
    category: 'credential_file',
    read: 'confirm',
    write: 'confirm',
    execVector: false,
  },
  {
    id: '7.11',
    patterns: ['.npmrc', '.pypirc', '.netrc', '.docker/config.json', '.kube/config'],
    category: 'credential_file',
    read: 'confirm',
    write: 'confirm',
    execVector: false,
  },
  {
    id: '7.12',
    patterns: ['.config/gcloud/**', '.azure/**'],
    category: 'credential_dir',
    read: 'confirm',
    write: 'confirm',
    execVector: false,
  },
  {
    id: '7.13',
    patterns: [
      'credentials.json',
      'secrets.json',
      'secrets.yaml',
      'secrets.yml',
      'service-account*.json',
    ],
    category: 'credential_file',
    read: 'confirm',
    write: 'confirm',
    execVector: false,
  },
  {
    id: '7.14',
    patterns: ['terraform.tfstate', 'terraform.tfstate.*', '*.tfvars'],
    category: 'credential_file',
    read: 'confirm',
    write: 'confirm',
    execVector: false,
  },

  // ---- 7.4 - 7.7, 7.25 - 7.27 git -------------------------------------------------------------
  {
    id: '7.4',
    patterns: ['.git/config', '.git/config.worktree'],
    category: 'git_config',
    read: 'confirm',
    write: 'confirm',
    execVector: true,
    group: GIT_ALLOW,
  },
  {
    id: '7.4b',
    patterns: ['.git'],
    category: 'git_config',
    read: 'free',
    write: 'confirm',
    execVector: true,
    group: GIT_ALLOW,
  },
  {
    id: '7.5',
    patterns: ['.git/hooks/**'],
    category: 'git_hook',
    read: 'free',
    write: 'confirm',
    execVector: true,
    group: GIT_ALLOW,
  },
  {
    id: '7.6b',
    patterns: [
      '.git/info/exclude',
      '.git/info/attributes',
      '.git/modules/*/config',
      '.git/modules/*/hooks/**',
      '.git/worktrees/*/config.worktree',
    ],
    category: 'git_config',
    read: 'free',
    write: 'confirm',
    execVector: true,
    group: GIT_ALLOW,
  },
  {
    id: '7.6',
    patterns: ['.git/*/**'],
    category: 'git_internal',
    read: 'free',
    write: 'deny',
    execVector: false,
    unlessGroupMatched: GIT_ALLOW,
  },
  {
    id: '7.7',
    patterns: ['.gitmodules', '.gitattributes'],
    category: 'git_config',
    read: 'free',
    write: 'confirm',
    execVector: true,
  },
  {
    id: '7.25',
    patterns: [
      '.git/fetch_head',
      '.git/logs/**',
      '.git/modules/*/config',
      '.git/modules/*/fetch_head',
      '.git/modules/*/logs/**',
      '.git/worktrees/*/config.worktree',
      '.git-credentials',
    ],
    category: 'git_remote_credentials',
    read: 'confirm',
    write: 'free',
    execVector: false,
  },

  // ---- 7a exec vectors ------------------------------------------------------------------------
  {
    id: '7a.3',
    patterns: ['.github/workflows/**', '.github/actions/**'],
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    execVector: true,
  },
  {
    id: '7a.4',
    patterns: [
      '.husky/**',
      '.githooks/**',
      'lefthook.yml',
      'lefthook.yaml',
      '.pre-commit-config.yaml',
      '.lintstagedrc*',
    ],
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    execVector: true,
  },
  {
    id: '7a.6',
    patterns: [
      '.bashrc',
      '.bash_profile',
      '.bash_login',
      '.profile',
      '.zshrc',
      '.zshenv',
      '.zprofile',
      '.zlogin',
      '.config/fish/**',
      '.inputrc',
    ],
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    execVector: true,
  },
  {
    id: '7a.7',
    patterns: [
      '.vscode/tasks.json',
      '.vscode/settings.json',
      '.vscode/launch.json',
      '.vscode/mcp.json',
      '.devcontainer/**',
      '.exrc',
      '.nvimrc',
      '.nvim.lua',
      '.dir-locals.el',
      '.zed/tasks.json',
    ],
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    execVector: true,
  },
  {
    id: '7a.8',
    patterns: [
      '.gitlab-ci.yml',
      '.circleci/**',
      'azure-pipelines.yml',
      '.travis.yml',
      'jenkinsfile',
      'bitbucket-pipelines.yml',
      '.buildkite/**',
      '.drone.yml',
    ],
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    execVector: true,
  },
  {
    id: '7a.9',
    patterns: [
      'makefile',
      'gnumakefile',
      'justfile',
      'taskfile.yml',
      'taskfile.yaml',
      'package.json',
      'pnpm-workspace.yaml',
      '.npmrc',
      '.yarnrc*',
      '.pnpmfile.cjs',
      'bunfig.toml',
    ],
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    execVector: true,
  },
  {
    id: '7a.9b',
    patterns: [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lock*',
      'gemfile',
      'gemfile.lock',
      '*.gemspec',
      'requirements*.txt',
      'pipfile',
      'pipfile.lock',
      'poetry.lock',
      'uv.lock',
    ],
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    execVector: true,
  },
  {
    id: '7a.10',
    patterns: [
      'dockerfile*',
      'docker-compose*.yml',
      'docker-compose*.yaml',
      'compose*.yml',
      'compose*.yaml',
    ],
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    execVector: true,
  },
  {
    id: '7a.11',
    patterns: ['setup.py', 'pyproject.toml', 'setup.cfg'],
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    execVector: true,
  },
  {
    id: '7a.12',
    patterns: ['*.sh', '*.bash', '*.zsh', '*.fish', '*.ps1', '*.bat', '*.cmd'],
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    execVector: true,
  },
  {
    id: '7a.13',
    patterns: [
      '.claude/**',
      '.cursor/**',
      '.cursorrules',
      '.gemini/**',
      '.continue/**',
      '.codex/**',
      'agents.md',
      'autogeek.md',
      'claude.md',
      '.mcp.json',
      '.autogeek/mcp*.json',
    ],
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    execVector: true,
  },
  {
    id: '7a.14',
    patterns: [
      '.cargo/config*',
      'build.rs',
      'rust-toolchain*',
      '.bazelrc',
      'workspace',
      'workspace.bazel',
      'module.bazel',
      'build',
      'build.bazel',
    ],
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    execVector: true,
  },
  {
    id: '7a.15',
    patterns: [
      '.gradle/**',
      'gradle.properties',
      'build.gradle*',
      'settings.gradle*',
      'pom.xml',
      '.mvn/**',
    ],
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    execVector: true,
  },
  {
    id: '7a.20',
    patterns: [
      'node_modules/**',
      '.venv/**',
      'venv/**',
      '.tox/**',
      '.nox/**',
      '__pypackages__/**',
      '*.pth',
    ],
    category: 'exec_vector',
    read: 'free',
    write: 'free',
    execVector: true,
  },
];
