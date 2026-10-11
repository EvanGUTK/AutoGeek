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
  is rejected and not answered with detail.
- Paths crossing the bridge are **workspace-root-relative POSIX strings** (no `..` segments, no
  absolute paths, no `file://`). Main resolves and `realpath`s them and enforces trusted-root
  containment and the sensitive-path rules (`ARCHITECTURE.md` §8.3) regardless of what the
  renderer claims. The only way the renderer names a location outside the current root is a native
  dialog that main itself shows (`workspace.openFolder`).
- Secrets: exactly two channels carry a secret, `auth.addApiKey` and `auth.rotateApiKey`, both
  renderer → main only. No other channel input, no channel output, no event, no error `details`,
  and no log line ever contains one. OAuth tokens never cross the bridge in either direction;
  `auth.oauth.begin` returns only a `CredentialRef`.
- Cancellation: long operations are cancelled by an explicit channel keyed by an id (`agent.stop`,
  `terminal.kill`), not by dropping the promise.

### 1.2 Client shape (what the mock implements)

```ts
// Errors are values. Nothing throws across the bridge.
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

interface IpcError {
  code: IpcErrorCode;
  message: string;      // safe to display; never contains a secret or a file's contents
  details?: unknown;    // channel-specific, zod-validated, optional
}

interface Bridge {
  invoke<C extends InvokeChannel>(channel: C, input: InputOf<C>): Promise<Result<OutputOf<C>, IpcError>>;
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
| `denied` | The user declined a native confirmation dialog shown by main (e.g. a protected path) |
| `untrusted_workspace` | Operation needs a trusted workspace |
| `conflict` | Stale write (file changed on disk since it was read) |
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

ag-ui is a consumer of every group except `settings.*`. Where a channel below is not mine, the
shape is **the renderer's requirement**, to be confirmed or amended by the owner.

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
| `agent.selection` | `{ credentialId: string; modelId: string } \| null` (opaque ids, no key material) | `null` |

Adding a key is a change to this table, reviewed like any contract change.

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
- Output: `{ trusted: boolean }`. Errors: `not_found` (no root open).
- Trust is enforced in main; the renderer flag is display only. Agent mode is disabled by main in an
  untrusted workspace.

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
- Errors: `not_found`, `outside_workspace`, `denied`, `too_large` (hard cap), `untrusted_workspace`.
- This is a user-driven editor action; main still enforces containment and the sensitive-path
  rules. For a protected path (`.env`, key files, `.git/config`) main shows a **native confirmation
  dialog** (built by main from the resolved path; the renderer supplies no "confirmed" flag, since a
  compromised renderer could spoof one) and the call resolves only after the user answers. Decline →
  `denied`. The call can therefore take arbitrarily long; the editor shows a "waiting for
  confirmation" state and no timeout. Confirmation is per call. See §9.4.

### `workspace.writeFile`
- Input: `{ path: string; text: string; expectedMtimeMs?: number }`.
- Output: `{ mtimeMs: number }`.
- Errors: `outside_workspace`, `denied`, `conflict` (disk changed since `expectedMtimeMs`),
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

Streams are events keyed by `runId`.

### `agent.send`
- Input: `{ sessionId: string | null; mode: 'ask' | 'plan' | 'agent'; text: string; selection: { credentialId: string; modelId: string } }`
  (@-mentions are added to this input when M4 lands).
- Output: `{ sessionId: string; runId: string }`.
- Errors: `untrusted_workspace` (agent mode only), `not_found` (credential), `invalid_input`.
- Main validates `selection` against its own credential and model records; the renderer's claim is
  not trusted.

### `agent.stop`
- Input: `{ runId: string }`. Output: `{}`. Errors: `not_found`.
- Idempotent. Resolves every pending approval for the run as denied (event `agent.approvalResolved`
  with `outcome: 'run_stopped'`). Always available while a run is active.

### `agent.undoTurn`
- Input: `{ runId: string; turnId: string }`. Output: `{ restored: string[] }` (paths).
- Errors: `not_found`, `conflict` (files changed since the checkpoint; details list them).

### `agent.getTurnDiff`
- Input: `{ runId: string; turnId: string }`. Output: `{ files: Array<{ path: string; operation: 'create' | 'modify' | 'delete'; diff: string }> }`.
- Errors: `not_found`.

### Event `agent.event`
- Payload: `{ runId: string; event: AgentEvent }` where `AgentEvent` is the normalized union owned
  by ag-agent in `core` (text and reasoning deltas, tool-call started/finished, usage, turn
  checkpoint, run finished). The renderer renders from it; it adds no event types.

### Event `agent.approvalRequested`
- Payload (zod-validated both ends):

```ts
{
  approvalId: string;
  runId: string;
  toolName: string;
  risk: 'read' | 'write' | 'exec' | 'network';
  offered: Array<'once' | 'session' | 'deny'>;                  // REQUIRED; 'deny' always present
  context: { providerId: string; modelId: string; credentialLabel: string };   // REQUIRED
  action: ApprovalAction;           // main-built from the VALIDATED tool input, never from model prose
  description?: string;             // optional model-written text; untrusted, secondary display only
}

type ApprovalAction =
  | { kind: 'command'; form: 'shell'; command: string; cwd: string; env?: Record<string, string> }
  | { kind: 'command'; form: 'argv'; argv: string[]; cwd: string; class: CommandClass; env?: Record<string, string> }
  | { kind: 'write_file'; path: string; diff: string; op?: 'create' | 'modify' | 'delete' | 'rename'; to?: string }
  | { kind: 'read_sensitive'; path: string; reason?: string }
  | { kind: 'network'; method: string; url: string }
  | { kind: 'mcp'; server: string; tool: string; input: JsonValue };   // z.json, never `unknown`
```

- The renderer treats every string as untrusted text (`docs/ui-spec.md` §5.2).
- `CommandClass` is ag-agent's gate type (D-006); the UI shows it as a label and does not interpret
  it.

**Required vs optional** (the chief asked ag-agent to accept this split):
- Required: `offered`, `context`, the `form` discriminator on `command`. `offered` is which
  decisions main will accept; the UI renders exactly this set and never infers `'session'`.
  `context` is the "which key and model is this turn using" header; label only, never key material.
- Optional: `op` and `to` on writes (`fs_write{path, sensitive, op, to?}` in the gate action already
  carries them), `reason` on `read_sensitive` (which protected rule matched), `env` on commands
  (overrides main will actually apply, values redacted by main if secret-shaped), and `description`.
  The UI renders what exists and omits what does not.
- Paths are the `realpath` after symlink resolution. If the tool also has the requested path, it is
  shown alongside so a symlinked target is visible.
- `exec_shell` is always class `unknown` (D-006) and is shown as the exact command string. `exec` is
  shown as the argv list, so a space inside an element is not read as two arguments.
- `network`: the URL is already normalized by main (the UI shows IDN/punycode both ways itself).
- The gate's `literal` field is tool-built and is what the UI treats as the literal action;
  `description` is never the basis for anything.

**Relation to `ARCHITECTURE.md` §5 / D-006.** The gate's `PermissionRequestInput.action`
(`fs_read | fs_write | exec | exec_shell | network | mcp`) is what tools produce. `ApprovalAction`
is main's projection of it for display. The two unions are defined together in `core` (chief's
direction), so a new gate action cannot ship without a UI rendering. An unrecognized `kind` **fails
closed** to a labeled JSON view with Deny only (`docs/ui-spec.md` §5.2).
### Event `agent.approvalResolved`
- Payload: `{ approvalId: string; outcome: 'allowed_once' | 'allowed_session' | 'denied' | 'cancelled' | 'timed_out' | 'run_stopped' }`.
  Mapping from the gate's `PermissionDecision` (D-006): `deny` with reason `user` → `denied`,
  `aborted` → `run_stopped` (or `cancelled`), `policy`/`mode`/`untrusted_workspace` never reach an
  approval card because no human is asked.
- Emitted for every approval, including ones resolved without the user (stop, timeout), so the card
  never goes stale.

### `permissions.respondApproval`
- Input: `{ approvalId: string; decision: 'once' | 'session' | 'deny' }`.
- Output: `{}`.
- Errors: `not_found`, `no_longer_pending`, `invalid_input` (a `decision` not in that request's
  `offered` set is rejected by main, not honored).
- `'session'` creates an exact-match, in-memory rule only, scoped to precisely the `action` shown
  (`docs/ui-spec.md` §5.4). Idempotent per `approvalId`; the second call returns `no_longer_pending`.

### `permissions.listSessionApprovals`
- Input: `{}`. Output: `{ items: Array<{ ruleId: string; toolName: string; action: ApprovalAction }> }`
  (the literal granted action, same union as above). Errors: none beyond universal.

### `permissions.revokeSessionApproval`
- Input: `{ ruleId: string }`. Output: `{}`. Errors: `not_found`.

### `permissions.listRules` / `permissions.addRule` / `permissions.removeRule`
- Backing the persistent-rules editor in Settings (brief item 7). Rules are exact rules, not
  patterns, unless ag-agent specifies otherwise. Per `ARCHITECTURE.md` §5 remembered rules live
  only in per-user app data, keyed by workspace-root realpath, and are never read from or written
  to the workspace; the editor lists the rules for the current root. **Shape to be defined by
  ag-agent**; ag-ui needs:
  list → `{ rules: Array<{ ruleId; toolName; action: ApprovalAction; createdAt }> }`, add →
  `{ toolName; action: ApprovalAction }` → `{ ruleId }`, remove → `{ ruleId }`. Errors: `not_found`,
  `invalid_input`. Persistent-rule creation from inside an approval prompt is deliberately not a
  channel.

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
| `auth.getUsage` | `{ id, month: 'YYYY-MM' }` | `{ inputTokens, outputTokens, cachedTokens, costUsdMicros }` |

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
  chief records the terms; the UI offers OAuth only where the provider catalog lists it (see §9.7).
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

## 8. What the renderer will not need

Stating the negative space so reviewers can hold the line:

- No channel returns a credential or any fragment of one, and only `auth.addApiKey` and
  `auth.rotateApiKey` accept one.
- No channel lets the renderer name an arbitrary absolute path, run an arbitrary executable, set a
  child-process environment, make an HTTP request, or read a file outside the trusted root.
- No channel (and no renderer-supplied flag) confirms a protected-path access; only main's native
  dialog does.
- No channel creates a persistent permission rule as a side effect of an approval.
- No generic key/value, "eval", or "forward this to main" channel.

## 9. Open items

1. **Owner confirmation.** The chief has signed off the channel list. Each owner confirms or
   amends their group's exact shapes in `@autogeek/core`. Where an owner changes a shape, this
   document is updated to match in the same change, or marked superseded.
2. **Approval payload.** The chief is asking ag-agent to accept §5's required/optional split, and
   to define `ApprovalAction` together with the gate action union in `core`.
3. **Domain errors** (decided by the chief). No new `IpcError` variant: the error stays
   `{ code, message, details? }` and each channel declares its own zod `errorDetails` schema. For
   domain errors `details = { domain: 'auth' | 'provider', kind: <closed enum> }`. ag-foundation has
   been told. Still to confirm with ag-foundation: that `domain_error` is the shared `code` value
   for these (as drawn in §1.3), rather than each channel naming its own code.
4. **Native confirmation for protected paths on `workspace.readFile`/`writeFile`**
   (ag-workspace). A dead-end error on editing `.env` is bad UX, but a renderer-supplied "I
   confirmed" flag is spoofable by a compromised renderer. Proposal: main shows a native modal
   dialog whose text it builds from the resolved path, awaits the answer, and the channel resolves
   afterward (accept → proceed, decline → `denied`). Per call, nothing remembered. If ag-workspace
   wants "remember for this file this session", that is theirs to propose.
5. **Theme bootstrap** (ag-foundation to confirm feasibility). Main passes the validated initial
   theme through `webPreferences.additionalArguments`; the sandboxed preload reads it from
   `process.argv`, re-validates it against the theme enum, and exposes it to the renderer as a
   synchronous value on the bridge (not a channel), so `data-theme` is correct before first paint.
   If the argv route is infeasible, the fallback is a stylesheet that follows
   `prefers-color-scheme` with `settings.get` overriding, accepting one possible flash for users who
   override the system theme.
6. **Stop shortcut** (ag-agent to confirm no collision). Proposal: `Cmd/Ctrl+Shift+Backspace`
   (`docs/ui-spec.md` §3.9). The Stop button is also always visible whenever a run is active. When
   the terminal has focus, `Ctrl+C` is never intercepted: it goes to the PTY. The terminal installs a
   key handler that lets only registered app chords through, and `Ctrl+C` is not one.
7. **Which auth kinds a provider offers** (decided by the chief). A static provider catalog in
   `core`, as pure data plus zod, at `packages/core/src/providers/catalog.ts`: `id`, `displayName`,
   `authKinds`, optional key-help URL. Not a channel. ag-providers owns the file; ag-auth reviews
   `authKinds`, and per D-002 only provider-permitted auth kinds are listed (subscription OAuth is
   not). The UI offers exactly the kinds the catalog lists; the key-help URL is shown as plain
   text (no renderer-side navigation; opening it externally would need a channel I have not
   requested).
8. **Terminal water marks and the large-file `maxBytes` default** — ag-workspace to choose and
   test; the renderer takes them as given.
