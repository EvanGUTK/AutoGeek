# `@autogeek/permissions` Implementation Plan (slice 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The permission engine behind every tool effect: rule matching, order-independent
evaluation, exact session grants, a fail-closed audit log, a userData rule store, and a gate that
asks a human through an injected approver. Hostile request content must never be able to change
the rule set.

**Architecture:** Pure modules (matching, evaluation, hard checks, grant keys) sit under a small
effectful shell: a JSONL audit sink, a JSON rule store, and an async gate with an abortable
approval mutex. `ApprovalBroker` implements `Approver` for desktop main and backs the
`permissions.*` channels. The package imports only `@autogeek/core`, `picomatch` and node
builtins.

**Tech Stack:** TypeScript (repo strict config), zod 4 (via core schemas), Vitest, fast-check
(dev), picomatch.

**Spec:** `docs/design/agent-and-permissions.md` §2 and `docs/agent-contract.md` §1–§3, §6, §7,
§11. The contract wins on any difference.

**Review slices** (chief: "if it grows past what one review can hold, split it"). Each one is
its own ag-reviewer request:
- **1a, policy engine:** Task 0 (`EnvKeyClassifier` port) and Tasks 1–4.
- **1b, grants, audit, store, gate:** Tasks 5–10. There's no exec-vector logic yet. Its hooks
  are absent, not stubbed.
- **1c, exec-grant clearing:** Task 11 (the `ExecVectorClassifier` and `ExecVectorChangeTap`
  ports, and `Tool.mutatesWorkTree`), Task 12 (gate triggers: exec-vector write, mutating exec,
  work-tree mutation), Task 13 (tap integration) and Task 14 (property tests). This slice is
  required before agent mode ships (M3), so it may land after the loop's first slices.

## Global Constraints

- Contract types come from `@autogeek/core` as foundation implements them: `PermissionAction`,
  `PermissionRequestInput`, `PermissionRequest`, `PermissionDecision`, `ApprovalOption`,
  `PolicyRuleInput`, `PolicyRule`, `DecisionVia`, `Risk`, `AgentMode`, `renderLiteral`,
  `Result`, `JsonValue`/`JsonObject`. **Re-check exact export names after rebasing onto the
  foundation merge.** Never redeclare a core type locally.
- No `any`, `@ts-*`, `eslint-disable`, chained assertions, skipped/focused tests, `catch {}`.
  Expected failures are `Result`s.
- Before every commit: `TURBO_FORCE=true pnpm verify` is green (L-001). Exact-pinned deps,
  justified in the commit body. Disclose every lockfile/workspace-config change (L-002).
- `picomatch` for `path_glob` only (options `{ dot: true }`, POSIX, root-relative). Command rules
  are exact argv / argv-prefix. `shell` and `url` rules are exact strings.
- Out-of-bounds requests are rejected, never truncated. Contract bounds:
  - `diff` ≤ 1 MiB; `mcp.input` ≤ 64 KiB serialized; `argv` 1..256, each element ≤ 32 KiB;
  - `command` ≤ 32 KiB; `url` ≤ 8 KiB, http(s) only; `description` ≤ 2 KiB;
  - `sensitiveReason` ≤ 256 chars.
- Evaluation order (contract §3):
  1. hard checks: invalid, aborted, mode, untrusted, outside root;
  2. deny;
  3. ask;
  4. allow (exact-only if elevated) or session grant;
  5. baseline (non-sensitive `fs_read` → allow, else ask).
- Elevated (contract §2, §11) = any of:
  - sensitive `fs_read` / `fs_write`;
  - `fs_write` with `diffOmitted`;
  - `exec` class `destructive` | `network`;
  - `exec` / `exec_shell` with any `{kind:'redacted'}` env value;
  - `exec` / `exec_shell` with any env key the injected `EnvKeyClassifier` doesn't call benign;
  - `network`.
- **Env (contract §11):**
  - `argv` / `argv_prefix` / `shell` rules never match a request with a non-empty `env`;
  - session-grant keys include `class` and canonical `env`;
  - grants are per root and cleared on root change and on `setTrust(false)`.
- **Exec-vector writes (contract §2; slice 1c):**
  - any `allow` for an `fs_write` (any op) whose `path` or `to` is an exec vector clears that
    root's `exec` / `exec_shell` session grants;
  - `fs_read`, `fs_write` and `mcp` grants stay;
  - audited as `grants_cleared` with reason `exec_vector_write`;
  - the predicate is the injected core port `ExecVectorClassifier` (ag-workspace's table);
  - a throw counts as an exec vector, plus a warning;
  - no classifier, no gate.
- **Work-tree mutation (chief ruling; slice 1c):** when a started call of a tool that declares
  `mutatesWorkTree: true` settles in any way, the agent calls `gate.noteWorkTreeMutated(...)`:
  - that call clears the root's exec / exec_shell grants;
  - it is audited as `grants_cleared` with reason `work_tree_mutated`;
  - a call that's rejected or skipped (never started) doesn't clear;
  - arbitrary exec / exec_shell doesn't clear, because that would nullify exec grants.
- **Exec that may rewrite exec vectors (chief ruling "A"; slice 1c).** On any `allow` for `exec`
  (`argv`) or `exec_shell`, the gate checks the port.
  - For `exec_shell`, the argv is `simpleArgvOf(command)`. `null` counts as mutating (fail
    closed).
  - If `execMayRewriteVectors(argv)` is true, or the port throws, call
    `grants.clearExec(rootKey)` and audit `grants_cleared` / `exec_vector_exec`.
  - The classification directions are ag-workspace's tables:
    - `git` uses a read-only ALLOWLIST: unknown subcommands, alias-looking tokens and
      unparseable global options are mutating;
    - package managers use a mutating DENYLIST, so `test`/`run`/`exec` keep grants;
    - unknown executables are non-mutating (a documented residual).
  - ag-workspace binds the platform when the classifier is built, which keeps the port
    signature. Known consequence: on win32 `simpleArgvOf` always returns `null`, so on Windows
    every approved `exec_shell` clears exec grants. Shell-string session grants are effectively
    single-use there. That's accepted as fail closed and must be stated in the user-facing
    approval docs. Argv `exec` grants are unaffected.
- **Change tap (slice 1c, chief-approved port #3):**
  - `ExecVectorChangeTap.subscribe` events `changed` / `degraded` clear that root's exec grants
    (audit `exec_vector_changed` / `watcher_unhealthy`);
  - before any exec / exec_shell allow that would come from a **session grant**, the gate calls
    `isHealthy` and then `await tap.flush(rootKey, signal)`, bounded by `tapFlushTimeoutMs`
    (default 1_500) combined with the request signal, and re-evaluates;
  - unhealthy, a timeout, a throw or a missing tap ⇒ clear exec grants, audit
    `watcher_unhealthy`, and fall back to ask. Never allow by grant on a failed flush;
  - while unhealthy, `offered` for exec / exec_shell omits `'session'`, and the decision's
    audit entry records `sessionWithheld: 'watcher_unhealthy'`;
  - the listener never throws: it clears first, then audits, and an audit failure goes to
    `onWarning`;
  - documented residual: one command that edits a vector and then runs it, and new vector
    files seen only through delayed native events.
- **The env-key allowlist is ag-workspace's** (L-005). permissions consumes it through the core
  port `EnvKeyClassifier`, which ag-agent defines in core in Task 0. The chief granted edit
  rights to that one file plus its one registration line. The classifier is never optional:
  no classifier, no gate, enforced at both type level and runtime.
- `offered` always includes `'deny'` and is exactly what main accepts:
  - in-root actions: `['deny','once']`, plus `'session'` iff not elevated;
  - outside root: policy deny, no prompt.
- Rule store unavailable ⇒ no rules **and no baseline auto-allow** (everything asks).
  Audit write failure ⇒ deny (`audit_failed`).
- Commits: Conventional, atomic, explicit `git add <paths>`, trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Rename with mixed coverage.** An `fs_write` rename where only `path` or only `to` matches an
   allow rule must not be allowed. Deny and ask rules apply if **any** action path matches; allow
   rules need **all** of them to match. (Task 2 test `rename requires every path for allow, any
   path for deny`.)
2. **A tool lying about its risk.** A tool declared `read` that submits `fs_write`/`exec`, or an
   `mcp` action from a `read` or `write` tool, is denied (`policy`, via `invalid`) in every mode,
   including `agent`. (Task 4 test `action inconsistent with declared risk is invalid`.)
3. **Abort while queued behind another prompt.** A check waiting on the approval mutex whose
   signal aborts must deny `aborted` immediately and must never be shown later. (Task 8 test
   `abort while waiting for the mutex never reaches the approver`.)
4. **Path spelling.** A realpath whose case differs from the root (macOS) is treated as outside,
   so it fails closed. `**/.env*` must match dotfiles; `src/*` must not match `src/a/b`.
   (Task 1 test `case-mismatched root is outside`; Task 2 globs.)
5. **Secrets in the audit log.**
   - env values, `Authorization: Bearer …`, `sk-…`/`ghp_…`/`AKIA…`-shaped tokens in commands
     and URLs are redacted;
   - diffs are never written (only their byte count);
   - (Task 6 test `audit entry redacts secrets and drops diff content`.)

---

### Task 0: `EnvKeyClassifier` port in core (chief-granted file; slice 1a)

**Files:**
- Create: `packages/core/src/ports/env-key-classifier.ts`, or the equivalent location in
  foundation's layout. It must be its own file.
- Test: `packages/core/src/ports/env-key-classifier.test.ts`
- Modify: core's `src/index.ts`, **one export line only**.

Nothing else in core is touched.

**Interfaces:**
- Produces:
  - `interface EnvKeyClassifier { isBenign(key: string): boolean }`. The doc comment states the
    semantics:
    - allowlist-only and fail closed: unknown ⇒ not benign;
    - case-sensitive exact match, never normalized in the permissive direction.
  - `isWellFormedEnvKey(key: string): boolean`: false for empty keys, keys longer than 256
    chars, and keys containing NUL or `=`.
  - `createAllowlistEnvKeyClassifier(allowlist: readonly string[]): EnvKeyClassifier`. It
    throws a `TypeError` (programmer error) if any allowlist entry is malformed or is
    `__proto__` / `constructor` / `toString` / any `Object.prototype` key. Lookups use a `Set`
    (never an object index). A malformed or prototype key is never benign, even if allowlisted.

  ag-workspace implements the port by calling this factory with its reviewed allowlist, so the
  invariants live in tested core code, not in each implementation.

- [ ] **Step 1: Write the failing tests:**
  - `CI` benign and `ci` not, when only `CI` is allowlisted;
  - unknown → false;
  - `''`, `'A'.repeat(257)`, `'A\0B'`, `'A=B'` → false, and they throw if allowlisted;
  - `'__proto__'`, `'constructor'`, `'toString'`, `'hasOwnProperty'` → false, and they throw if
    allowlisted;
  - fast-check: for any string `k` not in the allowlist, `isBenign(k) === false`.
- [ ] **Steps 2–4:** run → FAIL, implement, run → PASS.
- **No-drift test (chief), owned outside core.** core can't import ag-workspace's allowlist,
  so the test lives in `@autogeek/workspace`, next to the list:
  - `createAllowlistEnvKeyClassifier(BENIGN_ENV_KEYS)` doesn't throw;
  - every listed key `isBenign`;
  - the classifier the workspace exports is the factory's output, not a hand-written one.

  ag-agent asks ag-workspace to add it when the list lands. Before the slice 1b review
  request, check that it exists.
- [ ] **Step 5: Commit** `feat(core): add EnvKeyClassifier port for benign env keys`. The body
  cites the chief's grant (edit rights to this file only) and L-005.

### Task 1: Package scaffold and pure helpers

**Files:**
- Create: `packages/permissions/{package.json,tsconfig.json,vitest.config.ts}`, following
  foundation's stub-package pattern exactly (it already exists as a stub after the merge: modify,
  don't recreate).
- Create: `packages/permissions/src/internal/canonical-json.ts`, `src/internal/paths.ts`,
  `src/internal/action-risk.ts`
- Test: `packages/permissions/src/internal/{canonical-json,paths,action-risk}.test.ts`

**Interfaces:**
- Produces:
  - `canonicalJson(value: JsonValue): string`: sorted object keys, no whitespace.
  - `toRootRelative(realpath: string, rootRealpath: string): string | null`: POSIX separators;
    `''` for the root itself; `null` when outside, including case mismatch.
  - `actionPaths(action: PermissionAction): readonly string[]`: `fs_read` → `[path]`;
    `fs_write` → `[path]` or `[path, to]`; exec/exec_shell → `[cwd]`; network/mcp → `[]`.
  - `actionRisk(action: PermissionAction, declared: Risk): Risk`
  - `isRiskConsistent(action: PermissionAction, declared: Risk): boolean`

- [ ] **Step 1: Add the dependencies.** Pin `picomatch` (+ `@types/picomatch` only if the
  installed version has no bundled types) as a dependency and `fast-check` as a devDependency,
  both exact, with versions older than the pnpm release-age cooldown. Run `pnpm install`, then
  `git diff pnpm-workspace.yaml package.json` to check for silent config changes (L-002).
- [ ] **Step 2: Write the failing tests.**

```ts
expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
expect(toRootRelative('/w/src/a.ts', '/w')).toBe('src/a.ts');
expect(toRootRelative('/w', '/w')).toBe('');
expect(toRootRelative('/w2/a', '/w')).toBeNull();          // prefix trap
expect(toRootRelative('/W/a', '/w')).toBeNull();           // case-mismatched root is outside
expect(toRootRelative('/w/../etc', '/w')).toBeNull();
// isRiskConsistent table:
//   fs_read  ok for read|write|exec|network;
//   fs_write ok for write|exec;
//   exec/exec_shell ok for exec only;
//   network  ok for network only;
//   mcp      ok for exec|network.
```

- [ ] **Step 3: Run the tests.** `pnpm --filter @autogeek/permissions test`. Expected: FAIL
  (module not found).
- [ ] **Step 4: Implement.** `toRootRelative` uses `path.relative` on already-absolute
  realpaths. It returns `null` if the result starts with `..` or is absolute. It splits on
  `path.sep` and joins with `/`. `actionRisk` gives `mcp` the declared risk.
- [ ] **Step 5: Verify and commit.** `TURBO_FORCE=true pnpm verify` → green. Commit
  `feat(permissions): add canonical JSON, root-relative paths and action risk`. The body
  justifies the `picomatch`/`fast-check` pins and discloses the lockfile changes.

### Task 2: Rule matching

**Files:** Create `src/rules/match.ts`; Test `src/rules/match.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces: `ruleMatches(rule: PolicyRule, req: PermissionRequest, rootRealpath: string): boolean`.

Semantics:
- `tool` and `risk` filters are exact equality; absent means any.
- `ops` maps `fs_read` → `'read'` and `fs_write` → `op`.
- For `path` / `path_glob`: deny and ask rules match if **any** `actionPaths` element matches;
  allow rules only if **all** do. Outside-root paths never match.
- `argv` / `argv_prefix` match only `exec`. `shell` matches only `exec_shell`. `cwd`, when
  present, is compared root-relative. **None of the three ever matches a request whose `env`
  has at least one key** (contract §11).
- `url`: method compared uppercase, url exact.
- `mcp`: `server` equal, `tool` equal when given, `input` canonical-JSON equal when given.
- `any` matches everything.

- [ ] **Step 1: Write the failing table test** `describe.each(rows)` with at least these rows:
  - `path_glob '**/.env*'` matches `/w/.env` and `/w/a/.env.local` (dot:true);
  - `src/*` does not match `src/a/b`;
  - `argv_prefix ['git']` matches `['git','push']`, not `['git-lfs']`;
  - `argv ['npm','test']` doesn't match `['npm','test','--watch']`;
  - `shell 'npm test'` never matches `exec ['npm','test']`, and `argv` never matches `exec_shell`;
  - mcp `input` key order doesn't affect matching;
  - `rename requires every path for allow, any path for deny` (Review Focus 1);
  - `command rules never match a request with env`: `argv ['npm','test']`, `argv_prefix ['npm']`
    and `shell 'npm test'` vs the same request plus `env {CI:{kind:'plain',value:'1'}}` → no
    match, even for a benign key;
  - `risk: 'network'` + `any` matches the mcp action from a network tool only.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** One `switch (rule.match.kind)` with
  `assertNever`, and a picomatch matcher built per call from `glob` with `{ dot: true }`.
  **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(permissions): match policy rules against permission requests`.

### Task 3: Elevation, exactness and evaluation

**Files:** Create `src/policy/elevated.ts`, `src/policy/evaluate.ts`; Test `src/policy/*.test.ts`

**Interfaces:**
- Produces:
  - `isElevated(action: PermissionAction, env: EnvKeyClassifier): boolean`
  - `offeredOptions(action: PermissionAction, env: EnvKeyClassifier): readonly ApprovalOption[]`:
    in-root only; outside is handled by the hard checks.
  - `isExactRule(rule: PolicyRule): boolean`: `path`, `argv`, `shell`, `url`, and `mcp` with
    `input`.
  - `evaluate(args: { rules: readonly PolicyRule[] | 'unavailable'; grants: SessionGrantMatcher; req: PermissionRequest; root: { realpath: string; rootKey: string }; env: EnvKeyClassifier }): Evaluation`
  - `type Evaluation = { effect: 'allow'; via: 'rule' | 'session_grant' | 'baseline'; ruleId?: string } | { effect: 'deny'; via: 'rule'; ruleId: string } | { effect: 'ask'; via: 'rule' | 'default'; ruleId?: string }`
  - `interface SessionGrantMatcher { matches(rootKey: string, req: PermissionRequest): string | null }`
    (returns the grant id). Grants are per root, so an `mcp` grant (which has no path) never
    carries over to another root. Task 5 implements it; tests here use a stub.

- [ ] **Step 1: Write the failing tests.**
  - `elevated table`: every elevated case in Global Constraints is true; a plain in-root
    non-sensitive write with `diff` is false. Env rows, using a stub classifier where only
    `CI` is benign:
    - `{}` / no env → false;
    - `{CI: plain}` → false;
    - `{CI: redacted}` → true;
    - `{NODE_OPTIONS: plain}` → true;
    - `{Ci: plain}` → true (case matters, fail closed).
  - `offeredOptions` gives `['deny','once','session']` vs `['deny','once']`.
  - `precedence`: deny beats allow on the same request; ask beats allow.
  - `broad allow never covers an elevated action`: `path_glob '**'` allow + sensitive write →
    `ask`; exact `path` allow → `allow`.
  - `session grant allows non-elevated and is exact`.
  - `baseline`: non-sensitive read → allow/baseline; sensitive read → ask/default; write → ask.
  - `rules unavailable disables baseline`: `'unavailable'` + non-sensitive read → `ask`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** a single pass over the rules, collecting
  matching deny/ask/allow, then applying the precedence. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(permissions): evaluate rules with deny > ask > allow > baseline`.

### Task 4: Hard checks

**Files:** Create `src/policy/hard-checks.ts`; Test `src/policy/hard-checks.test.ts`

**Interfaces:**
- Produces: `hardCheck(req: unknown, ctx: { signal: AbortSignal; root: { realpath: string; trusted: boolean } | null }): { ok: true; req: PermissionRequest } | { ok: false; deny: Extract<PermissionDecision, { decision: 'deny' }>; via: DecisionVia }`
- Order:
  1. core `PermissionRequestSchema.safeParse` fails → `policy`/`invalid`;
  2. `!isRiskConsistent` → `policy`/`invalid`;
  3. aborted → `aborted`/`aborted`;
  4. mode `ask`|`plan` with declared or action risk ≠ `read` → `mode`/`mode`;
  5. root null or untrusted → `untrusted_workspace`/`trust`;
  6. any `actionPaths` element outside root → `policy`/`outside_root`.

- [ ] **Step 1: Write the failing tests:**
  - one per branch, in order (an aborted *and* invalid request reports `invalid`);
  - `action inconsistent with declared risk is invalid` (Review Focus 2);
  - `bounds are rejected not truncated`: a 1 MiB + 1 byte `diff` and a 64 KiB + 1 byte
    `mcp.input` → invalid. If core's schema lacks a bound, stop and raise it with ag-foundation /
    the chief; don't patch around it locally.
- [ ] **Steps 2–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat(permissions): add hard checks for validity, mode, trust and root`.
  **Then request a review of slice 1a** (Task 0 + Tasks 1–4) from ag-reviewer, per protocol §4.

### Task 5: Session grants

**Files:** Create `src/grants/session-grants.ts`; Test `src/grants/session-grants.test.ts`

**Interfaces:**
- Produces:
  - `grantKeyOf(rootKey: string, req: PermissionRequest): string`: `canonicalJson` of `rootKey`
    plus exactly the contract §2 key fields:
    - fs_read: `[tool,'fs_read',path]`
    - fs_write: `[tool,'fs_write',op,path,to??null]`
    - exec: `[tool,'exec',argv,cwd,class,env??{}]`
    - exec_shell: `[tool,'exec_shell',command,cwd,env??{}]`
    - `env` is canonicalized as an object, so key order doesn't matter. A redacted value can't
      reach a grant, because it makes the action elevated.
    - mcp: `[tool,'mcp',server,toolName,input]`
    - network: never a grant, so throw a programmer error.
  - `createSessionGrantStore(deps: { clock: () => number; newId: () => string }): SessionGrantStore`
  - `interface SessionGrantStore extends SessionGrantMatcher { grant(rootKey: string, req: PermissionRequest): SessionGrant; list(rootKey: string): readonly SessionGrant[]; revoke(id: string): boolean; clear(rootKey: string): readonly SessionGrant[]; clearExec(rootKey: string): readonly SessionGrant[] }`.
    `clear` and `clearExec` return the removed grants so the caller can audit them. `clearExec`
    removes only `exec` / `exec_shell` grants. Its callers arrive in slice 1c; it's tested
    here.
  - `interface SessionGrant { id: string; rootKey: string; key: string; tool: string; action: PermissionAction; createdAt: number }`

- [ ] **Step 1: Write the failing tests.**
  - a grant matches an identical request and not one that differs in a single key field (table
    over every field);
  - `description` and provenance don't affect the key;
  - a grant made under root A doesn't match the same request under root B;
  - `clear(rootKey)` removes only that root's grants and returns them;
  - `clearExec(rootKey)` removes only that root's exec and exec_shell grants;
  - an exec grant doesn't match the same argv with a different env value, an added env key,
    or a different `class`;
  - `revoke` removes the grant and returns false for an unknown id;
  - granting an elevated request throws. The gate never calls it for one, so this is a
    programmer error, not a `Result`.
- [ ] **Steps 2–4**, then **Step 5: Commit** `feat(permissions): add exact session grants`.

### Task 6: Redaction and audit sink

**Files:** Create `src/audit/redact.ts`, `src/audit/entry.ts`, `src/audit/jsonl-sink.ts`; Tests
alongside.

**Interfaces:**
- Produces:
  - `redactSecrets(text: string): string`: replaces matches with `⟦redacted⟧`. Patterns:
    `Bearer\s+\S+`, `sk-[A-Za-z0-9_-]{16,}`, `gh[pousr]_[A-Za-z0-9]{20,}`, `AKIA[0-9A-Z]{16}`,
    `(?i)(password|passwd|secret|token|api[_-]?key)=[^\s&]+`, `xox[baprs]-[A-Za-z0-9-]{10,}`.
    If foundation ships a core redactor, use it instead and delete this file.
  - `type AuditEntry = { v: 1; at: number } & ({ kind: 'decision'; provenance; tool; risk; action: AuditAction; literal: string; decision: PermissionDecision; via: DecisionVia; ruleId?: string } | { kind: 'gate_violation'; provenance; tool } | { kind: 'rule_added' | 'rule_removed'; rule: PolicyRule } | { kind: 'grant_added' | 'grant_revoked'; grant: { id; key } } | { kind: 'grants_cleared'; rootKey: string; reason: 'root_changed' | 'trust_revoked' | 'exec_vector_write' | 'exec_vector_exec' | 'work_tree_mutated' | 'exec_vector_changed' | 'watcher_unhealthy'; count: number })`
  - `toAuditAction(action: PermissionAction): AuditAction`: `diff` is replaced by
    `diffBytes: number`. Every plain `env` value, `command`, `argv` element and `url` goes through
    `redactSecrets`. `{kind:'redacted'}` env values stay as they are.
  - `interface AuditSink { append(entry: AuditEntry): Promise<Result<void, { code: 'audit_write_failed'; cause: string }>> }`
  - `createJsonlAuditSink(opts: { path: string }): AuditSink`: opens lazily with
    `fs.open(path, 'a', 0o600)` and serializes writes on a promise chain, one `write` per
    `JSON.stringify(entry) + '\n'`.

- [ ] **Step 1: Write the failing tests.**
  - `audit entry redacts secrets and drops diff content` (Review Focus 5);
  - the JSONL sink (real temp files) appends N entries from concurrent `append` calls as exactly
    N parseable lines with mode `0o600`;
  - an unwritable path → `Err('audit_write_failed')`, not a throw;
  - an existing file is appended to, never truncated.
- [ ] **Steps 2–4**, **Step 5: Commit** `feat(permissions): add redacting append-only audit log`.

### Task 7: Rule store and confirm text

**Files:** Create `src/store/rule-store.ts`, `src/store/confirm-text.ts`; Tests alongside.

**Interfaces:**
- Produces:
  - `interface RuleStore { load(rootKey: string): Promise<Result<readonly PolicyRule[], RuleStoreError>>; add(rootKey: string, input: PolicyRuleInput): Promise<Result<PolicyRule, RuleStoreError>>; remove(id: string): Promise<Result<void, RuleStoreError | { code: 'not_found' }>> }`
  - `type RuleStoreError = { code: 'store_unreadable' | 'store_corrupt' | 'store_write_failed'; cause: string }`
  - `createJsonFileRuleStore(opts: { path: string; clock: () => number; newId: () => string }): RuleStore`
    - The file holds `{ version: 1; global: PolicyRule[]; roots: Record<string, PolicyRule[]> }`,
      zod-validated on every load.
    - A missing file means empty.
    - Corrupt → `store_corrupt`; don't rewrite or "repair".
    - Writes go to a temp file in the same dir (mode 0o600), then `fsync` + `rename`.
    - `load(rootKey)` returns `global` followed by `roots[rootKey]`.
  - `describeRuleForConfirm(rule: PolicyRuleInput): string`: the literal rule, plus the exact
    contract phrases "Allow any command beginning with: " (`argv_prefix`, one element per line)
    and "with ANY input" (`mcp` without `input`). For `allow` rules of kind `argv`,
    `argv_prefix` or `shell`, it adds core's `PERSISTENT_EXEC_RULE_NOTICE` (Step 0 below). The
    string is imported, never retyped, so main's confirm and the renderer's rule editor show one
    string.

- [ ] **Step 0: Core constant (chief-granted, relayed from ag-ui).**
  - Create `packages/core/src/permissions/notices.ts` (its own file, plus one export line in
    core's `index.ts`) with
    `export const PERSISTENT_EXEC_RULE_NOTICE = 'This rule keeps applying even if scripts, Makefiles or package.json change' as const;`.
  - Its test pins the exact string.
  - Commit `feat(core): add the persistent exec-rule notice constant`. The body cites the
    chief's grant and says ag-ui consumes the same constant.
- [ ] **Step 1: Write the failing tests.**
  - round trip;
  - `scope` routes to global vs the root;
  - `kind:'any'` with effect allow is rejected by core's `PolicyRuleInput` schema refinement
    (raise it with foundation if that's missing);
  - corrupt JSON → `store_corrupt`, and the file is left byte-identical;
  - a concurrent `add` doesn't lose a rule (serialized writes);
  - confirm-text snapshots for argv_prefix and mcp any-input;
  - `command allow rules warn that they survive script changes`: argv, argv_prefix and shell
    allow rules contain `PERSISTENT_EXEC_RULE_NOTICE` (asserted by importing the constant),
    while deny/ask rules and path/url/mcp rules don't.
- [ ] **Steps 2–4**, **Step 5: Commit** `feat(permissions): add userData rule store and confirm text`.

### Task 8: The gate

**Files:** Create `src/gate/mutex.ts`, `src/gate/gate.ts`; Tests alongside.

**Interfaces:**
- Consumes: Tasks 3–7.
- Produces:
  - `createAbortableMutex(): { acquire(signal: AbortSignal): Promise<Result<() => void, 'aborted'>> }`.
    FIFO. An aborted waiter is removed from the queue and never acquires.
  - `interface Approver { request(prompt: ApprovalPrompt, signal: AbortSignal): Promise<ApprovalOption> }`
  - `interface ApprovalPrompt { approvalId: string; request: PermissionRequest; offered: readonly ApprovalOption[] }`
  - `interface DetailedDecision { decision: PermissionDecision; via: DecisionVia; ruleId?: string }`
  - `interface DetailedPermissionGate { checkDetailed(req: PermissionRequest, signal: AbortSignal): Promise<DetailedDecision> }`.
    Slice 1c extends it.
  - `createPermissionGate(deps: { workspace: { current(): { realpath: string; rootKey: string } | null }; trust: { isTrusted(realpath: string): boolean }; env: EnvKeyClassifier; rules: RuleStore; grants: SessionGrantStore; approver: Approver | null; audit: AuditSink; clock: () => number; onWarning(code: 'rules_unavailable', cause: string): void }): DetailedPermissionGate`

`createPermissionGate` throws a `TypeError` when `deps.env?.isBenign` isn't a function. That's
the runtime half; the required property is the type-level half. Test:
`gate refuses to construct without a classifier`.

Algorithm: design §2 steps 1–9. `approvalId = req.provenance.checkId`. The approver is raced
against `signal`. The audit `literal` is `redactSecrets(renderLiteral(action))`. An approver that rejects or returns a value outside `offered` → deny `user` /
`user_deny`, audited. On `'session'`, call `grants.grant(root.rootKey, req)` and audit `grant_added`. When the
audit append fails, return deny `policy` / `audit_failed`.

- [ ] **Step 1: Write the failing tests.** Use a scripted approver (deferred-based) and an
  in-memory audit sink that can fail on demand.
  - `allow once does not persist`: a second identical request asks again;
  - `session grant short-circuits the next identical request` (no second prompt);
  - `prompts are serialized and re-evaluated`: two concurrent identical requests; the first is
    answered `'session'`, and the second is allowed via `session_grant` without a prompt;
  - `abort while waiting for the mutex never reaches the approver` (Review Focus 3);
  - `abort during a prompt denies aborted and audits it`;
  - `no approver denies via no_approver`;
  - `approver answer outside offered is denied` (e.g. `'session'` for an elevated action);
  - `audit failure turns allow into deny audit_failed`;
  - `rules unavailable: warning raised, baseline disabled`;
  - `every decision is audited exactly once` (count entries over a mixed script).
- [ ] **Steps 2–4**, **Step 5: Commit** `feat(permissions): add the permission gate with abortable approvals`.

### Task 9: ApprovalBroker (the desktop-facing Approver)

**Files:** Create `src/broker/approval-broker.ts`; Test alongside.

**Interfaces:**
- Produces:
  - `createApprovalBroker(deps: { emit(e: BrokerEvent): void; grants: SessionGrantStore; rules: RuleStore; workspace: …same as gate…; confirm(text: string): Promise<boolean>; audit: AuditSink }): ApprovalBroker`
  - `interface ApprovalBroker extends Approver { respond(approvalId: string, option: ApprovalOption): Result<void, { code: 'not_found' | 'no_longer_pending' | 'invalid_input' }>; listPending(filter: (p: ApprovalPrompt) => boolean): readonly ApprovalPrompt[]; listSessionGrants(rootKey: string): readonly SessionGrant[]; clearSessionGrants(rootKey: string, reason: 'root_changed' | 'trust_revoked'): Promise<void>; revokeSessionGrant(id: string): Promise<Result<void, { code: 'not_found' }>>; listRules(): Promise<Result<readonly PolicyRule[], RuleStoreError>>; addRule(input: PolicyRuleInput): Promise<Result<PolicyRule, RuleStoreError | { code: 'user_declined' }>>; removeRule(id: string): Promise<Result<void, RuleStoreError | { code: 'not_found' }>> }`
  - `type BrokerEvent = { type: 'approval_requested'; prompt: ApprovalPrompt } | { type: 'approval_resolved'; approvalId: string; outcome: 'allowed_once' | 'allowed_session' | 'denied' | 'run_stopped' }`

Rules:
- `respond` with an option outside `offered` → `invalid_input`, and the request **stays
  pending**.
- A second `respond` → `no_longer_pending`.
- An aborted signal resolves the prompt as `run_stopped` and removes it.
- `addRule` with effect allow calls `confirm(describeRuleForConfirm(input))` first: false →
  `user_declined`, and nothing is written.
- Deny/ask rules skip the confirm.
- Rule changes and revocations are audited. `clearSessionGrants` writes one `grants_cleared`
  entry. desktop calls it on root change and on `setTrust(false)` (contract §11).
- Every native-dialog text passes through core's display-safe function (contract §11) before
  `confirm` sees it.

Window filtering stays with the caller (`listPending(filter)`). The agent runtime knows the
owner of each run.

- [ ] **Step 1: Write the failing tests:**
  - one per rule above;
  - `approval_resolved is emitted exactly once per approval on every path`.
- [ ] **Steps 2–4**, **Step 5: Commit** `feat(permissions): add approval broker for the permissions channels`.

### Task 10: Injection-invariant property tests, and the public surface

**Files:** Create `src/invariants.property.test.ts`; Modify `src/index.ts` (export only:
`createPermissionGate`, `createApprovalBroker`, `createSessionGrantStore`,
`createJsonFileRuleStore`, `createJsonlAuditSink`, `describeRuleForConfirm`, `isElevated`,
`offeredOptions`, and the types `Approver`, `ApprovalPrompt`, `DetailedDecision`,
`DetailedPermissionGate`, `AuditSink`, `AuditEntry`, `RuleStore`, `SessionGrant`,
`SessionGrantStore`, `ApprovalBroker`, `BrokerEvent`).

- [ ] **Step 1: Write the property tests** (fast-check, ≥ 500 runs each, deterministic seed
  printed on failure).
  - Arbitrary requests: valid or invalid, with every string field drawn from a hostile pool
    (rule-shaped JSON, `*`, `**`, `..`, absolute paths, NUL, CRLF, ANSI, RLO/zero-width,
    4-byte UTF-8, oversize). Arbitrary approver answers.
  - `rule set never changes`: the persistent `RuleStore` file is byte-identical before and after
    any number of `checkDetailed` calls.
  - `grants change only by an approved session answer`: after each check, the grant count
    increases by 1 iff the approver returned `'session'` for a non-elevated, in-root, valid
    request, and the new grant's key equals `grantKeyOf(rootKey, req)`.
  - `deny dominates`: if any deny rule matches, the decision is deny regardless of the answer.
  - `env never widens`: for any exec/exec_shell request R and any env E ≠ R.env, no exact rule
    and no session grant that allows R also allows R-with-E. Test `argv`/`shell` rules and the
    grant created by approving R with `'session'`.
  - `elevated env is never session-offered`: `offered` lacks `'session'` whenever env has a
    redacted value or a non-benign key.
  - `clear forgets`: after `clearSessionGrants(rootKey)`, every request previously allowed via
    `session_grant` under that root asks again.
  - `nothing is allowed without an affirmative allow`: every `allow` has via `rule`,
    `session_grant`, `baseline` or `user_once`/`user_session`, and an audit entry.
  - `index exports only the public surface`: an `Object.keys(await import('./index'))` snapshot.
- [ ] **Step 2: Run.** These should pass on the first run, since Tasks 1–9 implement the
  behavior. Any failure is a real bug: fix it in the owning module with a regression unit test
  there, not here.
- [ ] **Step 3: Verify and commit.** `TURBO_FORCE=true pnpm verify`, then commit
  `test(permissions): add injection-invariant property tests`. Then request a review of slice
  1b (Tasks 5–10) from ag-reviewer. Flag `argv_prefix` (classifier dependency, contract §3) for
  scrutiny, and add the SECURITY.md note, or ask its owner to.

### Task 11: Exec-vector ports and `Tool.mutatesWorkTree` in core (chief-granted; slice 1c)

**Files:** Create `packages/core/src/ports/exec-vector-classifier.ts`,
`packages/core/src/ports/exec-vector-change-tap.ts`, with tests alongside. Modify core's
`index.ts` (two export lines) and core's `Tool` definition (one field).

**Interfaces:**
- Produces, in `src/ports/exec-vector-classifier.ts` (its own file, plus one export line):
  `interface ExecVectorClassifier { isExecVector(canonicalRelativePath: string): boolean; execMayRewriteVectors(argv: readonly string[]): boolean; simpleArgvOf(command: string): readonly string[] | null }`.
  `simpleArgvOf` is a conservative shell-word parse. It returns argv only for a single simple
  command, and `null` for pipes, redirects, `;`/`&&`/`||`, `$()`/backticks, globs, env-assignment
  prefixes, heredocs, unbalanced quotes, line continuations, or anything uncertain.
  `execMayRewriteVectors` takes the basename of argv[0] (`/usr/bin/git`, `git.exe`) and skips
  git global options (`-C`, `-c`, `--git-dir=`, `--work-tree=`, …) before the subcommand. If
  that skip can't be done with certainty, it returns true.
  The doc comment for `isExecVector`, as agreed with ag-workspace:
  - input is POSIX, root-relative, with no leading `./`;
  - matching is anchored-pattern and case-INSENSITIVE (ASCII fold plus NFC/NFD), because more
    matches means more clearing, which is safer;
  - **malformed input** (empty, absolute, `..`, NUL, backslash, leading `./`, over the cap) ⇒
    `true`;
  - **valid unmatched paths ⇒ `false`**, so ordinary source and test edits never clear;
  - it never throws on a string.

  This is an interface only. ag-workspace's tests own the table, and core has no runtime code
  for it.
- Produces, in `src/ports/exec-vector-change-tap.ts`:
  - `type ExecVectorTapEvent = { rootKey: string; kind: 'changed' | 'degraded' | 'recovered' }`,
    with no path (chief ruling: no repository-controlled strings);
  - `interface ExecVectorChangeTap { subscribe(listener: (e: ExecVectorTapEvent) => void): () => void; flush(rootKey: string, signal: AbortSignal): Promise<void>; isHealthy(rootKey: string): boolean }`.

  The doc comment says:
  - the tap reacts to raw fs events from any cause, including ignored paths, but not
    dependency trees;
  - `flush` drains buffered events and rescans the known vector files;
  - `isHealthy` is false until the first full scan and while degraded;
  - the tap is asynchronous defense in depth, and the gate and loop triggers are primary.

  Interface only; ag-workspace tests the implementation.
- Also: add
  `readonly mutatesWorkTree: boolean` to core's `Tool` metadata. It's **REQUIRED, with no
  default** (chief), so no tool can silently opt out.

  The doc comment says:
  - true iff running the tool can rewrite workspace files without an `fs_write` gate check
    (git work-tree operations);
  - a started call clears the root's exec session grants when it settles in any way;
  - **bridged MCP tools declare `true` by default** (unknown effects, fail closed). Relaxing it
    for a specific read-only MCP tool is a user-visible, confirmed per-tool setting that ag-mcp
    designs later. This sentence is what ag-mcp's brief inherits.

  Tests (no `@ts-expect-error`, which is banned):
  - (1) `expectTypeOf<Pick<Tool<unknown, unknown>, 'mutatesWorkTree'>>().toEqualTypeOf<{ readonly mutatesWorkTree: boolean }>()`,
    which pins it as required, readonly and boolean;
  - (2) `omitting mutatesWorkTree fails to compile`: compile an in-memory fixture with the real
    TypeScript compiler API (`ts.createProgram` against core's tsconfig) that builds a `Tool`
    without the field, and assert exactly one diagnostic with code 2741 naming
    `mutatesWorkTree` (L-003: test the real command path).

  This change breaks every existing `Tool` literal. If foundation's stubs or anyone's merged
  tools exist by then, update them in the same commit, adding the field only, and list them in
  the body.

- [ ] **Commits** (atomic, in order; each body cites the chief's grant and L-005):
  1. `feat(core): add ExecVectorClassifier port`
  2. `feat(core): add ExecVectorChangeTap port`
  3. `feat(core): require mutatesWorkTree in tool metadata` (with its two tests)

### Task 12: Gate triggers for exec-grant clearing (slice 1c)

**Files:** Modify `src/gate/gate.ts`; Create `src/gate/exec-clearing.ts`; Test alongside.

**Interfaces:**
- Consumes: `ExecVectorClassifier` (Task 11), `SessionGrantStore.clearExec` (Task 5).
- Produces:
  - `createPermissionGate` deps gain `execVectors: ExecVectorClassifier`, which is required
    (runtime `TypeError` when missing);
  - `DetailedPermissionGate` gains `noteWorkTreeMutated(info: { tool: string; provenance: PermissionRequest['provenance'] }): Promise<void>`;
  - pure helper
    `clearingReason(req: PermissionRequest, root: string, execVectors: ExecVectorClassifier): 'exec_vector_write' | 'exec_vector_exec' | null`.
    A throw from the port counts as a positive, and the caller warns.

Behavior, after an `allow` (any via):
- `fs_write` with `path` or `to` an exec vector (root-relative) → `clearExec` + audit
  `exec_vector_write`;
- `exec` with `execMayRewriteVectors(argv)`, or `exec_shell` with `simpleArgvOf(command)`
  null-or-mutating → `clearExec` + audit `exec_vector_exec`;
- the audit is written even when nothing was removed;
- `noteWorkTreeMutated` → `clearExec` + audit `work_tree_mutated`. It never throws, and an
  audit failure goes to `onWarning`.

- [ ] **Step 1: Write the failing unit tests:**
  - one per trigger;
  - per-root only;
  - fs/mcp grants survive;
  - a port throw clears;
  - a denied write doesn't clear;
  - `gate refuses to construct without execVectors`.
- [ ] **Steps 2–5**, then commit `feat(permissions): clear exec grants on exec-vector writes and mutating exec`.

### Task 13: Tap integration (slice 1c)

**Files:** Modify `src/gate/gate.ts`; Create `src/gate/tap-guard.ts`; Test alongside.

**Interfaces:**
- Produces:
  - deps gain `tap: ExecVectorChangeTap` (required) and `tapFlushTimeoutMs?: number` (default
    1_500);
  - `DetailedPermissionGate` gains `dispose(): void`, which unsubscribes.

Behavior: the Global Constraints "Change tap" block. Before allowing via `session_grant` for
exec / exec_shell:
1. `isHealthy`, then a bounded `flush`.
2. Re-evaluate.
3. On any failure, clear, audit `watcher_unhealthy` and ask. A request-signal abort stays deny
   `aborted`.

- [ ] **Step 1: Write the failing tests** (chief's list, plus the flush constraints):
  - `a changed event clears that root's exec grants`;
  - `an event for another root clears nothing`;
  - `degraded clears and removes the session option until recovered`;
  - `flush runs before grant matching` (a scripted tap emits `changed` during `flush` → the
    exec asks);
  - `flush timeout fails closed` (fake timers);
  - `flush throw fails closed`;
  - `isHealthy throwing counts as unhealthy`;
  - `request abort during flush denies aborted`;
  - `rule-based allow does not wait for flush` (only session-grant allows do);
  - `dispose unsubscribes`.
- [ ] **Steps 2–5**, then commit `feat(permissions): integrate the exec-vector change tap`.

### Task 14: Exec-clearing property tests (slice 1c)

**Files:** Create `src/exec-clearing.property.test.ts`.

- [ ] **Step 1: Write the property tests** (fast-check, ≥ 300 runs) with a table-driven fake
  `ExecVectorClassifier` and a scripted tap:
  - `exec-vector write re-arms exec approvals` (chief):
    - grant `npm test` → approved write to `package.json` → the same exec asks again;
    - grant → approved write to `src/a.ts` → still allowed via `session_grant`;
    - a write to `package.json` under root A leaves root B's exec grants intact;
    - fs and mcp grants survive an exec-vector write;
    - a classifier that throws clears (fail closed);
    - write, delete and rename (source and destination) each clear when they touch an exec
      vector.
  - `mutating exec re-arms exec approvals` (chief). Use a table-driven fake port in this
    package; ag-workspace's real tables are tested in theirs:
    - grant `npm test`, then `git status` approved → still allowed;
    - `git checkout x` approved → asks again;
    - `git -c alias.x=checkout x` and `git --git-dir=/x checkout y` → clears;
    - `npm test` / `npm run build` approved → keeps; `npm install` → clears;
    - `exec_shell 'make test'` → keeps; `'git checkout x && make test'` → clears (`simpleArgvOf`
      returns null);
    - `exec_shell` with any metacharacter → clears;
    - an unknown executable → keeps;
    - a throwing port → clears.
  - `work-tree mutation re-arms exec approvals` (chief):
    - grant → `noteWorkTreeMutated` → the same exec asks again;
    - per root only;
    - fs and mcp grants survive.
    (That rejected or skipped calls don't trigger it, and that arbitrary exec never clears,
    are loop-side tests in the loop plan's Task 9.)
  - `tap events re-arm exec approvals` (chief):
    - user-edit `changed` → the granted exec asks again;
    - degraded → no `'session'` in `offered` until recovered;
    - any sequence of tap events never adds a grant.
- [ ] **Step 2: Verify and commit** `test(permissions): add exec-grant clearing property tests`.
  Request a review of slice 1c. Then add, or ask its owner to add, the SECURITY.md residuals:
  - one command that edits a vector and then runs it;
  - new vector files seen only through delayed events;
  - arbitrary scripts' side effects;
  - the user's own edits during the async window;
  - Windows shell-string grants being single-use;
  - **persistent exact command allow rules are never cleared** by any trigger (chief: explicit
    user choices, bounded because the agent's own writes to exec vectors are elevated). The
    confirm text and the rule editor say so.
