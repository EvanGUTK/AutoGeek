# Exec environment classifier: allowlist and test cases

Companion to `docs/workspace-path-cases.md`. Owner: ag-workspace (chief assignment,
agent-contract §1/§11). Test table for `classifyExecEnv`, written before the code.

An `exec` or `exec_shell` permission request may carry an `env` map of overrides. The run
environment is already scrubbed (`ARCHITECTURE.md` §8.4); these are the extra variables a caller
asks to add. The request is **elevated** (no session grant, always prompt) unless **every** key
passes the allowlist below. The allowlist is exclusive: a key that is not on it is not benign, with
no exceptions and no "probably harmless" tier. The never-benign list in §3 documents the
dangerous names and gives the prompt a reason code. It is not what makes them elevated.

```ts
classifyExecEnv(env: Record<string, string>, platform: NodeJS.Platform):
  | { outcome: 'refuse'; problems: Array<{ key: string; reason: RefuseReason }> }
  | { outcome: 'benign' }
  | { outcome: 'elevate'; offending: Array<{ key: string; reason: ElevateReason }> }
type RefuseReason = 'invalid_key' | 'invalid_value' | 'duplicate_key'
type ElevateReason = 'loader_injection' | 'interpreter_options' | 'search_path' | 'git' | 'proxy'
  | 'credential_shaped' | 'credential_access' | 'unknown_key'
```

Three outcomes (settled with ag-agent):
- **refuse:** the env is malformed, meaning a bad key, a value that fails its rule on an allowlisted
  key, a value containing NUL or longer than 32 KiB on ANY key, or a win32 case-duplicate. The tool returns a typed error result to the model **before any
  gate check**, with a precise message such as `env NODE_ENV: value rejected (reason:
  invalid_value); run without it or use a plain value`. No prompt, no effect, and the model can
  correct itself. This fails closed.
- **benign:** every key is on the allowlist with a valid value. The request is not elevated by env.
- **elevate:** a well-formed env with at least one key off the allowlist. The gate sees the literal
  action and always prompts; the reason code is for the prompt text.

Redaction stays separate and structural, and means only "a secret the user must not see": the tool
builds each entry as `EnvValue` (`redacted` or `plain`), and a value is `redacted` only when its key
is `credential_shaped`. Every other value is shown plain and literal in the prompt, including
the value of an elevated key such as `NODE_OPTIONS`, so the user sees what they approve. A pure
function of its inputs; no reading of `process.env`.

## 1. Allowlist (exact names, case-sensitive on posix)

| Key | Value rule | Rationale |
|---|---|---|
| `CI` | token | tools switch to non-interactive mode; no code path |
| `NODE_ENV` | token | library mode flag; read as data |
| `FORCE_COLOR` | `0`-`3` or `true`/`false` | output formatting |
| `NO_COLOR` | token | output formatting (no-color.org) |
| `CLICOLOR`, `CLICOLOR_FORCE` | `0`/`1` | output formatting |
| `COLORTERM` | token | terminal capability hint |
| `TERM` | token | terminal capability hint; used to look up terminfo by name, so the value is restricted to the token rule (no path separators) |
| `COLUMNS`, `LINES` | digits, at most 4 | output width; data only |
| `LANG` | locale token | locale choice |
| `LC_ALL`, `LC_COLLATE`, `LC_CTYPE`, `LC_MESSAGES`, `LC_MONETARY`, `LC_NUMERIC`, `LC_TIME`, `LC_PAPER`, `LC_NAME`, `LC_ADDRESS`, `LC_TELEPHONE`, `LC_MEASUREMENT`, `LC_IDENTIFICATION` | locale token | the standard locale categories, listed by name (no prefix rule, so the list fits core's exact-match `Set`). Safe because `LOCPATH` and `NLSPATH` are not allowlisted, so a value cannot point to attacker-controlled locale files |
| `TZ` | its own rule, not `token`: an IANA name `^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+){0,2}$` (`UTC`, `Europe/Berlin`, `America/Argentina/Buenos_Aires`; no `.` segments, no leading `/` or `:`), or a POSIX TZ string `^[A-Za-z]{3,6}[+-]?[0-9]{1,2}(:[0-9]{2})?([A-Za-z]{3,6})?$` | time zone name, never a file path: `TZ=../../tmp/x` would make libc load an arbitrary tzfile, a known parser attack surface |
| `PYTHONUNBUFFERED`, `PYTHONDONTWRITEBYTECODE` | `0`/`1` | pure flags. Other `PYTHON*` names are not allowlisted: `PYTHONPATH` and `PYTHONSTARTUP` run code |
| `RUST_BACKTRACE` | `0`/`1`/`full` | diagnostics output |

`token` means `^[A-Za-z0-9_.@+-]{0,64}$`: no whitespace, quotes, `$`, `` ` ``, `;`, `/`, `\`,
`:`, NUL or newline. The locale token also allows `=`-free forms like `en_US.UTF-8@euro`. Any value
that fails its rule gives `invalid_value`, and the whole call is refused. The allowlist stays
small on purpose: each added name needs a rationale and a test row. Proposed additions go through
ag-reviewer.

## 2. Key validity and the case-folding traps

A key must match `^[A-Za-z_][A-Za-z0-9_]*$` and be at most 128 characters, else `invalid_key`. That
rejects empty keys, keys with `=`, NUL, spaces, `.`, `-`, or any non-ASCII character before any
other check runs.

The allowlist is wired through core's `createAllowlistEnvKeyClassifier(list)`, which gives an
`EnvKeyClassifier { isBenign(key) }`: case-sensitive exact match through a `Set` on every platform,
and the factory rejects empty, over-long, NUL- or `=`-containing and prototype keys. That is the
first gate. The value rules, the duplicate-key rule, and the reason codes below are a second layer
in `classifyExecEnv`, which the tool runs **before** the gate. A value that fails its rule is
refused with a typed error (never hidden as `redacted`, since that marker is reserved for secrets and
a hidden suspicious value would make the user approve blind). The gate stays key-only, as approved.

Matching is ASCII-only. Never call `toUpperCase()`/`toLowerCase()` on a key. Locale-sensitive
folding maps non-ASCII characters onto ASCII ones (`'ı'.toUpperCase() === 'I'`, so a Turkish dotless
i would turn `cı` into `CI`; `'ſ'` folds to `S`; the Kelvin sign U+212A folds to `k`). Because the
key regex runs first, these keys are `invalid_key` and never reach a comparison.

Platform rule (simplified after review with ag-agent): the allowlist is **case-sensitive on every
platform**, because core's classifier is. On win32 `Ci` is the same variable as `CI` to the OS, but
the classifier calls it `unknown_key`, so it is elevated. That fails closed and avoids a
case-folding table. Two keys that differ only by ASCII case (`Ci` and `CI`) are `duplicate_key` on
win32, since the OS would pick one of them. The never-benign table in §3 is matched
case-insensitively (ASCII fold) on every platform, only to choose a reason code, so `Path` and
`Node_Options` on win32 report `search_path` and `interpreter_options` instead of a plain
`unknown_key`. (`NodeOptions` without the underscore is a different variable: `unknown_key`.)

## 3. Never benign (reason codes for the prompt)

Each is elevated on its own; the code only explains why. The rule is by name or by shape,
case-insensitive on every platform for this table, since a posix variable like `node_options` is
unusual and still worth a prompt.

| Pattern | Reason | Why it executes or leaks |
|---|---|---|
| `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED` | `interpreter_options` | `--require` runs code, a CA bundle or disabled TLS weakens network trust |
| `LD_*`, `DYLD_*` | `loader_injection` | `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES` load attacker libraries into every process |
| `PATH`, `PATHEXT`, `COMSPEC`, `SYSTEMROOT`, `WINDIR`, `PSModulePath`, `LOCPATH`, `NLSPATH`, `TMPDIR`, `HOME`, `USERPROFILE`, `XDG_*`, `SHELL` | `search_path` | change which binary, config, or locale file a later command resolves |
| `GIT_*` | `git` | `GIT_SSH_COMMAND`, `GIT_EXEC_PATH`, `GIT_CONFIG_*`, `GIT_ASKPASS` run commands; the git runner owns this namespace |
| `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `PS4`, `IFS`, `SHELLOPTS`, `BASHOPTS`, `ZDOTDIR` | `interpreter_options` | shells source or evaluate these on start |
| `PYTHONPATH`, `PYTHONSTARTUP`, `PYTHONHOME`, `PYTHON*` (all others) | `interpreter_options` | imports or runs attacker modules |
| `RUBYOPT`, `RUBYLIB`, `PERL5OPT`, `PERL5LIB`, `PERLLIB` | `interpreter_options` | `-r`/`-M` flags load code |
| `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `JDK_JAVA_OPTIONS`, `CLASSPATH` | `interpreter_options` | agent and classpath injection |
| `*_PROXY`, `*_proxy`, `NO_PROXY`, `ALL_PROXY` | `proxy` | redirects network traffic through an attacker host and can expose credentials |
| `*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`, `*_PASSWD`, `*_CREDENTIALS`, `*_AUTH`, `AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS`, and `NPM_CONFIG_*` names that carry auth (`*_auth*`, `*authToken*`, case-insensitive) | `credential_shaped` | smuggles or redirects credentials; the value is always redacted |
| `NPM_CONFIG_*` / `npm_config_*` (all other names) | `interpreter_options` | `npm_config_script_shell`, `npm_config_node_options` and `npm_config_ignore_scripts=false` change what runs, so the value is shown plain, never redacted (reviewer W5) |
| `SSH_AUTH_SOCK`, `GPG_AGENT_INFO` | `credential_access` | a socket path, not a secret: grants use of keys without exposing them; shown plain |
| anything else not on the allowlist | `unknown_key` | default deny |

## 4. Test table (each row is a table-driven case)

| # | Input | Platform | Expected |
|---|---|---|---|
| 4.1 | `{}` | all | benign |
| 4.2 | `{CI:'1'}` | all | benign |
| 4.3 | `{CI:'1', NODE_ENV:'test', FORCE_COLOR:'1', NO_COLOR:'1', TERM:'xterm-256color', LANG:'en_US.UTF-8'}` | all | benign |
| 4.4 | `{LC_ALL:'C'}`, `{LC_CTYPE:'en_US.UTF-8'}` | all | benign |
| 4.4b | `{LC_FOO:'C'}` | all | `unknown_key` (only the listed categories) |
| 4.5 | `{LC_:'C'}`, `{LC_all:'C'}`, `{LCALL:'C'}` | posix | `unknown_key` |
| 4.6 | `{CI:'1', NODE_OPTIONS:'--require /tmp/x.js'}` | all | not benign; offending only `NODE_OPTIONS` (`interpreter_options`) |
| 4.7 | `{node_options:'--require x'}` | posix | `interpreter_options` (never-benign table is case-insensitive) |
| 4.8 | `{Node_Options:'x'}`, `{NODE_OPTIONs:'x'}` | win32 | `interpreter_options` |
| 4.8b | `{NodeOptions:'x'}` | all | `unknown_key` (different name, not a case variant) |
| 4.9 | `{LD_PRELOAD:'/x.so'}`, `{DYLD_INSERT_LIBRARIES:'x'}`, `{DYLD_LIBRARY_PATH:'x'}`, `{LD_LIBRARY_PATH:'x'}` | all | `loader_injection` |
| 4.10 | `{PATH:'/x'}` | posix | `search_path` |
| 4.11 | `{Path:'C:\\x'}`, `{path:'x'}`, `{PATH:'x'}` | win32 | `search_path` for each |
| 4.12 | `{Path:'x', PATH:'y'}` | win32 | refused: `duplicate_key` (refusal wins over elevation) |
| 4.13 | `{Ci:'1'}` | posix | `unknown_key` |
| 4.14 | `{Ci:'1'}` | win32 | `unknown_key` (case-sensitive allowlist, fails closed) |
| 4.15 | `{CI:'1', Ci:'0'}` | win32 | `duplicate_key`, refused |
| 4.16 | `{CI:'1', Ci:'0'}` | posix | `unknown_key` for `Ci` (distinct variable), `CI` ok |
| 4.17 | `{'cı':'1'}` (dotless i), `{'ſ':'x'}`, `{'\u212A':'x'}` (Kelvin sign) | all | refused: `invalid_key` (non-ASCII), never matched to an ASCII name |
| 4.18 | `{'CI\u0000':'1'}`, `{'':'1'}`, `{'A=B':'1'}`, `{'A B':'1'}`, `{'A-B':'1'}`, `{'1A':'1'}` | all | refused: `invalid_key` |
| 4.19 | key of 129 characters | all | refused: `invalid_key` |
| 4.20 | `{GIT_SSH_COMMAND:'x'}`, `{GIT_DIR:'x'}`, `{GIT_CONFIG_COUNT:'1'}`, `{git_exec_path:'x'}` | all | `git` |
| 4.21 | `{BASH_ENV:'/x'}`, `{ENV:'/x'}`, `{PROMPT_COMMAND:'x'}`, `{IFS:'x'}` | all | `interpreter_options` |
| 4.22 | `{PYTHONPATH:'x'}`, `{PYTHONSTARTUP:'x'}`, `{PYTHONHOME:'x'}`, `{PYTHONWARNINGS:'x'}` | all | `interpreter_options` |
| 4.23 | `{PYTHONUNBUFFERED:'1'}` | all | benign |
| 4.24 | `{RUBYOPT:'-rx'}`, `{PERL5OPT:'-Mx'}`, `{JAVA_TOOL_OPTIONS:'-javaagent:x'}`, `{_JAVA_OPTIONS:'x'}` | all | `interpreter_options` |
| 4.25 | `{HTTP_PROXY:'x'}`, `{https_proxy:'x'}`, `{ALL_PROXY:'x'}`, `{NO_PROXY:'x'}`, `{npm_config_proxy:'x'}` | all | `proxy` for all five (`proxy` is checked before the `NPM_CONFIG_*` row, and the order is fixed in the test) |
| 4.26 | `{GITHUB_TOKEN:'x'}`, `{MY_API_KEY:'x'}`, `{DB_PASSWORD:'x'}`, `{AWS_ACCESS_KEY_ID:'x'}`, `{npm_config__authToken:'x'}`, `{NPM_CONFIG__AUTH:'x'}` | all | `credential_shaped`; the values are `redacted` |
| 4.26b | `{SSH_AUTH_SOCK:'/tmp/agent'}`, `{npm_config_script_shell:'/tmp/sh'}`, `{npm_config_node_options:'--require x'}`, `{npm_config_ignore_scripts:'false'}` | all | elevated with reason `credential_access` / `interpreter_options`; the values are `plain` and shown literally |
| 4.27 | `{NODE_ENV:'test; rm -rf /'}`, `{NODE_ENV:'a b'}`, `{NODE_ENV:'$(x)'}`, `{NODE_ENV:'a\nb'}` | all | refused: `invalid_value` |
| 4.28 | `{NODE_ENV:''}` | all | benign (the empty value is a valid token) |
| 4.29 | `{NODE_ENV: 'x'.repeat(65)}` | all | refused: `invalid_value` |
| 4.30 | `{TERM:'../../x'}`, `{TZ:'/etc/passwd'}`, `{TZ:':/x'}`, `{TZ:'../x'}`, `{TZ:'Europe/../x'}`, `{TZ:'a/b/c/d'}` | all | refused: `invalid_value` |
| 4.30b | `{TZ:'UTC'}`, `{TZ:'Europe/Berlin'}`, `{TZ:'America/Argentina/Buenos_Aires'}`, `{TZ:'EST5EDT'}`, `{TZ:'CET-1'}` | all | benign |
| 4.30c | a value containing NUL, or longer than 32 KiB, on ANY key (allowlisted, elevated or unknown) | all | refused: `invalid_value` before the gate (Node rejects NUL in env values at spawn, and an unbounded value would bloat the prompt) |
| 4.31 | `{FORCE_COLOR:'9'}`, `{COLUMNS:'abc'}`, `{COLUMNS:'12345'}` | all | refused: `invalid_value` |
| 4.32 | `{CI:'1', FOO:'x'}` | all | not benign; `FOO` is `unknown_key`; `CI` is not listed as offending |
| 4.33 | mixed: one benign key and one `GIT_DIR` | all | not benign for the whole request |
| 4.34 | prototype-pollution keys: `__proto__`, `constructor`, `toString` | all | `unknown_key`; the classifier iterates with `Object.entries` on an own-property check and never reads `env[key]` for inherited names |
| 4.35 | frozen vs mutable input | all | input is not mutated, output is a fresh object |
| 4.36 | property test: for generated maps, `benign` implies every key's ASCII-fold is on the allowlist and every value matches its rule | all | holds |
| 4.37 | property test: adding any key outside the allowlist to a benign map always makes it not benign | all | holds |
| 4.38 | redaction: `EnvValue` is `redacted` iff the key is `credential_shaped`; every other value is `plain` and literal in the prompt (`NODE_OPTIONS` shows its value) | all | holds |
| 4.38b | refusal harness: for every `refuse` row (4.12, 4.15, 4.17-4.19, 4.27-4.31), the conformance harness asserts the tool returns an error result, makes **zero** gate calls and causes **zero** effects, and the message names the key and reason code | all | holds |
| 4.38c | an `invalid_value` on an allowlisted key is refused even when another key is elevated; refusal is decided first | all | holds |
| 4.39 | `exec_shell` requests are always class `unknown` and always ask, so the env result adds a reason but never lowers the class | all | holds |
| 4.40 | the allowlist and the never-benign table are disjoint, with one stated exemption: the two allowlisted names `PYTHONUNBUFFERED` and `PYTHONDONTWRITEBYTECODE` are exempt from the `PYTHON*` pattern (a test asserts exactly these two exemptions and no others) | all | holds |
| 4.41 | no-drift: `createAllowlistEnvKeyClassifier(BENIGN_ENV_KEYS)` does not throw | all | holds (core cannot import this package, so this test lives here, next to the list) |
| 4.42 | no-drift: every key in `BENIGN_ENV_KEYS` has `isBenign(key) === true` on the exported classifier, so the factory dropped nothing | all | holds |
| 4.43 | the exported classifier is the factory's output: the module builds it through an injectable factory parameter, and a test passes a spy factory and asserts the exported classifier is exactly what the spy returned (a hand-written `isBenign` fails); a behavioral check also asserts `isBenign('__proto__')`, `isBenign('constructor')` and `isBenign('')` are false | all | holds |
| 4.44 | `BENIGN_ENV_KEYS` has no duplicates, every entry matches `^[A-Za-z_][A-Za-z0-9_]*$`, and none matches the never-benign table in §3 apart from the two `PYTHON*` exemptions in 4.40 | all | holds |

The platform argument is passed explicitly in every test so the win32 rows run on macOS and Linux
CI.
