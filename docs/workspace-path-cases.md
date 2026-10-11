# Workspace path-security test cases

Test table for the path security module in `@autogeek/workspace` (brief item 1). Written before the
code; each row becomes a table-driven test. Rules come from `ARCHITECTURE.md` §8.3: every tool path
is resolved and realpath'd, must stay inside a trusted workspace root, and sensitive files need
explicit approval. When in doubt, deny.

Notation: `R` is the trusted root (realpath'd at registration), `outside` is a sibling directory of
`R`. "reject" means a typed `Result` error naming the reason, never a throw. Platform column:
`all`, `posix`, `win32`, `mac` (case-insensitive APFS default).

## 1. Lexical normalization (before touching the disk)

| # | Input | Expected | Platform |
|---|---|---|---|
| 1.1 | `src/a.ts` (relative) | resolves under `R` | all |
| 1.2 | `R/src/a.ts` (absolute inside) | allow | all |
| 1.3 | `/etc/passwd` | reject `outside_root` | posix |
| 1.4 | `../outside/x` | reject `outside_root` | all |
| 1.5 | `src/../../outside/x` | reject `outside_root` | all |
| 1.6 | `src/../src/a.ts` | allow, normalized to `src/a.ts` | all |
| 1.7 | `` (empty string) | reject `invalid_path` | all |
| 1.8 | `.` | resolves to `R` itself, allowed for list/stat, rejected for write/delete | all |
| 1.9 | `a\0b` (NUL byte) | reject `invalid_path` before any fs call | all |
| 1.10 | `a\u0000` trailing NUL | reject `invalid_path` | all |
| 1.11 | path with control chars (`\n`, `\r`, `\x1b`) | reject `invalid_path` | all |
| 1.12 | `src//a.ts`, `src/./a.ts` | allow, normalized | all |
| 1.13 | trailing slash `src/` on a file | reject `not_a_directory` at use site, allowed by the path module | all |
| 1.14 | path longer than `PATH_MAX` (4096 posix, 32767 win32) | reject `invalid_path` | all |
| 1.15 | single component longer than 255 bytes | reject `invalid_path` | all |
| 1.16 | non-string input (`undefined`, number) | zod rejects at the boundary | all |
| 1.17 | Unicode: NFC vs NFD `é` | both map to the same entry on macOS; containment decided on the realpath, not the lexical form | mac |
| 1.18 | `R` prefix lookalike: `R-evil/x` where `R=/w/proj` | reject `outside_root`; containment compares path segments, not string prefixes | all |
| 1.19 | root given with trailing slash vs without | equivalent | all |
| 1.20 | `~/x` | treated as a literal relative name `~`, never expanded | all |
| 1.21 | `$HOME/x`, `%USERPROFILE%\x` | literal names, never expanded | all |
| 1.22 | `file:///etc/passwd` | literal relative name, not a URL; stays under `R` | all |

## 2. Windows / UNC forms (reject by default, tested on all platforms lexically)

| # | Input | Expected |
|---|---|---|
| 2.1 | `\\server\share\x` | reject `unsupported_path_form` |
| 2.2 | `\\?\C:\x`, `\\.\C:\x` (device / verbatim prefix) | reject `unsupported_path_form` |
| 2.3 | `C:\outside\x` when `R` is on another drive | reject `outside_root` |
| 2.4 | `C:x` (drive-relative) | reject `unsupported_path_form` |
| 2.5 | `CON`, `NUL`, `COM1`, `aux.txt` (reserved device names) | reject `invalid_path` |
| 2.6 | trailing dot or space in a component (`a.`, `a `) | reject `invalid_path` |
| 2.7 | alternate data stream `a.txt:stream` | reject `invalid_path` |
| 2.8 | 8.3 short name `PROGRA~1` | resolve via realpath, then contain |
| 2.9 | forward and back slashes mixed | normalized before containment |
| 2.10 | on posix, a backslash in a name (`a\b`) | a legal filename, treated literally |

## 3. Symlinks (needs a real temp directory, created in test setup)

| # | Setup | Expected |
|---|---|---|
| 3.1 | `R/link -> R/src` (inside to inside) | allow; resolved path is the target |
| 3.2 | `R/link -> outside` (directory) | reject `symlink_escape` for `link/x` |
| 3.3 | `R/link -> outside/secret` (file) | reject `symlink_escape` |
| 3.4 | `R/link -> /etc` absolute target | reject `symlink_escape` |
| 3.5 | chain `a -> b -> outside` | reject; every hop is followed to the final realpath |
| 3.6 | chain deeper than the OS limit (`ELOOP`) | reject `symlink_loop` |
| 3.7 | self-referential `a -> a` | reject `symlink_loop` |
| 3.8 | dangling link `R/link -> missing` (read) | reject `not_found`, not an escape |
| 3.9 | dangling link `R/link -> outside/new` (write creates the target) | reject `symlink_escape`; must not create `outside/new` |
| 3.10 | write to new file whose parent is a symlink to `outside` | reject `symlink_escape`; the parent is realpath'd, not the leaf |
| 3.11 | write to new file `R/newdir/x` where `newdir` does not exist | allow; deepest existing ancestor is realpath'd and contained |
| 3.12 | deepest existing ancestor is a symlink to `outside` | reject |
| 3.13 | `R/link -> ../R/src` (relative target that re-enters root) | allow |
| 3.14 | `R` itself reached via a symlink (`/tmp` vs `/private/tmp` on macOS) | root is stored as realpath; inputs through either spelling resolve inside |
| 3.15 | hard link `R/h` to `outside/f` | not detectable by path; document in `docs/SECURITY.md` and mitigate: writes are atomic rename, so they replace the link and never write through it |
| 3.16 | symlink as the final component for `delete` | delete removes the link itself, never the target |
| 3.17 | symlink as the final component for `read` pointing outside | reject `symlink_escape` |
| 3.18 | `lstat`-based listing shows the link entry; following it is a separate checked call | allow listing, reject follow |
| 3.19 | bind mount / mount point inside `R` | out of scope of path-based checks; documented as a known limit |

## 4. Case-insensitive filesystems (macOS APFS default, Windows)

| # | Input | Expected | Platform |
|---|---|---|---|
| 4.1 | `R` registered as `/Users/a/Proj`, input `/users/a/proj/x` | allow; containment uses the realpath, which returns the on-disk case | mac, win32 |
| 4.2 | same on a case-sensitive volume | reject `outside_root` / `not_found` | posix |
| 4.3 | `.ENV` and `.Env` | classified sensitive, same as `.env` | all |
| 4.4 | `.GIT/config`, `.Git/Config` | classified sensitive | all |
| 4.5 | `SRC/A.ts` vs `src/a.ts` as two writes in one turn | the same file; the checkpoint and permission layers see one canonical path | mac, win32 |
| 4.6 | Unicode case folding (`İ`, `ß`) in names | compare using the realpath, not a custom fold | mac |
| 4.7 | detection of volume case sensitivity | probe once per root with a temp file, cache; fall back to assuming case-insensitive (safer) if the probe fails | all |

## 5. TOCTOU and races (open via fd where possible)

The module returns a handle, not just a string: resolve, open with `O_NOFOLLOW` where the platform
has it, then verify the opened fd's realpath (`/proc/self/fd` on Linux, `fcntl(F_GETPATH)` on macOS,
`GetFinalPathNameByHandle` on Windows) is still inside `R`. Reads and writes use the fd.

| # | Scenario | Expected |
|---|---|---|
| 5.1 | after the check, the leaf is swapped for a symlink to `outside` before open | `O_NOFOLLOW` open fails (`ELOOP`); reject `symlink_escape` |
| 5.2 | after the check, an intermediate directory is replaced by a symlink to `outside` | post-open fd realpath is outside `R`; reject, nothing read or written |
| 5.3 | swap happens between open and read | fd is already bound to the original inode; reads come from it, not the new path |
| 5.4 | atomic write: temp file created in the target directory, then `rename` | temp name is unpredictable, created `O_EXCL`; a pre-placed symlink at the temp name fails |
| 5.5 | rename destination swapped for a symlink to `outside` before rename | `rename` replaces the link itself and never follows it; the target is untouched |
| 5.6 | concurrent writes to the same file | each is atomic; the final content equals exactly one writer's content |
| 5.7 | delete races with a replace by a directory | reject `not_a_file`, nothing recursive happens |
| 5.8 | `mkdir -p` style parent creation racing with a symlink swap | create one component at a time with `mkdir` and re-verify containment after each |
| 5.9 | stress test: a loop thread flips a path between a regular file and a symlink to `outside` while the module reads it 10k times | the outside file's content is never returned |
| 5.10 | abort during resolution | `AbortSignal` honored; the fd is closed; no leak |

Platforms without a reliable fd-to-path call fall back to a re-check immediately after open and are
documented as weaker in `docs/SECURITY.md`; tests assert the fallback path is exercised.

## 6. Multiple roots and trust

| # | Scenario | Expected |
|---|---|---|
| 6.1 | two roots `R1`, `R2`; path inside `R2` | allow, reported with its owning root |
| 6.2 | nested roots (`R2` inside `R1`) | resolves to the most specific root; trust of the most specific root applies |
| 6.3 | path inside an untrusted root | allow for the user-initiated fs service; tools reject `untrusted_workspace` |
| 6.4 | root removed while a handle is open | subsequent calls reject `root_unavailable` |
| 6.5 | root that is a symlink at registration | stored as its realpath; the original spelling is kept for display only |
| 6.6 | root is `/` or the user's home directory | reject at registration (`root_too_broad`) |
| 6.7 | root does not exist or is a file | reject at registration |
| 6.8 | untrusted root: FS `list`/`read`/`write` (restricted mode, chief ruling) | allowed, with containment, symlink, sensitive and `protected_path` rules enforced in full |
| 6.9 | untrusted root: git service, `GitRunner`, PTY service | each refuses with `untrusted_workspace` at the service level (defense in depth; main also checks per channel) |
| 6.10 | repo-controlled config in any root | never treated as code: `.gitignore` is parsed as data only; ripgrep runs with `--no-config`, never `--pre`, and no `RIPGREP_CONFIG_PATH` in its env |
| 6.11 | trust revoked while a git/PTY operation is in flight | the operation is aborted and the PTY is killed; a later call returns `untrusted_workspace` |

## 7. Sensitive-path classifier

Classification works on the canonical (realpath'd, case-normalized) path relative to its root and
on the basename. A sensitive match never denies on its own; it forces an explicit approval request
carrying a `sensitive: <category>` reason. It applies to reads and writes, and to `glob`/`grep`
results (content of sensitive files is excluded from search output unless approved).

| # | Path | Category |
|---|---|---|
| 7.1 | `.env`, `.env.local`, `.env.production`, `.env.example` | `env_file` (the `.example` family is `env_template`: approval is still required to write, reads are allowed) |
| 7.2 | `sub/dir/.env` | `env_file` (any depth) |
| 7.3 | `.envrc` | `env_file` |
| 7.4 | `.git/config` | `git_config` |
| 7.5 | `.git/hooks/pre-commit` (any hook) | `git_hook` (a write is code execution) |
| 7.6 | `.git/HEAD`, `.git/index`, `.git/objects/**` | `git_internal` (write denied outright; the git service is the only writer) |
| 7.7 | `.gitmodules`, `.gitattributes` with filter drivers | `git_config` for writes |
| 7.8 | `id_rsa`, `id_ed25519`, `id_ecdsa`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks` | `private_key` |
| 7.9 | `.ssh/**`, `.gnupg/**` | `credential_dir` |
| 7.10 | `.aws/credentials`, `.aws/config` | `credential_file` |
| 7.11 | `.npmrc`, `.pypirc`, `.netrc`, `.docker/config.json`, `.kube/config` | `credential_file` |
| 7.12 | `.config/gcloud/**`, `.azure/**` | `credential_dir` |
| 7.13 | `credentials.json`, `secrets.json`, `secrets.yaml`, `service-account*.json` | `credential_file` |
| 7.14 | `terraform.tfstate`, `*.tfvars` | `credential_file` |
| 7.15 | AutoGeek's own config and credential store paths (`~/.autogeek/**`, the Electron `userData` dir) | `autogeek_internal` (denied outright, even if a workspace root contains them) |
| 7.16 | `.autogeek/` or `AUTOGEEK.md` inside a workspace | not sensitive (project rules); writes still gated as ordinary writes |
| 7.17 | `.vscode/tasks.json`, `.vscode/settings.json`, `.vscode/launch.json` | `exec_vector` (see §7a) |
| 7.18 | `env.ts`, `environment.ts`, `my.env.d.ts` | not sensitive (no false positives on names merely containing `env`) |
| 7.19 | `keyboard.ts`, `monkey.ts` | not sensitive (no substring matching on `key`) |
| 7.20 | `.ENV` / `ID_RSA` in a different case | sensitive (case-insensitive match) |
| 7.21 | a symlink named `notes.txt` pointing at `.env` | classified on the target, so sensitive |
| 7.22 | a normal-looking path whose realpath is `.git/config` through `..` | classified on the canonical path |
| 7.23 | `.env` as a directory name | treated as sensitive for any path beneath it |
| 7.24 | file named `x.pem.txt` | not sensitive by extension, listed so the matcher is anchored to the final extension |

## 7a. Code-execution vectors (`exec_vector`, chief addition)

Writing to these files can make a later build, commit, shell, or editor action run attacker-chosen
code, so a write is as dangerous as running a command. Classifier rule: category `exec_vector`,
`elevated: true`. Consequences for the permissions owner: a write is never session-grantable and
always shows a diff prompt. Reads are ordinary. Each entry carries a one-line rationale for
ag-reviewer. Matching is case- and Unicode-insensitive and applies at any depth unless anchored.

| # | Path (relative to the root) | Rationale |
|---|---|---|
| 7a.1 | `.git/**` (hooks, config, `info/attributes`, `info/exclude`) | hooks and config keys run code on the next git command; anchored at the root and at any nested repo |
| 7a.2 | `.gitmodules`, `.gitattributes` | submodule URLs and filter drivers run commands on checkout/add |
| 7a.3 | `.github/workflows/**`, `.github/actions/**` | CI runs with repository secrets |
| 7a.4 | `.husky/**`, `.githooks/**`, `lefthook.yml`, `.pre-commit-config.yaml`, `.lintstagedrc*` | git hook managers run on commit |
| 7a.5 | `.envrc` | direnv executes it on `cd` |
| 7a.6 | shell rc/profile files: `.bashrc`, `.bash_profile`, `.bash_login`, `.profile`, `.zshrc`, `.zshenv`, `.zprofile`, `.zlogin`, `.config/fish/**`, `.inputrc` | run on the next shell start (only when a root contains a home directory, but matched by name) |
| 7a.7 | `.vscode/{tasks,settings,launch}.json`, `.devcontainer/**` | editor tasks, debugger launch commands, dev container lifecycle commands |
| 7a.8 | `.gitlab-ci.yml`, `.circleci/**`, `azure-pipelines.yml`, `.travis.yml`, `Jenkinsfile`, `bitbucket-pipelines.yml`, `.buildkite/**`, `.drone.yml` | other CI configs, same as 7a.3 |
| 7a.9 | `Makefile`, `GNUmakefile`, `justfile`, `Taskfile.yml`, `package.json`, `pnpm-workspace.yaml` (scripts and lifecycle hooks), `.npmrc`, `.yarnrc*`, `.pnpmfile.cjs` | build and install commands run by routine tooling; `package.json` is also edited constantly, so the prompt is a diff prompt and not a block |
| 7a.10 | `Dockerfile*`, `docker-compose*.yml`, `compose*.yaml` | build and run commands |
| 7a.11 | `conftest.py`, `setup.py`, `pyproject.toml` build hooks, `tox.ini`, `noxfile.py` | executed by test runners and installers (`conftest.py` and `setup.py` execute on collection and install) |
| 7a.12 | `*.sh` with the executable bit set | an executable script is a command waiting to run; write and chmod both |
| 7a.13 | `.claude/**`, `.cursor/**`, `AGENTS.md`, `AUTOGEEK.md`, `CLAUDE.md`, `.mcp.json`, `.autogeek/mcp*.json` | agent configuration and MCP server definitions spawn processes and widen agent behavior. `AUTOGEEK.md` and `AGENTS.md` are prompt-injection surfaces, so elevated writes, ordinary reads (revises 7.16 for writes) |
| 7a.14 | `.cargo/config*`, `build.rs`, `rust-toolchain*`, `.bazelrc`, `WORKSPACE`, `BUILD*` | build scripts and runner overrides |
| 7a.15 | `.gradle/**`, `gradle.properties`, `build.gradle*`, `settings.gradle*`, `pom.xml`, `.mvn/**` | build plugins run code |
| 7a.16 | `.env*` | already `env_file`; listed to note that `env_file` is also elevated for writes |
| 7a.17 | any symlink whose realpath lands on a row above | classified on the target (same as 7.21) |
| 7a.18 | the same names in a different case or NFD form | matched (same as 7.20) |
| 7a.19 | `docs/Makefile.md`, `src/makefile-utils.ts`, `husky.ts` | not matched: the rules are anchored to the whole basename or path, no substring or prefix matching |
| 7a.20 | writes under `node_modules/**` and `.venv/**` | `elevated` (chief ruling): installed dependencies are executed code and an agent has no business editing them; reads are ordinary. `dist/**`, `target/**` and other build output stay non-elevated |

Chief rulings: 7a.9 and 7a.13 stay elevated (a diff prompt per edit, no session grant, is the
accepted cost; 7a.13 is elevated for writes and ordinary for reads). Rows whose rationale is not
"this runs code" are pruned (`.nvmrc`, `.python-version`, `.vscode/extensions.json`, `.idea`
workspace files), so "elevated" keeps its meaning. The table is data, so a review change is a
one-line change per row. `elevated` is a flag on the classifier result, separate from `category`,
so permissions can change policy without touching the matcher.

### Classifier result, consistency across consumers

The classifier returns `{ category, elevated, access }` where `access` is one of `free`, `confirm`
or `deny`. The editor channels (`workspace.readFile`/`writeFile`) use `access` directly: `confirm`
shows the native dialog, `deny` returns `protected_path` (git internals) or `outside_workspace`
(AutoGeek internals). The agent tools use `elevated`: an elevated write is never session-grantable
and always shows a diff prompt, and `deny` is still denied. So `.git/config` and `.git/hooks/**`
are `confirm` for the editor and `elevated` for tools, `.git/{HEAD,index,objects/**}` are `deny`
for both, and every §7a row is `elevated`. One table drives both, tested by a consistency check
that every §7 and §7a row has an explicit `access` and `elevated` value.

The classifier is a pure function of `(canonicalRelativePath)` with a data-driven rule list, so the
permissions package can show the matched rule in the approval prompt.

## 8. Cross-cutting

| # | Case | Expected |
|---|---|---|
| 8.1 | every rejection carries a stable machine-readable code and never echoes file contents | all |
| 8.2 | error messages never include the credential store location or other users' paths beyond the offending input | all |
| 8.3 | the module performs no writes itself; resolution of a non-existent leaf creates nothing | all |
| 8.4 | property test: for random sequences of `..`, `.`, `/`, names, and generated symlinks, a path that the module allows always has a realpath with root as a segment-wise prefix | all |
| 8.5 | property test: allow/deny decision is stable under adding redundant `./` and `//` | all |
| 8.6 | the same table runs on macOS and Linux in CI; win32-only rows run lexically on all platforms and fully on a Windows runner when one exists | all |

## 9. GitRunner hardening (hostile repository)

Every `GitRunner` invocation: argv array only, no shell; scrubbed env containing only a fixed
allowlist (`PATH`, `HOME`, `LANG`/`LC_*`, `TMPDIR`) plus the allowlisted overrides `GIT_DIR`,
`GIT_WORK_TREE`, `GIT_INDEX_FILE`; `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` pointing at an
empty file, `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `GIT_EDITOR=:`, `GIT_ASKPASS` unset,
`GIT_EXTERNAL_DIFF` unset; and `-c core.fsmonitor=false -c core.hooksPath=<empty dir>
-c protocol.ext.allow=never -c core.pager=cat` (more as the tests demand). Tests build a real
hostile repository in a temp dir, each with a sentinel file the payload would create:

| # | Hostile setup | Expected |
|---|---|---|
| 9.1 | `.git/config` with `core.fsmonitor = <script>` | script does not run during `status` |
| 9.2 | `.git/hooks/pre-commit`, `post-checkout`, `post-merge`, `reference-transaction` executable | no hook runs for commit, checkout, or any runner call |
| 9.3 | `core.hooksPath` pointing at a directory inside the repo | overridden; no hook runs |
| 9.4 | `alias.status = !script` | runner never expands aliases (full subcommand names only; `status` runs real status) |
| 9.5 | `core.pager`, `pager.diff`, `core.editor`, `sequence.editor` set | no pager or editor is spawned |
| 9.6 | `diff.external`, `diff.<driver>.command`, `textconv` via `.gitattributes` | not executed by `diff`; runner passes `--no-ext-diff --no-textconv` |
| 9.7 | `filter.<name>.clean/smudge` with `.gitattributes` | not executed by `add`/`checkout` (filter drivers neutralized or the call refused) |
| 9.8 | `include.path` / `includeIf` pointing at a hostile file | not honored for the settings above |
| 9.9 | `core.sshCommand`, `credential.helper`, `url.<x>.insteadOf` | not executed; runner exposes no network subcommands in v1 |
| 9.10 | `protocol.ext.allow` override via submodule URL `ext::sh -c ...` | refused |
| 9.11 | repo owned by another user (`safe.directory` mismatch) | runner returns a typed `unsafe_repository` error; it never sets `safe.directory` itself |
| 9.12 | `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` passed in the caller's env | only the values given explicitly through the runner options are used |
| 9.13 | other `GIT_*` in the caller's env (`GIT_SSH_COMMAND`, `GIT_EXEC_PATH`, `GIT_CONFIG_PARAMETERS`) | dropped |
| 9.14 | caller passes an argument beginning with `-` as a ref or path | refused unless the runner builds it; paths follow `--` |
| 9.15 | output cap and timeout; abort kills the process group | typed errors; no orphan processes |
| 9.16 | env dump test: spawn a probe through the same env builder | contains no AutoGeek credential variables |
| 8.7 | the wire path schema in `core` and the main-side resolver run the same §1–§2 cases; every path the schema accepts must be handled by the resolver, and the schema is never looser than the resolver (chief ruling) | all |

## 10. Approved constants (named, each with a test)

| Constant | Value |
|---|---|
| `TERMINAL_HIGH_WATER_BYTES` | 256 KiB unacknowledged |
| `TERMINAL_LOW_WATER_BYTES` | 64 KiB unacknowledged |
| `READ_FILE_DEFAULT_MAX_BYTES` | 2 MiB |
| `READ_FILE_HARD_CAP_BYTES` | 16 MiB (over it: `too_large`) |

The file `version` token is an opaque string derived from SHA-256 of the bytes, size, and mtime.
The compare happens as late as possible before the atomic rename. A narrow race remains between
that compare and the rename (POSIX has no compare-and-rename); it is documented in the code and in
`docs/SECURITY.md`, not hidden.

## 11. Ignore state computed in-process, as data (`workspace.listDir` `ignored`)

The `ignored` flag, the file tree, the watcher and `glob`/`grep` all use one in-process ignore
matcher that parses `.gitignore` and `.ignore` files as text. It never runs `git` (not
`git check-ignore`, not `git status`), in trusted roots either, so the flag is identical in both
modes and a repository's config cannot make listing execute anything (chief ruling, reviewer note).
Rules follow gitignore semantics; where a case differs from git's behavior, git's documented
behavior wins and the case says so.

| # | Scenario | Expected |
|---|---|---|
| 11.1 | hostile `.git/config` (`core.fsmonitor`, `core.excludesFile` pointing at a script, `include.path`) and a hostile hook, then `listDir` on an untrusted root | sentinel file is never created; no child process is spawned (the test runs with a spawn guard that fails on any `child_process` call) |
| 11.2 | root `.gitignore` with `*.log`, `build/`, `!keep.log` | `a.log` ignored, `keep.log` not, `build` dir ignored, a file named `build` ignored only if it is a directory rule match (`build/` matches directories only) |
| 11.3 | anchored `/foo` vs unanchored `foo` | `/foo` matches only at the root of the directory that holds the `.gitignore` |
| 11.4 | nested `.gitignore` in `sub/` | applies only below `sub/`; deeper files win over shallower on conflict, last matching rule wins within a file |
| 11.5 | negation under an ignored parent (`build/` then `!build/keep`) | `build/keep` stays ignored (git does not re-include files whose parent directory is excluded) |
| 11.6 | `**` forms: `**/x`, `a/**`, `a/**/b` | match as documented for gitignore |
| 11.7 | trailing spaces, escaped `\#`, escaped `\!`, comment lines, blank lines, CRLF line endings, BOM | handled as git does |
| 11.8 | `.git/info/exclude` | honored if present (read as data) |
| 11.9 | global excludes (`core.excludesFile`, `~/.config/git/ignore`) | NOT read: the matcher never consults git config, so a repo cannot point it at another file; the user-level global file is out of scope in v1 and documented |
| 11.10 | `.ignore` files (ripgrep convention) | honored the same way as `.gitignore` |
| 11.11 | `.gitignore` is a symlink to a file outside the root | not followed (treated as absent), rule files must resolve inside the root |
| 11.12 | `.gitignore` is a directory or unreadable | treated as absent (a missing rule file is not an error, as in git) |
| 11.12b | input caps exceeded: rule file over 1 MiB, more than 10,000 rules per file, a line over 4 KiB, a path deeper than 128 segments, more than 1,000 rule files in one walk | the matcher returns typed error `ignore_limit_exceeded` naming the cap; never a hang, never a silent truncation. Consumers decide, each fail-closed (see 11.12c) |
| 11.12c | consumer behavior on `ignore_limit_exceeded` | `listDir` (display only) still succeeds: every entry gets `ignored: 'unknown'` and the output carries `ignoreRules: 'limit_exceeded'`, so the user can still browse a hostile folder and nothing is guessed (ag-ui's shape, accepted). `glob`/`grep`/agent tools return the typed error (an agent must not search on guessed rules). The watcher falls back to its fixed built-in excludes (`.git`, `node_modules`) and emits a degraded-state event, never an unbounded watch |
| 11.13 | pathological patterns (`*` repeated thousands of times, `a*a*a*a*b` on `aaaa...`, deeply nested `**`) | linear time by construction: patterns compile to a segment matcher run as a greedy two-pointer / NFA simulation with no backtracking and no `RegExp`. A fast-check test generates adversarial patterns and paths and asserts a wall-time bound and that the match count of steps is at most `O(pattern length * path length)` |
| 11.14 | case-insensitive volume (macOS) | pattern matching is case-sensitive as in git's default `core.ignorecase=false`; documented. On case-insensitive volumes the matcher uses the on-disk name, not the requested spelling |
| 11.15 | NFC vs NFD names | compared on the on-disk name, byte-exact; documented as git's behavior |
| 11.16 | `listDir` of `.git` itself | listed but flagged ignored; never expanded by the tree watcher |
| 11.17 | `ignored` entries are still listed (flag only), while `glob`/`grep`/the watcher skip ignored paths by default | tested per consumer |
| 11.18 | a sensitive file that is also gitignored (`.env`) | `ignored: true`, still `sensitive`; ignoring never lowers sensitivity |
| 11.19 | differential test against `git check-ignore --no-index -v --stdin -z`, run INSIDE `pnpm verify` (not an optional job), through the hardened `GitRunner` on a fixture repo the test creates itself (no hostile config). Corpus: negation, anchoring, directory-only, escapes, `**`, trailing spaces, CRLF, BOM, nested `.gitignore` precedence, `.git/info/exclude`, and a case-insensitive volume (a temp dir on a case-insensitive filesystem when available, else `core.ignorecase=true` fixtures). If the `git` binary is missing the test FAILS LOUDLY with a typed error; there is no skip | matcher decisions equal git's on every corpus item, except the documented divergences below |

### Known divergences from git (each an explicit decision)

| # | Divergence | Decision |
|---|---|---|
| D1 | global excludes (`core.excludesFile`, `~/.config/git/ignore`) are not consulted | repo-controlled config must not influence listing; documented in the matcher header; the differential test runs git with `GIT_CONFIG_GLOBAL` pointing at an empty file so both sides agree |
| D2 | `.gitignore` files that are symlinks leaving the root are treated as absent | git would follow them; we must not read outside the root |
| D3 | input caps (11.12b) | git has none; a typed error is the safe answer |
| D4 | tracked files: git's ignore rules do not apply to already-tracked files; the matcher reports a path's ignore state purely from the rules (`--no-index` semantics) | the flag means "matches an ignore rule", not "untracked"; documented for the UI |

Any further divergence found by the differential test must be added here before the test is allowed
to exclude it.
