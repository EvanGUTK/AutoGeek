# IPC channels requested by the renderer

Owner of this document: ag-ui. **This is a request, not a contract.** `ag-foundation` owns the IPC
contract *format* in `@autogeek/core`. Each domain owner adds its own channels there; nobody edits
another owner's channels. The channel list is signed off by the chief; each owner still
confirms their group's shapes. Until the real handlers exist, the renderer is built against a mock of exactly the
client shape in §1.2, at the bridge boundary.

Derived from `docs/ui-spec.md` and `docs/briefs/ui.md`, under the constraints the chief set:
errors are values, streams are events, exactly two channels (`auth.addApiKey`, `auth.rotateApiKey`)
carry a secret, and no channel ever returns one.

Status: channel list signed off by the chief (2026-10-11) with amendments, applied below. Each
owner still confirms or amends the exact shapes of their own group.

## 1. Conventions

### 1.1 Wire rules (apply to every channel)

- Every channel is declared in `@autogeek/core` with a zod `input` schema and a zod `output`
  schema. Main validates input before the handler runs and output before it returns; the renderer
  validates events and results again on receipt (defense in depth, cheap).
- No wildcard channels, no channel names built from data. Event payloads are small and typed.
- Main verifies the sender (expected window and frame) on every call. A call from any other sender
  is rejected and not answered with detail. The channel format carries a per-channel sender
  allowlist (`allowedSenders`, default the primary app view), so a later split of views by role is
  configuration (D-010; §1.5).
- Paths crossing the bridge into main are **workspace-root-relative POSIX strings**, and the schema
  rejects NUL, backslash, empty and `.` segments, `..`, absolute paths, `file://` and over-long
  paths. In payloads going to the renderer, a path outside the root is the explicit
  `WirePath` `{ outside: true, basename }` form. Main resolves and `realpath`s them and enforces trusted-root
  containment and the sensitive-path rules (`ARCHITECTURE.md` §8.3) regardless of what the
  renderer claims. The only way the renderer names a location outside the current root is a native
  dialog that main itself shows (`workspace.openFolder`).
- Secrets: exactly two channels carry a secret, `auth.addApiKey` and `auth.rotateApiKey`, both
  renderer → main only. No other channel input, no channel output, no event, no error `details`,
  and no log line ever contains one. OAuth tokens never cross the bridge in either direction;
  `auth.oauth.begin` returns only a `CredentialRef`.
- Errors on **every** surface are projected: invoke results and event payloads alike (a
  `RunOutcome.provider_error` included) carry only an owner's closed `kind` and a constant
  message, never vendor text, response bodies, request ids or anything that could hold a key
  fragment. A vendor 401 body can echo part of a key, so that text stays in main's logs.
- Untrusted strings that reach a human (including native dialogs built in main) go through one
  display-safe function from `core` (`docs/ui-spec.md` §5.2).
- Cancellation: long operations are cancelled by an explicit channel keyed by an id (`agent.stop`,
  `terminal.kill`), not by dropping the promise.

### 1.2 Client shape (what the mock implements)

```ts
// Errors are values. Nothing throws across the bridge.
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

interface IpcError<D = never> {
  code: IpcErrorCode;
  message: string;      // safe to display; never contains a secret or a file's contents
  details?: D;          // per-channel errorDetails schema; typed, not unknown
}
// IpcErrorOf<C> = IpcError<ErrorDetailsOf<C>>: each channel declares its own errorDetails zod schema,
// so a switch on details.kind is exhaustive at compile time.

interface Bridge {
  invoke<C extends InvokeChannel>(channel: C, input: InputOf<C>): Promise<Result<OutputOf<C>, IpcErrorOf<C>>>;
  subscribe<E extends EventChannel>(event: E, handler: (payload: PayloadOf<E>) => void): Unsubscribe;
}
type Unsubscribe = () => void;
```

`invoke` also resolves to `{ ok: false, error: { code: 'invalid_input' | 'unavailable' | 'internal' } }`
for transport-level failures; it does not reject.

### 1.3 Common error codes

Proposed vocabulary; `ag-foundation` owns the final set and the `IpcErrorCode` type. A channel lists
the codes it can return in addition to the universal `invalid_input`, `unauthorized_sender`,
`unavailable`, `internal`.

| Code | Meaning |
|---|---|
| `invalid_input` | Input failed schema validation |
| `unauthorized_sender` | Caller is not the expected window/frame |
| `not_found` | Target does not exist (file, run, terminal, credential, approval) |
| `outside_workspace` | Resolved path escapes the trusted root(s) |
| `user_declined` | The user declined a native confirmation dialog shown by main (protected path, trust, saved allow rule) |
| `untrusted_workspace` | Operation needs a trusted workspace |
| `conflict` | Stale write or run state conflict; `details.kind` says which (`paths_changed`, `run_active`, a disk change) |
| `too_large` | Exceeds a size cap |
| `cancelled` | Operation was cancelled |
| `domain_error` | A failure from an owner's own error taxonomy (`AuthError`, `ProviderError`). The error stays `{ code, message, details? }` (no new `IpcError` variant); `details` is `{ domain: 'auth' \| 'provider', kind: <closed enum from the owner's error type> }`, validated by that channel's own `errorDetails` schema. `message` is the owner's safe constant for that kind. Vendor `detail` text never crosses |
| `unknown_key` | Setting key not in the allowlist |
| `no_longer_pending` | Approval already resolved or its run ended |
| `unavailable` | Subsystem not ready |
| `internal` | Bug or unexpected failure (no detail beyond a correlation id) |

### 1.4 Ownership

| Prefix | Owner |
|---|---|
| (format, `Result`, `IpcError`, bridge, codes) | ag-foundation |
| `settings.*` | ag-ui |
| `workspace.*`, `git.*`, `terminal.*` | ag-workspace |
| `agent.*`, `permissions.*` | ag-agent |
| `auth.*` | ag-auth |
| `models.*` | ag-providers |

(Channel classes for a later split of views are in §1.5.)

ag-ui is a consumer of every group except `settings.*`. Where a channel below is not mine, the
shape is **the renderer's requirement**, to be confirmed or amended by the owner.

### 1.5 Channel classes (input to the D-010 isolation proposal; not a contract)

Today one renderer calls everything. D-010's design gate may split views by role, and the channel
format supports a per-channel sender allowlist (`allowedSenders`). The UI is written so each feature
declares the channels it uses (`docs/ui-spec.md` §6.3). The classes I am working to:

| Class | Channels | Why separate |
|---|---|---|
| `transcript` | subscribe `agent.event`; `settings.get`; read-only display | Renders model output; must hold no privilege |
| `approvals` | subscribe `agent.approvalRequested`/`Resolved`; `permissions.respondApproval`, `listPending` | Small view, structured data only, rendered as inert text |
| `composer` | `agent.send`, `agent.stop`, `agent.undoRun`, `agent.getRunDiff`, `agent.listRuns`, `agent.replay` | Starts and controls runs |
| `terminal` | `terminal.*` | Arbitrary execution by design |
| `settings` | `auth.*`, `models.list`, `permissions.listRules`/`addRule`/`removeRule`/session approvals, `settings.*` | Credentials and policy |
| `workspace` | `workspace.*`, `git.*` | Files, trust, folder |

In the single-renderer configuration all classes map to one sender. A class is a label in the channel
declaration, not an extra check I invent in the renderer; the enforcement is main's.

## 2. `settings.*` (owner: ag-ui)

Settings are a closed set. Keys come from an allowlisted zod schema in `@autogeek/core`; there is
no free-form key/value store. An unknown key is an error, not a silent write.

| Key | Schema | Default |
|---|---|---|
| `theme` | `'system' \| 'dark' \| 'light'` | `'system'` |
| `layout` | `{ version: 1; sideBarWidth: number; panelHeight: number; agentPanelWidth: number; collapsed: { sideBar: boolean; panel: boolean; agentPanel: boolean }; activeView: 'explorer' \| 'search' \| 'git' \| 'settings' }` with numeric bounds | built-in layout |
| `editor.fontSize` | integer 8–32 | 13 |
| `editor.wordWrap` | `'off' \| 'on'` | `'off'` |
| `editor.minimap` | boolean | `true` |
| `agent.selection` | `{ credentialId: string; modelId: string } \| null` (opaque ids, no key material). **Per workspace root** | `null` |
| `agent.budgets` | `{ maxSteps: int 1–500; maxTokens: int \| null; maxWallMs: int \| null; maxSpendUsdMicros: int \| null }`, with bounds. `null` lifts a cap, which raises privilege, so main confirms it with a native dialog (a renderer-side confirm proves nothing). Defaults are the contract's (50 steps, 2M tokens, 30 min, $2). Read by main at run start (§5.3) | contract defaults |

Keys marked per workspace root are stored by main keyed by the root's realpath; the renderer never
names the root. Adding a key is a change to this table, reviewed like any contract change.

### `settings.get`
- Input: `{ keys?: SettingKey[] }` (omitted = all).
- Output: `{ values: Partial<Settings>; reset: SettingKey[] }`. `reset` lists keys whose stored value
  failed validation and were replaced by defaults, so the UI can show a one-time notice. Reading
  never fails because of a corrupt file.
- Errors: `unknown_key`.

### `settings.set`
- Input: `{ key: SettingKey; value: unknown }`. Main validates `value` against that key's schema.
- Output: `{ key: SettingKey; value: SettingValue }` (the normalized stored value).
- Errors: `unknown_key`, `invalid_input` (`details`: zod issue paths, no echo of the value for
  `agent.selection`).
- The renderer debounces `layout` writes and does not write during a drag.

### Event `settings.changed`
- Payload: `{ key: SettingKey; value: SettingValue }`. Emitted after any successful `settings.set`
  (including from another window), so state converges without polling.

## 3. `workspace.*` and `git.*` (owner: ag-workspace)

One trusted workspace root is active at a time in v1; multi-root is out of scope and would be a new
contract version.

### `workspace.openFolder`
- Input: `{}` (the renderer cannot supply a path; main shows the native dialog).
- Output: `{ root: { name: string; trusted: boolean } } | null` (`null` = user cancelled).
  The absolute path is not returned, only a display name.
- Errors: none beyond universal. New roots start untrusted until `workspace.setTrust`.

### `workspace.getState`
- Input: `{}`. Output: `{ root: { name: string; trusted: boolean } | null }`.

### `workspace.setTrust`
- Input: `{ trusted: boolean }` (applies to the current root, set only from the trust-prompt UI).
- Output: `{ trusted: boolean }`. Errors: `not_found` (no root open), `user_declined`.
- `trusted: true` needs a **native confirmation built by main from its own data** (the folder name
  and path, through the display-safe function). A renderer-supplied flag proves nothing, since a
  compromised renderer could send it (D-010). `trusted: false` takes effect at once and needs no
  dialog; main drops the session approvals for that root.
- Trust is enforced in main; the renderer flag is display only. Agent mode and the terminal are
  disabled by main in an untrusted workspace.

### `workspace.listDir`
- Input: `{ path: string }` (`''` = root).
- Output: `{ entries: Array<{ name: string; kind: 'file' | 'dir' | 'symlink'; size?: number; ignored: boolean }> }`
  sorted dirs-first. Symlinks are listed but never followed across the root boundary.
- Errors: `not_found`, `outside_workspace`, `untrusted_workspace`.

### `workspace.readFile`
- Input: `{ path: string; maxBytes?: number }`.
- Output: `{ text: string; encoding: 'utf8'; size: number; mtimeMs: number; truncated: boolean; lineEnding: 'lf' | 'crlf' }`
  or `{ binary: true; size: number }`. When `size` exceeds main's cap, `truncated` is `true` and the
  editor opens read-only with the large-file fallback.
- Errors: `not_found`, `outside_workspace`, `user_declined`, `too_large` (hard cap), `untrusted_workspace`.
- This is a user-driven editor action; main still enforces containment and the sensitive-path
  rules. For a protected path (`.env`, key files, `.git/config`) main shows a **native confirmation
  dialog** (built by main from the resolved path; the renderer supplies no "confirmed" flag, since a
  compromised renderer could spoof one) and the call resolves only after the user answers. Decline →
  `user_declined`. The call can therefore take arbitrarily long; the editor shows a "waiting for
  confirmation" state and no timeout. Confirmation is per call. Hardening of the dialog and the
  race between the answer and the I/O is in §9.4.

### `workspace.writeFile`
- Input: `{ path: string; text: string; expectedMtimeMs?: number }`.
- Output: `{ mtimeMs: number }`.
- Errors: `outside_workspace`, `user_declined`, `conflict` (disk changed since `expectedMtimeMs`),
  `too_large`, `untrusted_workspace`. Protected paths use the same native confirmation as
  `workspace.readFile`.
- Writes are atomic (temp file + rename) in main. The UI offers "overwrite / reload / compare" on
  `conflict`.

### Event `workspace.fsChanged`
- Payload: `{ changes: Array<{ kind: 'created' | 'modified' | 'deleted'; path: string }> }` (batched,
  coalesced and ignore-rule filtered in main; there is no per-file subscribe channel).
- The tree and open editors reconcile from this; the renderer never polls.

### `git.status`
- Input: `{}`. Output: `{ branch: string | null; entries: Array<{ path: string; state: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'; staged: boolean }> }`.
- Errors: `not_found` (not a repo), `untrusted_workspace`.
- Event `git.statusChanged` `{}` tells the renderer to re-request (no payload to keep it cheap).

## 4. `terminal.*` (owner: ag-workspace)

Streams are events keyed by `terminalId`.

### `terminal.create`
- Input: `{ cols: number; rows: number; cwd?: string }` (`cwd` is a workspace-relative path,
  default root).
- Output: `{ terminalId: string }`.
- Errors: `outside_workspace`, `untrusted_workspace`. The shell runs with a scrubbed environment
  (`ARCHITECTURE.md` §8.4); the renderer cannot set env or the executable.

### `terminal.write`
- Input: `{ terminalId: string; data: string }` (bounded length per call). Output: `{}`.
- Errors: `not_found`.

### `terminal.resize`
- Input: `{ terminalId: string; cols: number; rows: number }`. Output: `{}`. Errors: `not_found`.

### `terminal.kill`
- Input: `{ terminalId: string }`. Output: `{}`. Process-group kill in main. Errors: `not_found`.

### `terminal.ack` (backpressure)
- Input: `{ terminalId: string; bytes: number }` — bytes the renderer has finished consuming (written
  into xterm and parsed). Output: `{}`. Errors: `not_found`.
- Main tracks unacknowledged bytes per terminal, pauses the PTY above a high-water mark and resumes
  below a low-water mark (marks are ag-workspace's to choose and test). The renderer acks in
  batches (not per chunk) after xterm's write callback fires.

### Event `terminal.data`
- Payload: `{ terminalId: string; seq: number; data: string }`. `seq` is monotonic per terminal so
  loss or reorder is detectable. Treated as untrusted text; never interpreted outside xterm.

### Event `terminal.exit`
- Payload: `{ terminalId: string; exitCode: number | null; signal: string | null }`.

## 5. `agent.*` and `permissions.*` (owner: ag-agent)

**The channels, event envelopes, `WireAgentEvent`, `WireAction`, `WireMessage`,
`WirePermissionRequest`, `WirePath`, `ApprovalRequestedPayload`, error details and invariants are
defined once, in `docs/agent-contract.md` (§4–§7).** This document does not repeat them. What follows
is how the renderer uses them; the rendering rules are in `docs/ui-spec.md` §4–§5.

Channels the renderer calls: `agent.send`, `agent.stop`, `agent.listRuns`, `agent.replay`,
`agent.undoRun`, `agent.getRunDiff`, `permissions.respondApproval`, `permissions.listPending`,
`permissions.listSessionApprovals`, `permissions.revokeSessionApproval`, `permissions.listRules`,
`permissions.addRule`, `permissions.removeRule`. Events it subscribes to: `agent.event`,
`agent.approvalRequested`, `agent.approvalResolved`.

### 5.1 Attach and re-sync procedure (mount, reload)

A reload keeps runs and approvals alive in main; a crash or close does not (main denies and aborts).
On every mount:

1. Subscribe to `agent.event`, `agent.approvalRequested` and `agent.approvalResolved`, and **buffer**
   what arrives.
2. Call `agent.listRuns` and `permissions.listPending`.
3. For each run, page `agent.replay { runId, fromSeq }` from the last applied `seq + 1` while
   `more` is true. A fresh mount has applied nothing, so it starts at 0.
4. Drain the buffer. Events are applied idempotently by `seq`: anything at or below the last applied
   `seq` for that run is ignored, and a hole in `seq` triggers a replay from the hole.
5. `{ kind: 'gap' }` means the start of the history was evicted. The UI shows the run as "earlier
   output is no longer available" and continues from the live events and `listRuns` state. It does
   not invent the missing part. Request: `agent.listRuns` carries `firstSeq` so the UI knows what is
   retained without probing (§9).
6. Pending approvals come from `listPending` plus any `approvalRequested` in the buffer, de-duplicated
   by `approvalId`; each mounts a fresh, re-armed card (`docs/ui-spec.md` §5.3).

### 5.2 Fail closed

- If an `agent.approvalRequested` payload fails validation but has a parseable `approvalId` (an
  unknown `action.kind` after a version skew, a malformed field), the renderer calls
  `permissions.respondApproval { approvalId, decision: 'deny' }` and shows a notice. It never drops
  the event, which would leave the run waiting.
- An unknown `agent.event` `type` does not crash the transcript: it is skipped with a generic
  "unsupported event" row and a development-only log that contains no event content. An unknown
  `RunOutcome.reason` renders as an error state (the generic "Something went wrong").
- A decision not in `offered` is rejected by main with `invalid_input`; the renderer only offers
  what `offered` lists, so seeing that error means the card is out of date and it refreshes from
  `permissions.listPending`.

### 5.3 What the renderer needs from `agent.*` / `permissions.*` that the contract does not yet say

Requests, not assumptions (listed in §9 with the others):

1. `agent.listRuns` entries carry `firstSeq` (the oldest retained event) so a mount can replay from
   it.
2. After `agent.undoRun` succeeds, `agent.listRuns` and `agent.replay` do not return the undone runs
   (or mark them `undone`), otherwise a reload rebuilds a transcript that no longer exists.
3. Session-grant identity includes `env` and the exec `class`, is keyed by the workspace-root
   realpath, and is cleared on root change and on `setTrust(false)`.
4. A redacted `env` value makes the action elevated (no `session`), and the wire form marks which
   values are redacted.
5. The display-safe string function (`docs/ui-spec.md` §5.2) is exported by `core` and used by main
   for the text of native dialogs (`addRule`, `setTrust`, protected-path confirms) as well.
6. A setting that holds the user-adjustable run budgets (§2), read by main when a run starts.

## 6. `auth.*` (owner: ag-auth)

ag-auth's channel set, from their proposal to the chief. `CredentialRef` is ag-auth's strict core
schema, which is the only credential shape the renderer ever receives:

```ts
CredentialRef = {          // .strict()
  id: string;              // /^cred_[A-Za-z0-9_-]{22}$/, opaque
  label: string;           // 1–100 chars
  providerId: string;
  kind: 'api_key' | 'oauth_pkce';
  createdAt: string;       // ISO datetime
  monthlyCapUsdMicros?: number;
}
```

| Channel | Input | Output |
|---|---|---|
| `auth.list` | `{}` | `CredentialRef[]` |
| `auth.addApiKey` | `{ providerId, label, secret }` | `CredentialRef` |
| `auth.validate` | `{ id }` | `{ ok: true }` |
| `auth.rotateApiKey` | `{ id, secret }` | `CredentialRef` |
| `auth.delete` | `{ id }` | `{ revoked: boolean }` |
| `auth.oauth.begin` | `{ providerId, label }` | `CredentialRef` (resolves when the flow ends) |
| `auth.oauth.cancel` | `{ providerId }` | `{}` |
| `auth.setMonthlyCap` | `{ id, capUsdMicros: number \| null }` | `CredentialRef` |
| `auth.getUsage` | `{ id, month: 'YYYY-MM' }` | `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, costUsdMicros }` (aligned with D-004 / the model contract; §9.11) |

Errors: ag-auth returns `Result<_, AuthError>`; over this bridge they arrive as `domain_error` with
`details: { domain: 'auth', kind: AuthErrorCode }` (each `auth.*` channel declares this as its zod
`errorDetails` schema). `AuthErrorCode` is ag-auth's closed set
(`encryption_unavailable`, `insecure_backend`, `store_corrupt`, `store_io`, `not_found`,
`duplicate`, `validation_failed`, `validator_unreachable`, `oauth_state_mismatch`,
`oauth_timeout`, `oauth_aborted`, `oauth_provider_error`, `refresh_failed`, `revocation_failed`).
Messages are constant strings per code and never contain a secret; the renderer keeps its own
user-facing text keyed on `details.kind` (an exhaustive switch with a typed default, so a new code is
a compile error, not a blank toast). Universal codes (`invalid_input`, `unauthorized_sender`, `unavailable`, `internal`)
also apply.

Renderer behavior and constraints:
- **Secret-carrying channels are exactly `auth.addApiKey` and `auth.rotateApiKey`**, renderer →
  main only. The `SecretInput` is cleared as soon as the call is dispatched, whether it later
  succeeds or fails; a failed add means the user retypes. Nothing is persisted in renderer state.
- `auth.list` and every `CredentialRef` carry no key material, no prefix or suffix hint.
- `auth.delete` with `revoked: false` for an OAuth credential is shown ("removed locally; the
  provider could not be told to revoke it"), not hidden.
- If `auth.delete` removes the credential in `agent.selection`, main clears the selection and emits
  `settings.changed`; the renderer does not guess.
- `auth.oauth.begin` is a long-lived invoke (the user is in their browser). The UI shows a waiting
  state with Cancel wired to `auth.oauth.cancel`. Per D-002, subscription OAuth is off until the
  chief records the terms; the UI offers OAuth only where the provider catalog lists it (see §9.8).
  OAuth tokens never cross the bridge.
- The spend meter reads `auth.getUsage` for the selected credential and the current UTC month, and
  the live per-turn count from `agent.event` usage. Cap *enforcement* is the agent budget's job; the
  UI only shows state.

## 7. `models.*` (owner: ag-providers)

### `models.list`
- Input: `{ credentialId: string }`.
- Output: `ModelInfo[]`, core's schema from `docs/model-contract.md` §5 (`providerId`, `id`,
  `displayName`, `contextWindow: number | null`, `maxOutputTokens: number | null`,
  `capabilities: { tools, vision, reasoning, promptCaching }` each `'yes' | 'no' | 'unknown'`,
  optional `pricing`, `source: 'api' | 'catalog' | 'default'`).
- Errors: `not_found` (credential); `domain_error` with `details: { domain: 'provider', kind: ProviderErrorKind }`
  (e.g. `auth`, `network`, `quota`). `message` is the constant for that kind. Nothing else crosses:
  not `detail` (vendor body excerpt), not `requestId`. The renderer derives "retryable" from
  `kind` with its own table that mirrors `docs/model-contract.md` §4.
- The call runs in main with the credential resolved just-in-time. A stale result for a credential
  that is no longer selected is ignored by the UI; there is no cancel channel unless ag-providers
  wants one.
- The picker renders `unknown` honestly (`docs/ui-spec.md` §4.1): never as "no", never as "yes".

## 8. Trust boundaries: what the IPC allows, and the residual risk

### 8.1 What no channel provides

- No channel returns a credential or any fragment of one, and only `auth.addApiKey` and
  `auth.rotateApiKey` accept one.
- No channel lets the renderer name an arbitrary absolute path, set a child-process environment,
  make an HTTP request, or read a file outside the trusted root by itself. Main decides containment,
  and a protected path needs a native confirmation that only main can show.
- No channel (and no renderer-supplied flag) confirms a protected-path access, trusts a workspace,
  or persists an allow rule. Main shows a native confirmation, built from its own data, for each of
  `workspace.readFile`/`writeFile` on a protected path, `workspace.setTrust(true)` and
  `permissions.addRule` with effect `allow` (D-010). Refusal is `user_declined`.
- No channel creates a persistent permission rule as a side effect of an approval.
- No generic key/value, "eval", or "forward this to main" channel.

### 8.2 What the IPC does allow, and why that matters

`terminal.create` and `terminal.write` run commands in the user's shell in a trusted workspace, and
`terminal.data` returns what they print. That is arbitrary execution and arbitrary file reads by
design, as in any IDE, and it is **not** gated by the permission gate or a dialog. The same renderer
can call `permissions.respondApproval`, `auth.*` and `workspace.setTrust`.

So the honest statement is: **the renderer is untrusted by design, but until the isolation work in
D-010 lands, anything that compromises it (for example a sanitizer bypass in rendered model output)
can run commands through the terminal and approve its own agent requests.** The permission gate is
only as strong as the renderer's integrity. The mitigations in `docs/ui-spec.md` §6.1 reduce the
likelihood, and the channel classes in §1.5 prepare the split. Agent mode does not ship before the
chosen isolation is implemented or the user accepts the risk (D-010).

## 9. Open items

Owners are named so each can be answered in its own change. Items decided by the chief are recorded
as such.

1. **Owner confirmation.** The chief signed off the channel list. Each owner confirms or amends
   their group's exact shapes in `@autogeek/core`. Where an owner changes a shape, this document is
   updated in the same change, or marked superseded.
2. **Agent and permissions channels**: settled by `docs/agent-contract.md`. Open requests to
   ag-agent are in §5.3 (`firstSeq`, undone runs after reload, session-grant identity, redacted
   env, native-dialog text, budgets setting).
3. **Domain errors** (decided by the chief). `{ code, message, details? }` with a per-channel
   `errorDetails` schema; domain errors use `details = { domain, kind }`. Per finding on typing, the
   client type is `Result<OutputOf<C>, IpcErrorOf<C>>`, so `details` is typed per channel and an
   exhaustive switch on `details.kind` type-checks. **Every** error that crosses the bridge, in
   invoke results *and* in event payloads (`RunOutcome.provider_error` and any stream error
   included), uses the `{ domain, kind }` projection plus the owner's constant message; vendor
   `detail` and `requestId` stay in main's logs. `docs/model-contract.md` now says `detail` is logs
   only. Still to confirm with ag-foundation: that `domain_error` is the shared `code`.
4. **Native confirmations** (ag-workspace for files; ag-foundation/ag-agent for trust and rules):
   - the dialog's `defaultId` and `cancelId` are both the decline button, so a stray Enter cannot
     confirm;
   - dialogs are serialized, and a repeat for the same path is auto-declined for a short period after
     a decline, so a compromised renderer cannot spam until the user clicks yes;
   - the target is opened no-follow *before* the dialog and the I/O uses that handle; for writes,
     containment and identity are re-verified after the answer;
   - new-file writes `realpath` the deepest existing ancestor;
   - sensitive-path matching ignores case and Unicode normalization (APFS: `.ENV`, `.Git/config`);
   - the dialog text goes through the display-safe function (§5.3.5).
5. **Wire path schema** (ag-foundation with ag-workspace): reject NUL, backslash, empty and `.`
   segments, `..`, absolute paths and over-long paths at the schema, not only in the handler.
6. **Theme bootstrap** (ag-foundation to confirm feasibility). Main passes the validated initial
   theme through `webPreferences.additionalArguments`; the sandboxed preload reads it from
   `process.argv`, re-validates it, and exposes a synchronous bridge value (not a channel), so
   `data-theme` is right before first paint. Fallback: a stylesheet that follows
   `prefers-color-scheme` with `settings.get` overriding, accepting one possible flash.
7. **Stop shortcut**: `Cmd/Ctrl+Shift+Backspace`, accepted by ag-agent. The shortcut registry's tests
   check for collisions with Monaco and xterm. `Ctrl+C` is never intercepted in the terminal.
8. **Provider catalog** (decided by the chief): static data in `core`
   (`packages/core/src/providers/catalog.ts`), owned by ag-providers, `authKinds` reviewed by
   ag-auth. The UI offers exactly the kinds and `acquisition` it lists.
9. **External links.** A main-mediated open: the renderer sends a URL, main validates the scheme
   (`https:` only) against an allowlist or a native confirmation and opens it. Name and shape are the
   chief's call; none exists yet (`docs/ui-spec.md` §6.1.4).
10. **Display-safe string function in `core`** (ag-foundation): one implementation used by the
    renderer and by main's native dialogs (`docs/ui-spec.md` §5.2).
11. **`auth.getUsage` shape** (ag-auth): align with D-004 and the model contract:
    `cacheReadTokens`, `cacheWriteTokens` and `reasoningTokens` instead of `cachedTokens`.
12. **Per-root settings** (this document, §2): `agent.selection` is keyed by workspace root, per
    `ARCHITECTURE.md` §6.
13. **Terminal water marks and the large-file `maxBytes` default** (ag-workspace): chosen and tested
    there; the renderer takes them as given.
14. **D-010 isolation proposal** (joint with ag-foundation, before M3): §1.5 is my input.
