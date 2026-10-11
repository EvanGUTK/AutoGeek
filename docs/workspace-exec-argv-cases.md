# Exec grant-clearing classifiers: `execMayRewriteVectors` and `simpleArgvOf`

Companion to `docs/workspace-path-cases.md` (§7a `isExecVector`) and
`docs/workspace-exec-env-cases.md`. Owner: ag-workspace (chief and ag-agent ruling, exec-grant hole).
Test table written before the code.

An approved `exec` / `exec_shell` session grant matches argv, not the files the command runs. Git
work-tree operations and installers can rewrite exec-vector files (Makefile, `package.json`,
lockfiles, hooks) without any write request, so after such a command the gate clears the root's
`exec` / `exec_shell` grants. Two pure functions behind the same core port as `isExecVector`:

```ts
execMayRewriteVectors(argv: readonly string[]): boolean   // true = may rewrite, gate clears grants
simpleArgvOf(command: string): readonly string[] | null
```

The port signature (agreed with ag-agent) takes no platform. The platform is bound when the classifier
is built (`createExecVectorClassifier({ platform })`, desktop passes `process.platform`); the tests
below call the pure functions with an explicit platform so win32 rows run on every CI host.

The gate treats `exec_shell` with `simpleArgvOf(...) === null` as mutating, so `make test` keeps its
grant, while `git checkout x && make test` clears. Direction of every error: **more clearing is
safe**, so every uncertain case returns "mutating" (`true`) or `null`.

Not covered (documented in `docs/SECURITY.md`, not hidden): programs a repository configures for read-only git commands (`core.fsmonitor`, `diff.<driver>.textconv`, `diff.external`, `core.pager`, which can run on `git status`, `diff`, `log -p` and `show`; writes to `.git/config` are elevated and the workspace must be trusted), script side effects (`make test` whose
recipe edits a Makefile; any `node x.js`, `python x.py`, `sh script.sh`), the user's own edits,
edits by other tools, and a repo-local executable named like a known one (`./git`).

## 1. `execMayRewriteVectors(argv)`

### 1.1 Executable normalization

The executable is `argv[0]` reduced to its basename (split on `/` and `\`), ASCII-lowercased, with a
trailing `.exe`, `.cmd`, `.bat` or `.ps1` removed. A name that starts with `git-` is the git
subcommand form (`git-checkout`). Empty `argv`, an empty `argv[0]`, or an argv element containing
NUL returns `true` (fail closed).

### 1.2 Wrappers are unwrapped, then classified

`env` (skipping `-i`, `-u NAME`, `NAME=value`), `command`, `exec`, `nohup`, `time`, `nice [-n N]`,
`timeout [opts] DURATION`, `setsid`, `sudo`/`doas` (skipping their options up to the command, and
`true` if an option is not understood), `xargs` (the command after its options),
`npx`/`pnpm dlx`/`pnpm exec`/`yarn dlx`/`yarn exec`/`npm exec`/`bunx`/`uvx`, and shells with
`-c <string>` (`sh`, `bash`, `zsh`, `dash`, `fish`; the string goes through `simpleArgvOf`, and
`null` means `true`). After unwrapping, the inner argv is classified. An unparseable wrapper form
returns `true`.

### 1.3 git: READ-ONLY allowlist, everything else mutating

Global options are skipped before the subcommand: `-C <path>`, `-c <k=v>`, `--git-dir[=]<p>`,
`--work-tree[=]<p>`, `--namespace[=]<n>`, `--exec-path[=<p>]`, `--super-prefix[=]<p>`, `--config-env[=]<kv>`,
`--no-pager`, `-p`/`--paginate`, `-P`, `--bare`, `--no-replace-objects`, `--literal-pathspecs`,
`--glob-pathspecs`, `--noglob-pathspecs`, `--icase-pathspecs`, `--no-optional-locks`. An unknown option
before the subcommand, a missing value, or no subcommand returns `true`, except that bare
`--version` and `--help` return `false`.

Read-only subcommands (allowlist): `status`, `diff`, `diff-tree`, `diff-index`, `log`, `show`,
`ls-files`, `ls-tree`, `rev-parse`, `rev-list`, `blame`, `grep`, `describe`, `cat-file`,
`shortlog`, `name-rev`, `show-ref`, `for-each-ref`, `merge-base`, `check-ignore`, `check-attr`,
`count-objects`, `whatchanged`, `var`, `version`, `help`. Everything else, unknown subcommands and
aliases included, is mutating. Even for an allowlisted subcommand the result is `true` if any
argument is one of: `--output`, `--output=*` (writes a file), `-O*`, `--open-files-in-pager*` (runs a
program), `--ext-diff`, `--textconv` (run configured programs), `--exec=*`, `--upload-pack*`.

### 1.4 Package managers: MUTATING denylist (first non-option word, after unwrapping)

| Tool | Mutating subcommands (a bare invocation counts as `install` where noted) |
|---|---|
| `npm` (READ-ONLY ALLOWLIST, like git; unknown words are mutating, so typo aliases such as `isntall`, `instal`, `it`/`install-test`, `cit`/`install-ci-test` and `npm i` variants are caught) | read-only: `test`/`t`/`tst`, `start`, `stop`, `restart`, `run`/`run-script`/`rum`/`urn`, `ls`/`list`/`la`/`ll`, `view`/`v`/`info`/`show`, `outdated`, `why`/`explain`, `audit` WITHOUT `fix`, `help`/`h`, `--version`/`-v`, `ping`, `doctor`, `fund`, `search`/`s`; `exec`/`x`/`npx` are wrappers. Options before the subcommand are skipped when known (`--prefix <p>`, `-C <p>`, `-w <ws>`/`--workspace[=]<ws>`, `-ws`, `--workspaces`, `--loglevel <l>`, `--silent`/`-s`, `--no-color`, `--userconfig <p>`, `--if-present`); an unknown option or no subcommand is `true`. Everything else is mutating, e.g. `install`, `i`, `add`, `ci`, `uninstall`, `rm`, `update`, `up`, `link`, `dedupe`, `rebuild`, `prune`, `init`, `version`, `pkg`, `set`, `config`, `audit fix`, `shrinkwrap`, `patch`, `pack` |
| `pnpm` (denylist: pnpm runs a package script for an unknown word, so an unknown word is `false`) | `install`, `i`, `add`, `remove`, `rm`, `uninstall`, `un`, `update`, `up`, `upgrade`, `link`, `ln`, `unlink`, `import`, `prune`, `dedupe`, `patch`, `patch-commit`, `rebuild`, `rb`, `approve-builds`, `config`, `set`, `self-update`, `setup`, `init`, `create`, `deploy`, `fetch`, `install-test`, `it`, `env`, `store` (bare `pnpm` with only options counts as help and is `false`) |
| `yarn` (denylist, as pnpm) | bare `yarn` (install), `install`, `add`, `remove`, `up`, `upgrade`, `upgrade-interactive`, `link`, `unlink`, `patch`, `patch-commit`, `dedupe`, `set`, `config`, `init`, `create`, `plugin`, `generate-lock-entry`, `import`, `policies`, `workspaces` (with `focus`/`foreach` it is classified as the inner command) |
| `bun` (denylist) | `install`, `i`, `add`, `a`, `remove`, `rm`, `update`, `link`, `unlink`, `patch`, `pm`, `init`, `create`, `upgrade`, `x`/`bunx` are wrappers |
| `pip`, `pip3`, `python -m pip`, `python3 -m pip`, `uv pip` | `install`, `uninstall`, `download` (writes files), `wheel`, `config`, `cache` |
| `uv` | `sync`, `add`, `remove`, `lock`, `venv`, `init`, `tool`, `python`, `pip` (as above), and `run` (it locks and syncs `uv.lock` and `.venv` by default; `false` ONLY with `--frozen` or `--no-sync`) |
| `python -m venv`, `python3 -m venv`, `virtualenv`, `corepack` (`use`, `up`, `install`, `enable`) | mutating: they create dependency directories (7a.20) or rewrite `package.json` |
| hook installers: `pre-commit install`, `pre-commit autoupdate`, `husky`, `husky init`, `husky install`, `lefthook install`, `simple-git-hooks` | mutating: they write `.git/hooks` or `.husky` |
| `poetry` | `install`, `add`, `remove`, `update`, `lock`, `init`, `self`, `env`, `config`, `build`, `new`, `sync` |
| `pipenv`, `pdm`, `hatch` | `install`, `uninstall`, `update`, `lock`, `sync`, `add`, `remove`, `init`, `new`, `run` is NOT mutating |
| `cargo` | `install`, `add`, `remove`, `update`, `fetch`, `vendor`, `generate-lockfile`, `fix`, `init`, `new`, `package`, `publish` |
| `go` | `get`, `mod` (every subcommand), `install`, `generate`, `work` (every subcommand), `fix`, `clean` |
| `bundle`, `gem` | bare `bundle` (install), `install`, `add`, `remove`, `update`, `lock`, `init`, `config`; `gem install`, `uninstall`, `update`, `build` |
| `composer` | `install`, `update`, `require`, `remove`, `init`, `create-project`, `dump-autoload`, `config` |
| `dotnet` | `restore`, `add`, `remove`, `new`, `tool`, `workload` |
| `brew`, `apt`, `apt-get`, `dnf`, `yum`, `pacman`, `apk` | `install`, `remove`, `uninstall`, `upgrade`, `update`: treated as mutating for the root only through shared state; listed for the gate's benefit |

Unknown executables (including `make`, `just`, `node`, `python`, `sh script.sh`, `pytest`) and
non-mutating subcommands of known tools (`npm test`, `npm run`, `pnpm run`, `cargo build`,
`cargo test`, `go build`, `go test`, `pip list`, `pip show`) return `false`. This is a documented
residual (their scripts and build steps may rewrite vectors).

### 1.5 Test table

| # | Input argv | Expected |
|---|---|---|
| A.1 | `['git','status']`, `['git','diff','--stat']`, `['git','log','-5']`, `['git','show','HEAD']`, `['git','ls-files']`, `['git','rev-parse','HEAD']`, `['git','blame','a.ts']`, `['git','grep','x']`, `['git','describe']` | `false` |
| A.2 | `['git','checkout','x']`, `['git','switch','x']`, `['git','reset','--hard']`, `['git','merge','x']`, `['git','rebase','x']`, `['git','pull']`, `['git','stash','pop']`, `['git','stash','apply']`, `['git','apply','p.diff']`, `['git','cherry-pick','x']`, `['git','revert','x']`, `['git','restore','.']`, `['git','clean','-fd']`, `['git','commit']`, `['git','add','.']` | `true` |
| A.3 | `['git','frobnicate']`, `['git','--bogus','status']`, `['git']`, `['git','-C']` (missing value) | `true` (unknown subcommand or unparseable) |
| A.4 | `['git','-C','sub','status']`, `['git','-c','core.pager=cat','status']`, `['git','--git-dir=.git','status']`, `['git','--git-dir','.git','--work-tree','.','log']`, `['git','--no-pager','diff']` | `false` (globals skipped) |
| A.5 | `['git','-C','sub','checkout','x']`, `['git','-c','alias.x=!sh','x']`, `['git','--git-dir=a','--work-tree=b','reset']` | `true` |
| A.6 | `['git','diff','--output=Makefile']`, `['git','log','--output','x']`, `['git','show','--ext-diff']`, `['git','grep','-Oless','x']`, `['git','diff','--textconv']` | `true` (read-only subcommand with a writing or exec flag) |
| A.7 | `['git','--version']`, `['git','--help']` | `false` |
| A.8 | `['GIT','checkout']`, `['Git.EXE','pull']`, `['/usr/bin/git','merge','x']`, `['C:\\\\Program Files\\\\Git\\\\bin\\\\git.exe','reset']`, `['./git','checkout']` (basename git, so treated as git), `['git-checkout','x']`, `['git-status']` | `true`, `true`, `true`, `true`, `true`, `true`, `false` |
| A.9 | `['git','st\\u0430tus']` (Cyrillic а), `['git','status ']`, `['git','Status']`, `['git','status\\u0000']` | `true` (not an exact allowlist match; subcommands are case-sensitive in git) |
| A.10 | `['git','checkout']` with a `NAME=value` element in the middle of argv | `true` |
| A.11 | `['npm','install']`, `['npm','i','left-pad']`, `['npm','ci']`, `['npm','update']`, `['npm','version','patch']`, `['npm','pkg','set','x=y']`, `['npm','config','set','x','y']`, `['npm','init','-y']`, `['npm','it']`, `['npm','install-test']`, `['npm','cit']`, `['npm','install-ci-test']`, `['npm','isntall']`, `['npm','instal']`, `['npm','--weird','test']` (unknown option) | `true` |
| A.12 | `['npm','test']`, `['npm','t']`, `['npm','run','build']`, `['npm','ls']`, `['npm','--version']`, `['npm','-w','pkg','run','x']`, `['npm','--prefix','sub','test']`, `['npm','audit']` | `false`; `['npm']` and `['npm','audit','fix']` are `true` |
| A.13 | `['pnpm','add','x']`, `['pnpm','up']`, `['pnpm','install','--frozen-lockfile']`, `['pnpm','patch','x']`, `['pnpm','dedupe']`, `['pnpm','-r','install']`, `['pnpm','--filter','a','add','x']` | `true` (options before the subcommand are skipped) |
| A.14 | `['pnpm','test']`, `['pnpm','run','lint']`, `['pnpm','-r','test']` | `false` |
| A.15 | `['yarn']`, `['yarn','install']`, `['yarn','add','x']`, `['yarn','set','version','4']` | `true` |
| A.16 | `['yarn','test']`, `['yarn','run','x']` | `false` |
| A.17 | `['bun','install']`, `['bun','add','x']`, `['bun','pm','trust','x']`, `['bun','run','x']` | `true`, `true`, `true`, `false` |
| A.18 | `['pip','install','x']`, `['python','-m','pip','install','x']`, `['python3','-m','pip','uninstall','x']`, `['uv','pip','install','x']`, `['uv','sync']`, `['poetry','add','x']`, `['poetry','install']` | `true` |
| A.19 | `['pip','list']`, `['pip','show','x']`, `['python','-m','pytest']`, `['pytest']`, `['uv','run','--frozen','pytest']`, `['uv','run','--no-sync','pytest']` | `false` |
| A.19b | `['uv','run','pytest']`, `['python','-m','venv','.venv']`, `['python3','-m','venv','x']`, `['virtualenv','x']`, `['corepack','use','pnpm@9']`, `['pre-commit','install']`, `['husky','init']`, `['lefthook','install']` | `true` |
| A.20 | `['cargo','add','x']`, `['cargo','update']`, `['cargo','install','x']`, `['cargo','vendor']`, `['go','get','x']`, `['go','mod','tidy']`, `['go','generate','./...']`, `['bundle']`, `['bundle','install']`, `['gem','install','x']`, `['composer','require','x']`, `['dotnet','add','package','x']` | `true` |
| A.21 | `['cargo','build']`, `['cargo','test']`, `['go','build']`, `['go','test','./...']`, `['go','vet']`, `['bundle','exec','rspec']` | `false` |
| A.22 | `['make','test']`, `['just','build']`, `['node','x.js']`, `['python','x.py']`, `['sh','script.sh']`, `['./script.sh']`, `['ls']`, `['cat','Makefile']` | `false` (documented residual: unknown executables) |
| A.23 | wrappers: `['env','git','checkout','x']`, `['env','-i','FOO=1','npm','install']`, `['env','-u','X','npm','test']`, `['nohup','git','pull']`, `['time','pnpm','add','x']`, `['nice','-n','5','git','merge','x']`, `['timeout','30','git','reset','--hard']`, `['sudo','-u','x','git','checkout']`, `['xargs','git','checkout']`, `['command','git','checkout']`, `['exec','git','pull']` | `true` |
| A.24 | wrappers over read-only or unknown: `['env','git','status']`, `['env','make','test']`, `['timeout','30','pnpm','test']` | `false` |
| A.25 | `['npx','pnpm','add','x']`, `['pnpm','dlx','git','checkout']`, `['pnpm','exec','git','pull']`, `['yarn','dlx','x']`, `['npm','exec','--','git','checkout']` | `true` for the ones whose inner command is mutating (the first, second, third, fifth); `['yarn','dlx','x']` is unknown, so `false` |
| A.26 | an ununderstood wrapper form: `['env','-S','git checkout']`, `['sudo','--weird','git','status']`, `['timeout']`, `['nice','-n']`, `['xargs']` | `true` |
| A.27 | shells: `['sh','-c','git checkout x']`, `['bash','-c','pnpm add x']`, `['bash','-lc','git pull']`, `['zsh','-c','git reset --hard']` | `true` |
| A.28 | `['sh','-c','git status']`, `['sh','-c','make test']` | `false` (inner command simple and not mutating) |
| A.29 | `['sh','-c','git status && git checkout x']`, `['sh','-c','git status; make']`, `['bash','-c','$(echo git) checkout']`, `['sh','-c','']`, `['sh','-c']` | `true` (`simpleArgvOf` returns `null`, or the form is incomplete) |
| A.30 | `['sh','script.sh']`, `['bash','./x.sh']`, `['sh']` | `false`, `false`, `false` (running a script file is a residual; a bare shell with no `-c` is interactive and unclassifiable but reads no argv, so `false`) |
| A.31 | `[]`, `['']`, `['git','checkout\\u0000x']`, `['git','a'.repeat(100000)]` | `true` (empty argv, empty executable, NUL element, over-long element beyond a 64 KiB cap) |
| A.32 | `['GIT','STATUS']` | `true` (the subcommand is case-sensitive; only the executable is folded) |
| A.33 | no-drift: every subcommand in the git allowlist and every mutating entry in §1.4 has a positive test row; a table-consistency test fails if an entry exists without a row | holds |
| A.34 | property: for any argv, adding a mutating wrapper in front never turns `true` into `false`; appending extra arguments to a `true` argv keeps `true` | holds |
| A.35 | `argv` is never mutated and the function is pure (frozen input accepted) | holds |

## 2. `simpleArgvOf(command)`

Returns the argv for **one simple POSIX shell command** only, otherwise `null`. Conservative by
construction: a small grammar is accepted and everything else, including anything uncertain, is
`null`. On `win32` (cmd.exe and PowerShell quoting differ) it always returns `null` and the gate
treats it as mutating.

`exec_shell` always runs `/bin/sh -c <command>`, never the user's login shell or zsh, so the grammar below is plain POSIX sh; the tool pins the shell to `/bin/sh` (S.26).

**Accepted grammar:** one or more words separated by spaces or tabs, with leading and trailing
spaces or tabs allowed. A word is a concatenation of:
- unquoted runs of characters from `[A-Za-z0-9_@%+=:,./-]` (ASCII only);
- single-quoted strings (any content except `'` and control characters other than tab);
- double-quoted strings whose content has no `$`, backtick, `\`, `!` or control characters other than tab.

Empty quotes (`''`, `""`) produce an empty word.

**`null` when any of these appear:** an unquoted or double-quoted `$` or backtick (substitution,
expansion); a backslash anywhere (escapes, line continuation); an unquoted `| & ; < > ( ) { } [ ] * ? ~ ! # ^`
(pipes, lists, redirects, subshells, braces, globs, tilde, history, comments); an unquoted `\n` or
`\r` or any other control character, NUL, or Unicode whitespace/bidi/format character; unbalanced
quotes; an empty command; ANY non-ASCII character anywhere (the result must not depend on the shell's locale, and `LANG`/`LC_ALL` are allowlisted env keys); a word that starts with `=` in any position (zsh `EQUALS` expansion, `=git`); a first word that is an env assignment (`NAME=...`) or empty (`''`); a first word that is
a reserved word (`if then else elif fi for while until do done case esac in function select time
coproc ! { }`); a command over 64 KiB; or any word that would start with `-` inside a here-string
form. Heredocs (`<<`) and line continuations fall under the characters above.

### 2.1 Test table

| # | Input | Expected |
|---|---|---|
| S.1 | `git status`, `  git   status  `, `git\tstatus`, `make test` | `['git','status']`, same, same, `['make','test']` |
| S.2 | `echo 'a b'`, `echo "a b"`, `echo a'b'"c"`, `echo ''`, `echo ""` | `['echo','a b']`, `['echo','a b']`, `['echo','abc']`, `['echo','']`, `['echo','']` |
| S.3 | `npm test -- --grep "x y"` | `['npm','test','--','--grep','x y']` |
| S.4 | `git checkout x && make test`, `a \| b`, `a; b`, `a \|\| b`, `a & b`, `a &` | `null` |
| S.5 | `cat < f`, `echo x > f`, `echo x >> f`, `cmd 2>&1`, `cmd <<EOF`, `cmd <<< x` | `null` |
| S.6 | `echo $HOME`, `echo ${HOME}`, `echo $(id)`, ``echo `id` ``, `echo "$HOME"`, `echo "$(id)"`, `echo "a`id`"` | `null` |
| S.7 | `ls *.ts`, `ls a?`, `ls [ab]`, `echo {a,b}`, `echo ~`, `echo ~root`, `echo a~` | `null` |
| S.8 | `FOO=1 make test`, `FOO=1`, `A=b C=d cmd`, `_X=1 cmd`, `a=b` | `null` |
| S.9 | `make FOO=1 test`, `cmd --opt=val` | `['make','FOO=1','test']`, `['cmd','--opt=val']` (assignment-like words after the first are plain arguments) |
| S.10 | `echo a\ b`, `echo a\`, `echo \$x`, `echo "a\"b"`, `echo 'a\b'` | all `null` (any backslash is `null`, even inside single quotes where it is literal, to stay conservative) |
| S.11 | `cmd arg # comment`, `# x`, `cmd #x` | `null` |
| S.12 | `(cmd)`, `{ cmd; }`, `! cmd`, `if x; then y; fi`, `for i in a; do x; done`, `time make`, `function f { x; }` | `null` |
| S.13 | `cmd\nother`, `cmd\r\nother`, `cmd\u0000`, `cmd \u001b[31m`, `cmd\u000bx` (VT), `cmd\u000cx` (FF), `cmd\u0085x` (NEL) | `null` |
| S.14 | any non-ASCII character: `cmd é`, `cmd "é"`, `cmd 'é'`, NBSP `cmd\u00a0x`, `cmd\u2028x`, zero width `cmd\u200bx`, RLO `cmd\u202ex`, BOM `cmd\ufeffx`, fullwidth `；`, `cmd 日本` | all `null` (E5; the cost is only a grant clear) |
| S.26 | `exec_shell` runs `/bin/sh -c` | a tool-level test asserts the spawned executable is `/bin/sh` with args `['-c', command]` and the env has no `SHELL` influence; `=git status`, `cmd =x`, `a =b` are `null` (S.27) |
| S.15 | unbalanced: `echo 'a`, `echo "a`, `echo a'`, `echo "a'b`, `echo '` | `null` |
| S.16 | `` (empty), ` `, `\t`, `''`, `"" x` | all `null` (empty command, or an empty first word) |
| S.17 | `win32` platform with `git status` | `null` |
| S.18 | `git status` on `darwin` and `linux` | same result on both |
| S.19 | double-quote traps: `echo "!"`, `echo "a!b"`, `echo "a!"` | `null` (history expansion in interactive bash) |
| S.20 | `echo -n`, `echo --`, `-rf`, `-`, `--` as first words | accepted as words; the first word is `-rf` etc. and is handled by the argv classifier |
| S.21 | reserved words as later words are plain arguments: `echo if then fi` | `['echo','if','then','fi']` |
| S.22 | length: 64 KiB command is accepted if valid, 64 KiB + 1 is `null` | holds |
| S.23 | `\\x7f` (DEL) anywhere | `null` |
| S.24 | `cmd "a\tb"` with a literal tab inside quotes | accepted (tab is allowed in quotes) |
| S.25 | alias or function names are not special: `ll`, `cd x` | `['ll']`, `['cd','x']` (builtins are plain argv; `cd x && y` is `null`) |

### 2.2 The invariant, tested against a real shell (guarded execution only)

**Invariant:** if `simpleArgvOf(c)` returns `argv`, then a real POSIX shell running `c` runs the
harness exactly once with exactly that `argv`.

**Safety rule (reviewer E1, adopted by the chief).** The earlier "closed grammar" design was not
airtight: bash lets a function be NAMED with the harness's absolute path (`H(){ H|H& };H` is a fork
bomb), an empty `PATH` element means the current directory on macOS `/bin/sh`, `$0` is a real shell,
and loops plus `&` repeat without bound. Safety cannot depend on the generator's model of "command
start". So: **a rejected string is NEVER executed, and an accepted string is executed only after an
independent guard confirms it is a single harness call over a harmless vocabulary.**

1. **Generation is free-form and never executed directly.** The generator produces candidate
   strings (adversarial, any characters, the S.* rows, the A.29 forms, operators, expansions,
   control characters, Unicode). Each goes to `simpleArgvOf` only.
2. **Rejected direction (no execution at all).** For every candidate where `simpleArgvOf` returns
   `null`, nothing runs. The checks are non-executing: (a) `sh -n` and `bash -n` (syntax check only)
   on the candidate; (b) a small independent **reference tokenizer** in the test (separate code from
   the parser, written from the POSIX grammar) classifies the candidate; a candidate the tokenizer
   shows to be one simple command with only plain words and quotes must also parse to the same words
   (so the parser is not wrongly strict beyond the documented conservative cases: backslash,
   non-ASCII, leading `=`, `$`, glob characters, which are an explicit list in the test). The
   direction "parser said null, the tokenizer says a pure multi-command or compound form" passes
   trivially.
3. **Accepted direction: two separate checks (reviewer G1).** Free-form generation produces strings
   the parser CORRECTLY accepts but that do not start with the harness (`git status`, `make test`).
   Those must not fail the test. So the guard is split:
   - **(3a) Parser-bug check, no execution.** For every accepted candidate, assert it contains NO
     unsafe character or construct: `;`, `&`, `|`, `<`, `>`, `(`, `)`, `{`, `}`, backtick, `$`,
     backslash, newline or any control character, any non-ASCII character, a word starting with `=`,
     or an unquoted glob/tilde/history/comment character. An accepted candidate with any of these
     FAILS the test immediately and is never executed (this is where a buggy parser accepting `a; b`,
     `$(x)` or `f(){ f|f& }` is caught).
   - **(3b) Execution gate.** An accepted candidate is executed ONLY IF its first word is exactly the
     harness path `<H>` and the whole string matches the independent regular language
     `^[ \t]*<H>([ \t]+(<unquoted>|'<sq>'|"<dq>")+)*[ \t]*$`, with `<unquoted>` =
     `[A-Za-z0-9_@%+:,./-]+`, and `<sq>`, `<dq>` = `[A-Za-z0-9 _@%+=:,./-]*`. Any other accepted
     candidate (first word not `<H>`) is NOT executed: its argv is compared against the reference
     tokenizer's argv instead.
   - `<H>` is matched **literally** (string prefix comparison plus escaping, never interpolated into
     the regex unescaped), and at setup the test asserts the full temp path matches
     `^[A-Za-z0-9/_-]+$` (reviewer G2), so it contains no metacharacter of any kind.
   - **Generation mix:** the generator produces plenty of `<H> ...` candidates (the harness path
     followed by adversarial and benign argument text) and the test asserts a **minimum executed
     count** (at least 1,000 of the 5,000 cases), so the executing path cannot silently go unused.
4. **Containment of the strings that do run** (defense in depth; they are harmless by construction):
   - No function definition, `(`, `)`, `{`, `}` or `$` can occur in an executed string (the guard
     forbids them), so no recursion or shadowing construct is reachable.
   - `PATH` is set to a **dedicated empty directory** (not the empty string), and cwd is the per-run
     temp directory.
   - The shell is started through a **non-generated wrapper** with a fixed prelude:
     `ulimit -t 2 -f 64 -n 32 -c 0` and, where supported, `-u` (process count) low; wall-clock
     timeout 2 s; stdout and record-file size caps; own process group, killed as a group on timeout
     or test abort; the per-run temp directory (mode 0700) is deleted afterwards.
   - Environment fully scrubbed (an empty env object to `spawn`), `HOME` unset, no network (the
     harness opens none).
   - **Per-shell flags:** `bash --noprofile --norc -c`; for dash/`sh` no profile flags (dash
     rejects them) and non-interactive; the test records which implementation `sh` is (macOS `sh` is
     bash in POSIX mode).
5. **Property (d):** for every executed string, in `sh` AND `bash`, the record and sentinel files
   show exactly one harness invocation, exit status 0, and the NUL-delimited argv equals the parsed
   `argv`. The harness is a tiny executable copied to the temp directory (mode 0555) that prints
   `argv[1..]` NUL-delimited to a fixed record file and touches a sentinel.
6. **Canary (e):** a deliberately broken parser (accepts `a; b`; a second variant accepts `$(x)`; a
   third accepts `f(){ f|f& };f` shaped input) is run through the same pipeline and the test MUST
   FAIL for each, at the guard, and a passing canary run fails the suite. The canary payloads are
   never executed, which a test asserts through the execution counter staying at zero for them.
7. **Adversarial corpus** is always included and always goes through the same pipeline: the S.* rows,
   the A.29 forms, `\r`, `\u0085`, bidi controls, NUL, `$'...'`, `\!`, here-strings, `{a,b}`, `~`,
   `<(x)`, `$((1))`, `&>`, `|&`, a trailing backslash, and the reviewer's three probes (a function
   named with the harness path, an empty-`PATH` cwd executable `a`, and `$0`). All must either be
   rejected by the parser or, if accepted, be rejected by the guard and fail the test.
8. At least 5,000 generated cases per run, a printed seed, shrinking on, a time bound on pathological
   inputs (100k quotes, deep nesting). `/bin/sh` and `bash` must exist or the test FAILS LOUDLY (no
   skip).
9. `fast-check` as a pinned devDependency, one exact version in the pnpm `catalog:` (whoever needs it
   first adds the entry, the other package reuses it), within the release cooldown, no
   `minimumReleaseAgeExclude`, justification in the commit body, and any pnpm config change disclosed
   (LEARNINGS L-002).

## 3. Wiring (for the gate)

- `exec`: the gate calls `execMayRewriteVectors(argv)`.
- `exec_shell`: `const argv = simpleArgvOf(command)`; `argv === null` means mutating, otherwise
  `execMayRewriteVectors(argv)`.
- An approved action that returns `true` clears the root's `exec` / `exec_shell` session grants
  (audited by the gate as `exec_vector_exec`). Persistent exact rules are not
  cleared and share the blind spot, which writes to exec-vector files being elevated mitigates
  (the user sees the diff).
- The git tools in `tools` additionally declare `mutatesWorkTree: true` (ruled), so they clear grants
  without going through argv.
- Both functions are exported from `@autogeek/workspace` and injected by desktop through the
  core port with `isExecVector`. A no-drift test shows the exported pair is built from the reviewed
  tables above (table-consistency test A.33).

Test minimum from ag-agent, all covered above: `git status` keeps; `git checkout x` clears;
`git -c alias.x=checkout x` clears and `git --git-dir=... checkout y` clears (A.5); `npm test` and
`npm run build` keep (A.12); `npm install` clears (A.11); `make test` keeps (A.22);
`git checkout x && make test` gives `null` from `simpleArgvOf` (S.4); any shell metacharacter gives
`null` (S.4 to S.7, S.11 to S.13). Unknown argv forms mean `false` only for unknown executables; for
git, unknown subcommands are mutating (fail closed).
