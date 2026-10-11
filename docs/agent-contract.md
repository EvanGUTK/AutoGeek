# Agent contract (authoritative): `AgentEvent`, permissions and approvals, `agent.*` / `permissions.*` IPC

Status: **ACCEPTED by the chief, 2026-10-11** (author: ag-agent). The chief's amendments to v2 are
marked **[chief]** inline and listed in §10. v1 was accepted with amendments; this version applies all of them: chief rulings
1–14 and A–D, the ag-ui review (`.agents/inbox/agent/…-ag-ui-agent-contract-review.md`), and the
effective-limits FYI. This file is the source of truth for these shapes in `@autogeek/core`.
ag-foundation implements every type below as a zod schema with inferred types. `JsonValue` and
`JsonObject` are as in `docs/model-contract.md`.

Change log v1 → v2 is in §9.

---

## 1. `PermissionAction`: one union for the gate, audit and approval UI

```ts
type Risk = 'read' | 'write' | 'exec' | 'network';
type ExecClass = 'safe' | 'destructive' | 'network' | 'unknown';
type FsWriteOp = 'create' | 'modify' | 'delete' | 'rename';
interface DiffOmitted { bytes: number; added: number; removed: number }   // non-negative ints
// [chief] Redaction is structural, never a magic string. A redacted value is one the user cannot see.
type EnvValue = { kind: 'plain'; value: string } | { kind: 'redacted' };

type PermissionAction =
  | { kind: 'fs_read';
      path: string;                       // absolute realpath (main-internal; see WireAction)
      requestedPath?: string;             // the path as requested, present only when it differs
      sensitive: boolean;
      sensitiveReason?: string }          // ≤ 256 chars; present iff sensitive
  | { kind: 'fs_write';
      op: FsWriteOp;
      path: string;                       // realpath; for 'rename' this is the source
      to?: string;                        // REQUIRED iff op === 'rename'
      requestedPath?: string;
      sensitive: boolean;
      sensitiveReason?: string;
      diff?: string;                      // unified diff of the exact write, tool-computed, ≤ 1 MiB
      diffOmitted?: DiffOmitted }         // XOR with diff; exactly one REQUIRED for op create|modify
  | { kind: 'exec';                       // non-shell spawn; argv is never flattened
      argv: string[];                     // 1..256 elements, each ≤ 32 KiB
      cwd: string;
      class: ExecClass;
      env?: Record<string, EnvValue> }    // [chief] overrides actually applied; redaction is structural (see below)
  | { kind: 'exec_shell';                 // a shell string; no class field (always treated as 'unknown')
      command: string;                    // ≤ 32 KiB
      cwd: string;
      env?: Record<string, EnvValue> }
  | { kind: 'network'; method: string; url: string }   // url: http(s) only, normalized by the tool, ≤ 8 KiB
  | { kind: 'mcp'; server: string; tool: string;
      input: JsonObject };                // ≤ 64 KiB serialized
```

zod refinements: `to` iff rename. `diff` XOR `diffOmitted`, exactly one for create/modify, either
or neither for delete, neither for rename. `sensitiveReason` iff `sensitive`. Every string is
bounded as annotated. **Out-of-bounds requests are rejected, never truncated.** The gate denies
them (`reason: 'policy'`, via `invalid`) and audits them. They're never shown to a human in a
trimmed form.

```ts
// Built by TOOLS and passed to ctx.gate.check(input, signal). No provenance, no literal.
interface PermissionRequestInput {
  tool: string;                           // ToolSpec name
  risk: Risk;                             // the tool's declared risk
  action: PermissionAction;
  description?: string;                   // ≤ 2 KiB, OPTIONAL model-written text; displayed only as
                                          // "Agent's description (not verified)"; never matched or audited as fact
}

// Built ONLY by ag-agent's call-scoped wrapper.
interface PermissionRequest extends PermissionRequestInput {
  provenance: { sessionId: string; runId: string; callId: string; checkId: string; mode: AgentMode };
}

type PermissionDecision =                 // unchanged (D-006)
  | { decision: 'allow' }
  | { decision: 'deny'; reason: 'policy' | 'user' | 'mode' | 'untrusted_workspace' | 'aborted' };

// core: pure, total, deterministic one-line rendering of an action (e.g. `shell: npm test  (cwd: .)`).
// Used for the audit log and the UI's fallback view. Tools never supply literal text.
declare function renderLiteral(action: PermissionAction): string;
```

`checkId` is unique per gate check. One tool call may make several checks.

## 2. Elevated actions and `offered`

```ts
type ApprovalOption = 'once' | 'session' | 'deny';
```

An action is **elevated** if any of these holds:
- `fs_read` / `fs_write` with `sensitive: true`
- `fs_write` with `diffOmitted` (the user could not see the write)
- `exec` with class `destructive` or `network`
- `exec` / `exec_shell` with ANY redacted env value [chief] (the user cannot see what is applied)
- `exec` / `exec_shell` with any env key outside the benign allowlist [chief] (fail closed; the allowlist,
  e.g. `CI`, `NODE_ENV`, `FORCE_COLOR`, is owned by ag-workspace's classifier and reviewed by ag-reviewer;
  keys such as `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `PATH`, `GIT_*`, `BASH_ENV`, `PYTHONPATH` are never benign)
- `network`

`offered` **always contains `'deny'` and is exactly the set main accepts**. A
`permissions.respondApproval` outside it is rejected with `invalid_input`, and the request stays
pending.
- In-root actions: `['deny', 'once']`, plus `'session'` when not elevated.
- Out-of-root actions are **denied by policy without a prompt** (via `outside_root`). If one ever
  reaches a prompt, `offered` is `['deny']`. The UI renders exactly `offered`.

`exec_shell` is session-grantable as the exact command string + cwd.

A **session grant** is an in-memory rule that matches **exactly** the approved action:
- fs_read: tool + path
- fs_write: tool + op + path + to
- exec: argv (element-wise) + cwd + class + canonical env [chief] (a grant never matches a different env)
- exec_shell: command + cwd + canonical env [chief]
- mcp: server + tool + canonical-JSON-equal input

Grants are keyed by the root realpath and cleared on root change and on `setTrust(false)` [chief]
(desktop calls `grants.clear(rootKey)`).
**Exec grants do not pin what the command runs** [chief]. A session grant for `make test` or `npm test`
matches argv, not the Makefile recipe or `package.json` script behind it. Therefore any *approved write to
an exec-vector file* (ag-workspace's elevated `exec_vector` set, including build/manifest files such as
`package.json` and Makefiles) CLEARS all `exec` / `exec_shell` session grants for that root, so the next
run asks again. (Edits to ordinary source and test files do not clear grants; those are the agent's normal
work and the user reviews their diffs.) Writes the tool never sees (the user's own edits, other tools)
cannot be detected, which `docs/SECURITY.md` must state.
The gate builds it from the request; nothing else can build one. The approver can only return an
`ApprovalOption`. Its lifetime is the app session, per root. It can be revoked via
`permissions.revokeSessionApproval`.

## 3. Policy rules (Settings editor; stored only in userData)

```ts
type PolicyRuleInput = {
  scope: 'global' | 'root';               // 'root' = the current workspace root (keyed by realpath in main)
  effect: 'allow' | 'deny' | 'ask';
  tool?: string;                          // exact tool name; absent = any tool
  risk?: Risk;                            // absent = any risk
  match:
    | { kind: 'any' }                                                     // effect 'deny' | 'ask' ONLY
    | { kind: 'path'; ops: Array<'read' | FsWriteOp>; path: string }      // exact, root-relative POSIX
    | { kind: 'path_glob'; ops: Array<'read' | FsWriteOp>; glob: string } // picomatch, root-relative, dot:true
    | { kind: 'argv'; argv: string[]; cwd?: string }                      // exact element-wise; cwd root-relative
    | { kind: 'argv_prefix'; prefix: string[]; cwd?: string }             // element-wise prefix, ≥ 1 element
    | { kind: 'shell'; command: string; cwd?: string }                    // exact string
    | { kind: 'url'; method: string; url: string }                        // exact
    | { kind: 'mcp'; server: string; tool?: string; input?: JsonObject }; // input absent = any input
};
type PolicyRule = PolicyRuleInput & { id: string; createdAt: number };
```

**Evaluation** is order-independent, and the first applicable step wins:
1. **Hard checks.**
   - invalid request → deny `policy`;
   - aborted signal → `aborted`;
   - mode ceiling (`ask`/`plan` with write, exec or network) → `mode`;
   - untrusted root → `untrusted_workspace`;
   - any path outside the trusted root → deny `policy` (`outside_root`).
2. **Any matching `deny`** → deny `policy`.
3. **Any matching `ask`** → ask.
4. **Any matching `allow`** or session grant → allow. Elevated actions are allowed only by an
   exact rule (`path`, `argv`, `shell`, `url`, `mcp` with `input`) or an exact session grant. A
   broad rule matching an elevated action falls through to ask.
5. **Baseline:** `fs_read` with `sensitive: false` → allow. Everything else → ask.

"Ask" resolves to deny when no approver is attached, the approver fails, or the run is aborted.
**If the rule store can't be loaded, the gate runs with no rules and no baseline auto-allow**,
so everything asks. A lost deny rule must never turn into an allow.

`exec_shell` is never matched by `argv`/`argv_prefix` rules, and `exec` is never matched by
`shell` rules.

**[chief] Env:** `argv`, `argv_prefix` and `shell` rules NEVER match a request with a non-empty env.
Rules carry no env in v1, so any env override asks (an exact `npm test` rule must not also approve
`NODE_OPTIONS=--require ./x.js npm test`).

An `mcp` allow rule with `input` absent allows ANY input for that tool [chief]; its native confirm
says literally "Allow ⟨server⟩/⟨tool⟩ with ANY input". (`mcp` is not in the elevated set, so such a
rule can match; session grants for `mcp` stay exact-input.)

**`argv_prefix` allow rules depend on the exec classifier.** The rule is only as narrow as
`argv[0]` resolution and argument parsing make it. The native confirm for one states literally
"Allow any command beginning with: ⟨argv elements, one per line⟩". docs/SECURITY.md records the
classifier dependency, and the slice that implements it is flagged for ag-reviewer.

Rules never come from tool output, file contents, `AUTOGEEK.md` or `AGENTS.md`. Their only
sources are `permissions.addRule` (Settings, native confirm for allow) and session grants
(`permissions.respondApproval`).

## 4. Events: internal `AgentEvent` vs `WireAgentEvent`

The loop emits **internal** events in main. These may carry absolute paths, full `Message`s,
`providerMetadata` and `structured` tool output. Exactly one projection,
`toWireEvent(event, ctx: { root: string })`, runs at the IPC boundary. It's an **allowlist**
with an exhaustive `switch` (`assertNever`), so a new event kind, action kind or content-part
kind without a wire mapping fails to compile. core exports `WireAgentEvent`, `WireAction`,
`WireMessage`, `WirePermissionRequest` and `WirePath`, and all of them have `toWire*` tests.

```ts
type AgentMode = 'ask' | 'plan' | 'agent';
type MentionKind = 'file' | 'folder' | 'symbol' | 'terminal' | 'git_diff';

interface RunBudgets {                    // defaults are FINITE; null only when the user explicitly lifts a cap
  maxSteps: number;                       // default 50
  maxTokens: number | null;               // default 2_000_000 [chief] (sum of input+cacheRead+cacheWrite+output over the run)
  maxWallMs: number | null;               // default 1_800_000 (30 min); pending approvals count against it
  maxSpendUsdMicros: number | null;       // default 2_000_000 ($2) [chief]; unpriced model ⇒ warning, tokens cap still applies
}
interface UsageTotals {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  reasoningTokens: number;
  costUsdMicros: number | null;           // integer; null = model unpriced
}
type ModelUsage = Omit<Extract<ModelEvent, { type: 'usage' }>, 'type'>;
interface Plan {                          // model prose: rendered as inert text
  summary: string;                        // ≤ 2 KiB
  steps: Array<{ title: string; detail?: string; files?: string[] }>;   // ≤ 50 steps; strings ≤ 2 KiB;
}                                         // files: ≤ 50, root-relative POSIX, no '..'
type AgentWarningCode =
  | 'spend_cap_unpriced'                  // spend cap set but model has no pricing
  | 'checkpoint_excluded_files'           // nested repos/gitlinks not snapshotted
  | 'context_near_limit'                  // estimate crossed the warning threshold of effectiveLimits
  | 'reasoning_dropped';                  // retried once with reasoningReplay 'drop'

type ToolRejectReason =
  | 'unknown_tool' | 'not_in_mode' | 'invalid_input' | 'invalid_json' | 'loop_detected'
  | 'tool_disabled';                      // disabled for the session after a gate violation

// [chief] The ONLY provider-error projection that leaves main (events, RunOutcome, IPC errors):
// {kind, retryable, status?, retryAfterMs?, requestId?}. No `detail`, no vendor text. The display message
// is derived from `kind` via core's constant table, never sent. `requestId` is schema-constrained
// (≤128 chars, [A-Za-z0-9._:-], otherwise dropped). This is the same shape as CoreError.details for
// domain 'provider' (see docs/model-contract.md and DECISIONS), so there is exactly one.
interface ProviderErrorSafe {
  kind: ProviderErrorKind; retryable: boolean;
  status?: number; retryAfterMs?: number; requestId?: string;
}

type RunOutcome =
  | { reason: 'end_turn' }
  | { reason: 'plan_submitted' }
  | { reason: 'aborted' }
  | { reason: 'budget'; budget: 'steps' | 'tokens' | 'time' | 'spend' }
  | { reason: 'max_tokens' }
  | { reason: 'refusal' }
  | { reason: 'provider_error'; error: ProviderErrorSafe }   // [chief] same shape on the wire as internally
  | { reason: 'loop_detected'; tool: string }
  | { reason: 'invalid_tool_calls' }
  | { reason: 'checkpoint_failed' }
  | { reason: 'gate_violation'; tool: string }   // a write/exec/network tool succeeded with no recorded allow
  | { reason: 'internal_error'; correlationId: string };
```

### 4.1 Internal `AgentEvent` (main only)

```ts
type ToolOutcome =
  | { kind: 'completed'; isError: boolean; truncated: boolean; content: ToolOutput;
      structured?: JsonValue; durationMs: number;
      ungated?: true }                    // set together with run outcome 'gate_violation'; content replaced by an error
  | { kind: 'rejected'; reason: ToolRejectReason; message: string }
  | { kind: 'skipped'; reason: 'aborted' | 'budget' | 'run_failed' }
  | { kind: 'interrupted'; message: string };

type AgentEvent =
  | { type: 'run_started'; sessionId: string; mode: AgentMode;
      model: { providerId: string; modelId: string; credentialLabel: string }; budgets: RunBudgets }
  | { type: 'user_message'; message: Message;
      display: { text: string; contextItems: Array<{ kind: MentionKind; label: string }> } }
  | { type: 'step_started'; step: number }
  | { type: 'text_delta'; step: number; text: string }
  | { type: 'reasoning_delta'; step: number; text: string }
  | { type: 'tool_call'; step: number; callId: string; name: string;
      input: JsonObject | { invalidRaw: string } }
  | { type: 'assistant_message'; step: number; message: Message }
  | { type: 'permission_decided'; callId: string; checkId: string; request: PermissionRequest;
      decision: PermissionDecision; via: DecisionVia }
  | { type: 'tool_started'; callId: string }
  | { type: 'tool_finished'; callId: string; outcome: ToolOutcome }
  | { type: 'tool_results'; step: number; message: Message }
  | { type: 'checkpoint_created'; checkpointId: string; phase: 'before' | 'after' }
  | { type: 'usage'; step: number; usage: ModelUsage; totals: UsageTotals }
  | { type: 'compacted'; compactionId: string; summary: string;
      replacedMessages: number; tokensBefore: number; tokensAfter: number }
  | { type: 'plan_proposed'; plan: Plan }
  | { type: 'warning'; code: AgentWarningCode; message: string }   // message: constant per code
  | { type: 'run_finished'; outcome: RunOutcome; totals: UsageTotals; steps: number };

type DecisionVia =
  | 'rule' | 'session_grant' | 'baseline'
  | 'user_once' | 'user_session' | 'user_deny'
  | 'mode' | 'trust' | 'outside_root' | 'aborted' | 'invalid' | 'audit_failed' | 'no_approver';
```

### 4.2 Wire forms (what crosses IPC)

```ts
// Paths on the wire are root-relative POSIX, or an explicit outside marker (never an absolute path).
type WirePath = string | { outside: true; basename: string };   // basename ≤ 255 chars
```

`WirePath` replaces `string` in **exactly** these fields of `WireAction`:
- `fs_read.path`, `fs_read.requestedPath`
- `fs_write.path`, `fs_write.to`, `fs_write.requestedPath`
- `exec.cwd`, `exec_shell.cwd`

Every other field is copied verbatim. `argv`, `command`, `url` and `input` are what will run,
shown exactly. The UI renders `{outside:true}` as "outside the workspace: ⟨basename⟩" and never
tries to open it.

```ts
type WireAction = /* PermissionAction with the WirePath substitutions above */;
interface WirePermissionRequest { tool: string; risk: Risk; action: WireAction; description?: string }

// Allowlist projection of Message: display data only. No providerMetadata, no adapter-opaque fields.
type WireContentPart =
  | { type: 'text'; text: string }                                    // ≤ 256 KiB, else cut with marker "[… N chars not shown]"
  | { type: 'reasoning'; text: string }                               // '' = "reasoning hidden"; same bound
  | { type: 'image'; mediaType: ImageMediaType; dataBase64: string }  // model-contract enum; ≤ 1 MiB decoded
  | { type: 'image_omitted'; mediaType: ImageMediaType; bytes: number }
  | { type: 'tool_call'; id: string; name: string; input: JsonObject }// ≤ 256 KiB serialized
  | { type: 'tool_call_omitted'; id: string; name: string; bytes: number }
  | { type: 'tool_result'; callId: string; isError: boolean; output: WireToolOutput };
type WireToolOutput = string | Array<Extract<WireContentPart, { type: 'text' | 'image' | 'image_omitted' }>>;
interface WireMessage { role: 'user' | 'assistant' | 'tool'; content: WireContentPart[] }  // system messages are not sent

type WireToolOutcome =
  | { kind: 'completed'; isError: boolean; truncated: boolean; content: WireToolOutput;
      durationMs: number; ungated?: true }   // `structured` is NOT sent in v1
  | { kind: 'rejected'; reason: ToolRejectReason; message: string }
  | { kind: 'skipped'; reason: 'aborted' | 'budget' | 'run_failed' }
  | { kind: 'interrupted'; message: string };
```

`WireAgentEvent` is the same set of `type`s as `AgentEvent`, with these differences:
- `user_message` → `{ type; text; contextItems }`. The expanded @-mention content never crosses
  IPC.
- `assistant_message.message` and `tool_results.message` → `WireMessage`.
- `tool_call.input` → `JsonObject` (≤ 256 KiB) | `{ invalidRaw: string }` (≤ 4 KiB, as in the
  model contract) | `{ omittedBytes: number }`.
- `permission_decided.request` → `WirePermissionRequest`.
- `tool_finished.outcome` → `WireToolOutcome`.
- `compacted.summary` is bounded to 64 KiB with a marker; the full summary stays inspectable in
  main.

Every other event is copied verbatim. With these bounds, every wire event is ≤ ~2.5 MiB, the
worst case being an approval or decision carrying a 1 MiB diff.

Envelope on IPC: `type AgentEventEnvelope = { runId: string; seq: number; at: number; event: WireAgentEvent }`, which is the `agent.event` payload.
- `seq` starts at 0 and is gap-free per run.
- `at` is epoch ms from main's clock.

**Invariants**, enforced by the loop's property tests:
1. `run_started` is first and `run_finished` is last, exactly once each.
2. Every `tool_call` gets exactly one `tool_finished` before `run_finished`.
3. `permission_decided` / `tool_started` fall between a call's `tool_call` and its `tool_finished`.
4. `user_message` + `assistant_message` + `tool_results` are exactly the transcript appends, and
   every `tool_call` part has exactly one `tool_result`.
5. Deltas are previews. The message events are the record of truth.

## 5. IPC: `agent.*` (owner: ag-agent)

**Window binding.** Every session and run belongs to the window (`webContents`) that created
it. A renderer-supplied `sessionId` or `runId` is looked up only among the calling window's own
sessions and runs; anything else is `not_found`.
- **`webContents` destroyed or `render-process-gone`:** main denies every pending approval of
  that window (outcome `run_stopped`) and aborts its runs.
- **Reload** (same `webContents`): runs and approvals stay alive. The renderer re-syncs via
  `agent.listRuns`, `agent.replay` and `permissions.listPending`.

| Channel | Input | Output | Errors (beyond universal) |
|---|---|---|---|
| `agent.send` | `{ sessionId: string \| null; mode: AgentMode; text: string (1..100_000); selection: { credentialId; modelId } }` | `{ sessionId; runId }` | `untrusted_workspace`, `not_found` (credential/model/session), `conflict` `{ kind: 'run_active' }` (a run, and therefore any pending approval, is active in the session) |
| `agent.stop` | `{ runId }` | `{}` | `not_found`. Idempotent: a finished run returns `{}` |
| `agent.listRuns` | `{}` | `{ runs: Array<{ runId; sessionId; mode; state: 'running' \| 'awaiting_approval' \| 'finished'; firstSeq: number; lastSeq: number; undone: boolean }> }` | none. Covers this window's active runs plus finished runs still in the replay buffer |
| `agent.replay` | `{ runId; fromSeq: number }` | `{ kind: 'events'; events: AgentEventEnvelope[]; more: boolean } \| { kind: 'gap' }` | `not_found`. At most 500 events AND at most 8 MiB per response [chief] (`more` = call again from the last seq + 1). `gap` = `fromSeq` was evicted |
| `agent.undoRun` | `{ runId; dryRun?: boolean; force?: boolean }` | `{ dryRun: true; restores: string[]; laterRuns: string[]; conflicts: string[] } \| { dryRun: false; restored: string[] }` | `not_found` (unknown run / run made no writes), `conflict` `{ kind: 'run_active' } \| { kind: 'paths_changed'; paths: string[] }` |
| `agent.getRunDiff` | `{ runId }` | `{ files: Array<{ path: string; from?: string; operation: 'create' \| 'modify' \| 'delete' \| 'rename'; binary: boolean; diff?: string; diffOmitted?: DiffOmitted }> }` | `not_found` |

Replay buffer [chief]: a bounded ring per run (≤ 5_000 events or 4 MiB), retained for this window's
10 most recent runs and capped at 32 MiB per window in total, evicting oldest first.

Undo:
- `undoRun` restores the workspace to the snapshot taken before that run's first write, which
  also reverts later runs (listed in the dry run's `laterRuns`).
- It truncates the session transcript to before that run's user message (truncate-to-prefix,
  per the append-only invariant).
- It takes a safety snapshot first.
- UI label: "Restore to before this message".

**Plan acceptance** is an ordinary `agent.send` with mode `agent` on the same session. The
session's transcript already contains the plan.

Paths in outputs (`restores`, `restored`, `conflicts`, `getRunDiff`) are root-relative POSIX.

### Events
- `agent.event`: §4.2 envelope.
- `agent.approvalRequested`: payload type `ApprovalRequestedPayload`:

```ts
{ approvalId: string;                     // = provenance.checkId
  runId: string; callId: string;
  request: WirePermissionRequest;         // tool, risk, action (WireAction), description?
  offered: ApprovalOption[];              // always includes 'deny'; exactly what main accepts
  context: { providerId: string; modelId: string; credentialLabel: string } }   // label only
```

- `agent.approvalResolved`: `{ approvalId; outcome: 'allowed_once' | 'allowed_session' | 'denied' | 'run_stopped' }`.
  - It's emitted for every approval, including ones resolved without the user.
  - There's no approval timeout. Wall-time budgets bound waiting.
  - Approvals in a run are presented one at a time, in arrival order.

## 6. IPC: `permissions.*` (owner: ag-agent)

| Channel | Input | Output | Errors |
|---|---|---|---|
| `permissions.respondApproval` | `{ approvalId; decision: ApprovalOption }` | `{}` | `not_found`, `no_longer_pending`, `invalid_input` (not in `offered`) |
| `permissions.listPending` | `{}` | `{ items: ApprovalRequestedPayload[] }` (this window's) | none |
| `permissions.listSessionApprovals` | `{}` | `{ items: Array<{ ruleId; toolName; action: WireAction; createdAt }> }` | none |
| `permissions.revokeSessionApproval` | `{ ruleId }` | `{}` | `not_found` |
| `permissions.listRules` | `{}` | `{ rules: PolicyRule[]; inactive: Array<{ rule: PolicyRule; reason: 'identity_changed' }> }` (global + current root; quarantined root rules are listed as inactive) | none |
| `permissions.reactivateRules` | `{ ruleIds: string[] (1..50) }` | `{ count: number; dropped: Array<{ ruleId; reason }> }` | `not_found`, `too_many`, `user_declined`; main builds a native confirm listing each valid rule literally (display-safe); all-or-nothing for the valid set, atomic write |
| `permissions.addRule` | `{ rule: PolicyRuleInput }` | `{ ruleId }` | `invalid_input`, `too_long` [chief] (the rule's native-confirm text would exceed its bound; rejected, never truncated), `user_declined` (native confirm refused) |
| `permissions.removeRule` | `{ ruleId }` | `{}` | `not_found` |

`addRule`:
- Rules with effect `allow` require a **native confirm shown by main** that renders the rule
  literally. For `argv_prefix`, the dialog says "Allow any command beginning with: …".
- Deny and ask rules only narrow, so they need no confirm.
- An approval prompt never creates a persistent rule.

## 7. Gate violations

If ANY tool (including `read` risk) returns `isError: false` and its call-scoped gate recorded
no `allow` [chief] (a baseline allow counts as recorded), main:
1. replaces the result with an error ("completed without a permission check; result withheld"),
   `ungated: true`;
2. audits `gate_violation`;
3. disables that tool for the rest of the session (later calls → `rejected` / `tool_disabled`);
4. finishes the run with outcome `gate_violation`. Unexecuted calls → `skipped` / `run_failed`.

The UI shows an error state, not a dismissable banner.

Applying this to `read` tools matters: a read tool that skips the gate is exactly how the
sensitive-path and outside-root rules would be bypassed. Tools with no effects at all are not
`Tool`s (e.g. plan submission is a loop-internal event). Error results without an allow are normal
(validation failed before any effect), so they aren't violations. ag-workspace's tool conformance harness (a fake gate asserting `check` precedes any
mutation) covers the remaining risk.

## 8. Limits the loop budgets against

The loop budgets and compacts against an **injected** `ModelLimits { contextWindow; maxOutputTokens }`
derived from `ModelInfo` by `@autogeek/providers`' `effectiveLimits()`. The defaults for unknowns
are context 8_192 and max output 4_096. agent never imports providers, and never uses a vendor's
advertised maximum directly. `context_near_limit` is emitted when the estimate crosses 80% of
the input budget (window − max output − 5%). A small-window fake-model test forces early
compaction.

Decided [chief]: normalized `usage.inputTokens` **excludes** cache read/write tokens (uncached input
only), so the token budget sums all four without double counting. Vendors differ (some report
cached tokens inside the input count), so each adapter normalizes and a conformance test enforces it
(see docs/model-contract.md).

## 9. Changes from v1

- Gate/IPC union:
  - `literal` was removed from `PermissionRequestInput`; core `renderLiteral(action)` replaces it (chief A).
  - `diff` XOR `diffOmitted`, with one required for create/modify. `diffOmitted` is elevated. `mcp.input` ≤ 64 KiB, rejected not truncated (chief 4).
  - `exec_shell` has no class field.
- `offered` is exactly what main accepts, always with `deny`. Outside-root actions are
  policy-denied without a prompt, which is tighter than a deny-only prompt (chief 2).
- `WirePath` zod and its field list. Internal vs wire events behind one exhaustive `toWireEvent`.
  `WireMessage` is an allowlist projection that never carries `providerMetadata` (chief 3, 5, B).
- `user_message` carries `display { text, contextItems }`, and the wire form drops the expanded
  context (chief 6).
- `undoRun`:
  - `dryRun` added;
  - `conflict` details `run_active | paths_changed`;
  - `getRunDiff` gains `rename`/`from` and `diffOmitted` (chief 7, 12).
- Plan acceptance is via `agent.send`. Plan bounds (chief 8).
- Money is integer micros. Budgets default to finite values, and pending approvals count
  against wall time (chief 9, C).
- `addRule` declines with error `user_declined`, and `argv_prefix` gets a literal confirm plus a
  SECURITY.md note (chief 10, D).
- Window binding, destroy/crash ⇒ deny + abort; `agent.listRuns`, `agent.replay` and
  `permissions.listPending` added (chief 1).
- `gate_violation` run outcome, tool disabled for the session, `tool_disabled` reject reason.
  The `ungated_tool` warning is removed (chief 14).
- New warnings `context_near_limit` and `reasoning_dropped`. `DecisionVia` enumerated.
  Injected `ModelLimits` (effective-limits FYI).

## 10. Chief amendments to v2 (2026-10-11)

- Default budgets are product defaults, user-adjustable: 50 steps, **2M tokens, $2**, 30 min.
  Unpriced cloud models are bounded by the token cap only, so the token default is conservative.
- `agent.replay` responses are bounded by bytes (8 MiB) as well as count; the replay buffer is bounded
  per run (4 MiB) and per window (32 MiB).
- Gate-violation detection covers every tool, `read` included.
- `usage.inputTokens` excludes cache tokens; adapters normalize.
- `mcp` allow rules with absent `input` require a confirm that says "ANY input".
- **One-time `reasoningReplay: 'drop'` retry trigger:** vendor-agnostic. On `invalid_request` when the
  request replayed reasoning parts carrying `providerMetadata`, the loop retries **at most once per
  run** with `reasoningReplay: 'drop'` and emits the `reasoning_dropped` warning. No new
  `ProviderError` field: adapters cannot reliably recognize edited-history 400s, a hint would
  depend on fragile vendor error-text matching, and a retry that fails for an unrelated reason just
  surfaces that second error. Revisit if adapters gain a reliable signal.

## 11. Further chief amendments (2026-10-11, on ag-agent's request)

- **Env (security).** Env is part of what runs. Session grants include canonical env and class in their
  key; policy rules never match a non-empty env; redaction is structural (`EnvValue`), a redacted value or
  a non-allowlisted key makes the action elevated; grants are cleared on root change and `setTrust(false)`.
- **`agent.listRuns`** entries carry `firstSeq` (oldest retained event) and `undone`. `undoRun` marks the
  undone runs; `agent.replay` still returns their events so history stays auditable, and the UI hides
  them via the flag.
- **Display-safe text.** core exports the display-safe function (specified in ui-spec, implemented by
  ag-foundation); main uses it for EVERY native-dialog text, including the `addRule` confirm.
- **Budgets** come from the `agent.budgets` setting (owner ag-ui, schema bounds required, e.g. maxSteps ≤
  1000), read by main at run start; the loop takes an injected `budgetsFor(): RunBudgets`. Lifting a cap
  to `null` requires a native confirm in the `settings.set` handler.

## 12. Exec-grant soundness and root identity (consolidated chief rulings, 2026-10-11)

These rulings were made in conversation with ag-agent, ag-workspace and ag-reviewer; this section is the
authoritative statement.

### 12.1 Core ports (each defined in core by its consumer under the chief's grant; implemented elsewhere)
- `EnvKeyClassifier { isBenign(key) }` (+ `createAllowlistEnvKeyClassifier`): allowlist-only, case-sensitive, fail closed; the gate refuses to construct without it.
- `ExecVectorClassifier`: `isExecVector(canonicalRelativePath)` (malformed ⇒ true, valid unmatched ⇒ false), `execMayRewriteVectors(argv)` (git: READ-ONLY allowlist, anything else mutating; package managers: MUTATING denylist; unknown executables non-mutating), and `simpleArgvOf(command): string[] | null` (conservative single-simple-command parse; null ⇒ the exec_shell counts as mutating). Implemented by ag-workspace from its reviewed tables.
- `ExecVectorChangeTap { subscribe(listener), flush(rootKey, signal), isHealthy(rootKey) }`, events `{rootKey, kind: changed|degraded|recovered}` with no path. Implemented by ag-workspace on raw fs events (any cause), excluding dependency trees, covering `.git/hooks` and `.git/config`.
- `Tool.mutatesWorkTree: boolean` is REQUIRED (no default). Bridged MCP tools declare `true` by default; relaxing it per tool is a user-confirmed setting designed by ag-mcp.

### 12.2 When exec/exec_shell session grants for a root are cleared (all per root, all audited)
1. `exec_vector_write`: an allowed `fs_write` touching an exec vector (rename checked on both sides).
2. `exec_vector_exec`: an allowed exec/exec_shell that `execMayRewriteVectors` marks mutating, or an exec_shell whose `simpleArgvOf` is null.
3. `work_tree_mutated`: a STARTED call of a `mutatesWorkTree` tool settles in any way (rejected or skipped calls do not trigger it).
4. `exec_vector_changed`: the tap reports a change; `watcher_unhealthy` / `watcher_degraded`: the tap is degraded, throws, times out, is missing, or `flush` fails.
Before allowing any exec via a session grant the gate awaits `tap.flush(rootKey)` (bounded, default 1500 ms, plus the request signal); a failed flush clears, audits and asks. While the tap is unhealthy, exec actions get no `session` option. NOT cleared after arbitrary exec (it would nullify grants).
Documented residuals (docs/SECURITY.md): one command that edits a vector and then runs it, command side effects, edits the tool/tap never sees, **persistent exact allow rules are not suspended** (explicit user choices; the agent's own writes to exec vectors are elevated so the user sees the diff). The native confirm and the rule editor carry `PERSISTENT_EXEC_RULE_NOTICE`, a core constant: "This rule keeps applying even if the files this command runs change (scripts, Makefiles, package.json, lockfiles, hooks)".

### 12.3 Root identity binds trust and root-scoped rules
- `rootKey` is an opaque token = realpath + identity, produced by ag-workspace's trust store (identity = `b:<ino>:<birthtimeNs>` when birthtime > 0, else `d:<dev>:<ino>`); the rule store never parses it.
- On open the trust store reports `{ rootKey, identityChanged, previousRootKeys }` (previous keys capped at 16). When `identityChanged`, desktop calls `rules.quarantine(previousRootKeys + currentRootKey)`: keys are marked in memory FIRST, then persisted; a failed persist means "rules unavailable" (no rules, no baseline, everything asks), never resurrection. Quarantine is a persisted flag in the rule store.
- The root opens UNTRUSTED with no session grants; quarantined rules are kept but inactive until `permissions.reactivateRules`; global rules are unaffected. Audit: `rules_quarantined`, `rules_reactivated`. Reactivation re-validates every rule; invalid ones stay quarantined and are reported in `dropped`.
- Restore at launch: the last folder reopens only if it exists AND its identity matches; a changed or unavailable root is never auto-opened (`root: null` plus an `identity_changed` notice held in store state and cleared by seq-bumping transitions). Restore never upgrades trust, never starts an agent run, never reapplies session grants.
