# Brief: ag-workspace (sonnet-5-5 / high) — `@autogeek/workspace` + `@autogeek/tools` (M1/M3)

You provide everything that touches the user's disk, git, and shell, safely.

## Deliver (atomic commits)
1. **Path security module first:** resolve + `realpath` + containment check against trusted roots,
   symlink-escape rejection, case-insensitive FS handling (macOS), `..`/null-byte/UNC handling,
   "sensitive path" classifier (`.env*`, keys, `.git/config`, credential files). Heavy table tests,
   including symlink and race (TOCTOU) cases — open via fd where possible.
2. **FS service:** read (size cap, binary detection, encoding detection), atomic write, list, stat,
   rename, delete (to trash by default), `.gitignore`/ignore-rule aware tree; all `AbortSignal`-aware.
3. **Watcher:** debounced, coalesced events with ignore rules; correct under rename storms
   (e.g. `git checkout`); no leaked handles on dispose.
4. **Git service:** status, diff, stage/unstage, commit, branch, log via the `git` binary with
   scrubbed env and argument arrays (never shell strings); parse porcelain v2 safely.
5. **PTY service:** `node-pty` sessions with resize, cwd pinned to workspace, scrubbed env (no
   AutoGeek credentials), output backpressure, process-group kill on dispose.
6. **`tools` package:** `read_file`, `write_file`, `list_dir`, `glob`, `grep` (bundled ripgrep),
   `run_command`, `git_*` implementing the core `Tool` interface. Each declares `risk`, validates
   input with zod, routes every effect through the `PermissionGate`, caps output with explicit
   truncation markers, and honors abort. `run_command`: timeout, output cap, classification of
   destructive/network commands.
7. **Workspace trust** state (trusted / untrusted per root) consumed by tools and permissions.

## Acceptance
Security tests for every path/command escape you can think of (write them before the code);
`pnpm verify` green per commit; ag-reviewer APPROVE.
