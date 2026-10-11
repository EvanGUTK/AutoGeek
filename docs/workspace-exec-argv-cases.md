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

Not covered (documented in `docs/SECURITY.md`, not hidden): script side effects (`make test` whose
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
| `npm` | `install`, `i`, `add`, `ci`, `uninstall`, `remove`, `rm`, `un`, `update`, `up`, `upgrade`, `link`, `ln`, `unlink`, `dedupe`, `ddp`, `rebuild`, `rb`, `prune`, `init`, `create`, `version`, `pkg`, `set`, `config`, `audit` (with `fix`), `shrinkwrap`, `patch` |
| `pnpm` | `install`, `i`, `add`, `remove`, `rm`, `uninstall`, `un`, `update`, `up`, `upgrade`, `link`, `ln`, `unlink`, `import`, `prune`, `dedupe`, `patch`, `patch-commit`, `rebuild`, `rb`, `approve-builds`, `config`, `set`, `self-update`, `setup`, `init`, `create`, `deploy`, `fetch` (bare `pnpm` with only options counts as help and is `false`) |
| `yarn` | bare `yarn` (install), `install`, `add`, `remove`, `up`, `upgrade`, `upgrade-interactive`, `link`, `unlink`, `patch`, `patch-commit`, `dedupe`, `set`, `config`, `init`, `create`, `plugin`, `workspaces` (with `focus`/`foreach` it is classified as the inner command) |
| `bun` | `install`, `i`, `add`, `a`, `remove`, `rm`, `update`, `link`, `unlink`, `patch`, `pm`, `init`, `create`, `upgrade` |
| `pip`, `pip3`, `python -m pip`, `python3 -m pip`, `uv pip` | `install`, `uninstall`, `download` (writes files), `wheel`, `config`, `cache` |
| `uv` | `sync`, `add`, `remove`, `lock`, `venv`, `init`, `tool`, `python`, `pip` (as above) |
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
| A.11 | `['npm','install']`, `['npm','i','left-pad']`, `['npm','ci']`, `['npm','update']`, `['npm','version','patch']`, `['npm','pkg','set','x=y']`, `['npm','config','set','x','y']`, `['npm','init','-y']` | `true` |
| A.12 | `['npm','test']`, `['npm','run','build']`, `['npm','ls']`, `['npm','--version']`, `['npm']` | `false` |
| A.13 | `['pnpm','add','x']`, `['pnpm','up']`, `['pnpm','install','--frozen-lockfile']`, `['pnpm','patch','x']`, `['pnpm','dedupe']`, `['pnpm','-r','install']`, `['pnpm','--filter','a','add','x']` | `true` (options before the subcommand are skipped) |
| A.14 | `['pnpm','test']`, `['pnpm','run','lint']`, `['pnpm','-r','test']` | `false` |
| A.15 | `['yarn']`, `['yarn','install']`, `['yarn','add','x']`, `['yarn','set','version','4']` | `true` |
| A.16 | `['yarn','test']`, `['yarn','run','x']` | `false` |
| A.17 | `['bun','install']`, `['bun','add','x']`, `['bun','pm','trust','x']`, `['bun','run','x']` | `true`, `true`, `true`, `false` |
| A.18 | `['pip','install','x']`, `['python','-m','pip','install','x']`, `['python3','-m','pip','uninstall','x']`, `['uv','pip','install','x']`, `['uv','sync']`, `['poetry','add','x']`, `['poetry','install']` | `true` |
| A.19 | `['pip','list']`, `['pip','show','x']`, `['python','-m','pytest']`, `['pytest']`, `['uv','run','pytest']` | `false` |
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

**Accepted grammar:** one or more words separated by spaces or tabs, with leading and trailing
spaces or tabs allowed. A word is a concatenation of:
- unquoted runs of characters from `[A-Za-z0-9_@%+=:,./-]` (plus any character at or above U+0080 that is not whitespace, control, bidi, or format);
- single-quoted strings (any content except `'` and control characters other than tab);
- double-quoted strings whose content has no `$`, backtick, `\`, `!` or control characters other than tab.

Empty quotes (`''`, `""`) produce an empty word.

**`null` when any of these appear:** an unquoted or double-quoted `$` or backtick (substitution,
expansion); a backslash anywhere (escapes, line continuation); an unquoted `| & ; < > ( ) { } [ ] * ? ~ ! # ^`
(pipes, lists, redirects, subshells, braces, globs, tilde, history, comments); an unquoted `\n` or
`\r` or any other control character, NUL, or Unicode whitespace/bidi/format character; unbalanced
quotes; an empty command; a first word that is an env assignment (`NAME=...`) or empty (`''`); a first word that is
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
| S.14 | Unicode: NBSP `cmd\u00a0x`, `cmd\u2028x`, `cmd\u200bx` (zero width), `cmd\u202ex` (RLO), `cmd\ufeffx` (BOM), fullwidth `；` | `null` for whitespace, bidi and format characters; a fullwidth `；` (U+FF1B) is an ordinary character in sh, so it is part of a word: `['cmd','；']` is allowed only if the test confirms a real shell agrees (it does). Other ordinary non-ASCII letters are allowed |
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

### 2.2 The invariant, fuzzed against a real shell (safety design first)

**Invariant:** if `simpleArgvOf(c)` returns `argv`, then a real POSIX shell running `c` runs the
harness exactly once with exactly that `argv`.

**This test runs generated strings in real `sh` and `bash`, and the strings it hunts for are the
ones that smuggle commands.** A parser bug must not run a payload on a developer's machine. The
design below is mandatory and is written at the top of the test file as well (chief conditions).

1. **(a) Closed vocabulary, not free-form strings.** The generator emits a token sequence from a
   fixed grammar, never a free string.
   - A *command word* is always the **absolute path of the harness binary**, a literal token placed
     by the generator, never an expansion. It is emitted at every command-start context: the start
     of the string, after `;`, `&&`, `||`, `|`, `|&`, `&`, `(`, `{`, a newline, `then`, `else`, `do`,
     `$(`, `` ` ``, `<(` and `>(`, after `!` and `time`, and after assignment prefixes.
   - *Argument words* (and redirect targets, with a narrower set) come from a closed word list of
     plain letters and digits: `a b c x y z 0 1 foo`. No slash, dot, tilde, `$`, `=`, quote or
     backslash is part of a *word*; those characters appear only as separate, generator-placed
     syntax tokens (quote marks, `$`, `$(`, backtick, `\`, `*`, `?`, `~`, `{`, `}`, `#`, `!`, `;`,
     `|`, `&`, `<`, `>`, `(`, `)`, newline, tab, CR, NUL, U+0085, bidi and zero-width characters,
     `$'`, here-doc markers).
   - **Redirect targets** are drawn only from `a b c` (no expansion syntax in the target slot), so
     no file outside the per-run temp directory can be named. The harness path never appears in a
     redirect-target or argument slot.
   - **No builtin or exec-capable word is in the vocabulary.** A unit test builds the forbidden set
     from the shells themselves (`compgen -b` and `compgen -k` in `bash`, a fixed list for `sh`: `.`,
     `:`, `eval`, `exec`, `exit`, `kill`, `cd`, `trap`, `source`, `read`, `set`, `type`, `command`,
     `alias`, `wait`, `ulimit`, `umask`, `unset`, `export`, `readonly`, `shift`, `return`, `break`,
     `continue`, `times`, `getopts`, `hash`, `jobs`, `fg`, `bg`, `disown`, `enable`, `builtin`,
     `declare`, `local`, `let`, `mapfile`, `printf`, `echo`, `test`, `[`, `pushd`, `popd`, `dirs`)
     and asserts that no vocabulary word is in it. The structural keywords `if then else elif fi for
     in do while until done case esac select function time ! { }` are emitted only as generator
     syntax tokens in their legal positions; they cannot execute anything.
   - Any word that an expansion produces is also from the vocabulary (the harness prints only its
     arguments, which are vocabulary words), so even `$(harness a)` in an odd position can only
     yield `a`, which is "command not found" under an empty `PATH`.
   - A **grammar self-check** unit test asserts, over many generated strings, that the harness path
     token appears only in command-start positions and never inside the vocabulary, and that the
     vocabulary excludes `/`, `.`, `~` and the forbidden set.
2. **(b) The harness** is a tiny executable copied into a per-run temp directory with mode `0555`.
   It prints its `argv[1..]` NUL-delimited to a fixed record file in that directory and touches a
   sentinel file there, nothing else.
3. **(c) Isolation per case:** environment fully scrubbed (`env -i` equivalent: an empty env object
   passed to `spawn`), `PATH` empty, cwd = the per-run temp directory, `HOME` unset, no network by
   construction (the harness opens none, the vocabulary names no `/dev/tcp`), a hard wall-clock
   timeout and an output cap per case, spawned in its own process group and killed as a group on
   exit, timeout, or test abort. The temp directory is removed afterwards. The shells are run with
   `--noprofile --norc`, non-interactive, never with `-i`.
4. **(d) Property:** for every generated string where `simpleArgvOf` returns non-null `argv`, in
   `sh` AND `bash` the sentinel and record files show exactly one harness invocation with exactly
   that argv, exit status 0. Any second invocation (or the shell running anything else) fails the
   test; because the only runnable command word is the harness, a smuggled command can only show
   up as an extra harness record. A one-directional second property: where the shell recorded more
   than one harness call, or exited with a syntax error, `simpleArgvOf` returned `null`.
5. **(e) Canary:** a deliberately broken parser (it wrongly accepts `a; b`, and a second variant that
   accepts `$(...)`) is run through the same harness and the property MUST FAIL for it. A passing
   canary run fails the suite. This proves the test can catch the bug.
6. `sh -n` (syntax check only, nothing runs) is also run on every accepted string as an extra
   cross-check.
7. The shells are `/bin/sh` and `bash`. If either is missing the test FAILS LOUDLY with a typed
   error (no skip). On macOS `/bin/sh` is bash in POSIX mode; the test records which implementation
   ran.
8. **Fallback if (a) cannot be made airtight in review:** do not execute shells. Replace the
   property test with a differential test against a reference tokenizer plus `sh -n` for syntax
   only. ag-reviewer decides; the executing form is kept only if they accept the design above.
9. Runtime bound: pathological inputs (100k quotes, deep nesting characters) complete under a time
   bound; the parser is one linear pass. At least 5,000 generated cases per run, a printed seed,
   shrinking on, and adversarial seeds always in the corpus: the S.* rows, the A.29 forms, `\r`,
   `\u0085`, bidi controls, NUL, `$'...'`, `\!`, here-strings, `{a,b}`, `~`, `<(x)`, `$((1))`,
   `&>`, `|&`, and a trailing backslash, all written with the harness token in command positions.
10. Dependency: `fast-check`, one exact version in the pnpm `catalog:` (whoever needs it first adds
    the entry and the other package reuses it), within the release cooldown, no
    `minimumReleaseAgeExclude`, justification in the commit body, and any pnpm config change
    disclosed (LEARNINGS L-002).

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
