# IPC channels requested by the renderer

Owner of this document: ag-ui. **This is a request, not a contract.** `ag-foundation` owns the IPC
contract *format* in `@autogeek/core`. Each domain owner adds its own channels there; nobody edits
another owner's channels. The channel list below needs the chief's sign-off before anyone codes
against it. Until the real handlers exist, the renderer is built against a mock of exactly the
client shape in §1.2, at the bridge boundary.

Derived from `docs/ui-spec.md` and `docs/briefs/ui.md`, under the constraints the chief set:
errors are values, streams are events, `credentials.add` is the only channel that carries a secret,
and no channel ever returns one.

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
- Secrets: `credentials.add` is the single channel carrying a secret, renderer → main only. No
  channel input or output, no event, no error `details`, and no log line ever contains one.
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
| `sensitive_path` | Path requires explicit approval and none was granted |
| `untrusted_workspace` | Operation needs a trusted workspace |
| `conflict` | Stale write (file changed on disk since it was read) |
| `too_large` | Exceeds a size cap |
| `cancelled` | Operation was cancelled |
| `secure_storage_unavailable` | Only a plaintext credential backend exists; key refused |
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
| `credentials.*` | ag-auth |
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
- Errors: `not_found`, `outside_workspace`, `sensitive_path`, `too_large` (hard cap), `untrusted_workspace`.
- This is a user-driven editor action; main still enforces containment and sensitive-path rules.

### `workspace.writeFile`
- Input: `{ path: string; text: string; expectedMtimeMs?: number }`.
- Output: `{ mtimeMs: number }`.
- Errors: `outside_workspace`, `sensitive_path`, `conflict` (disk changed since `expectedMtimeMs`),
  `too_large`, `untrusted_workspace`.
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
- Payload:

```ts
{
  approvalId: string;
  runId: string;
  toolName: string;
  risk: 'read' | 'write' | 'exec' | 'network';
  action:                                   // structured, built by main from the VALIDATED tool
    | { kind: 'command'; command: string; cwd: string }        // input, never from model prose
    | { kind: 'write_file'; path: string; diff: string }
    | { kind: 'read_sensitive'; path: string }
    | { kind: 'network'; method: string; url: string }
    | { kind: 'mcp'; server: string; tool: string; input: unknown };
}
```

- The renderer treats every string as untrusted text (`docs/ui-spec.md` §5.2).

**Fields `docs/ui-spec.md` §5 needs beyond the chief's union.** Each is a request to ag-agent, not
an assumption; the UI renders what exists and omits what does not:

1. `offered: Array<'once' | 'session' | 'deny'>` — which decisions main will accept for this
   request. The UI must not infer the session option; it renders exactly this set. `'deny'` must
   always be present.
2. `context: { providerId: string; modelId: string; credentialLabel: string }` — the header line
   "which key and model is this turn using". Label only, never key material.
3. `write_file`: `op: 'create' | 'modify' | 'delete' | 'rename'` plus `to?` for rename, and the
   path is the `realpath` (after symlink resolution). If the tool also has the requested path, it is
   shown alongside so a symlinked target is visible. (`fs_write{path, sensitive, op, to?}` in the
   gate action, `ARCHITECTURE.md` §5 / D-006, already carries `op` and `to`.)
4. `read_sensitive`: `reason: string` (which protected rule matched, e.g. "`.env`"); the gate
   action's `sensitive` class is the source.
5. `command`: both gate shapes reach the UI. `exec{argv, cwd, class}` is shown as the argv list, one
   element per line with quoting made visible, plus its `class`; `exec_shell{command, cwd}` is shown
   as the exact command string and is always class `unknown` (D-006). The UI's `kind: 'command'`
   therefore needs a discriminator, e.g. `form: 'argv' | 'shell'`, rather than flattening argv into
   a string the user would be reading differently from what runs. `env?: Record<string, string>` for
   overrides main will actually apply (values redacted by main if secret-shaped).
6. `network`: the URL is already normalized by main (the UI shows IDN/punycode both ways itself).
7. `description?: string` — optional model-written text, shown only in the labeled, secondary
   "Agent's description (not verified)" block. Never the basis for anything else. The gate's
   `literal` field is tool-built and is what the UI treats as the literal action.

**Relation to `ARCHITECTURE.md` §5 / D-006.** The gate's `PermissionRequestInput.action`
(`fs_read | fs_write | exec | exec_shell | network | mcp`) is what tools produce. The IPC
`action` above is main's projection of it for display. They must stay isomorphic; ag-agent owns the
mapping and the two unions should be defined together in `core`, so a new gate action cannot ship
without a UI rendering (an unrecognized kind must fail closed to a labeled JSON view with Deny only,
`docs/ui-spec.md` §5.2).

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

## 6. `credentials.*` (owner: ag-auth)

### `credentials.add`
- Input: `{ providerId: string; label: string; secret: string }`. **The only channel carrying a
  secret; renderer → main only.**
- Output: `{ ref: CredentialRef }` where `CredentialRef = { id: string; providerId: string; label: string }`.
- Errors: `secure_storage_unavailable` (only a plaintext backend), `invalid_input`, `conflict`
  (duplicate label for the provider). Error messages and `details` never echo the secret.
- The renderer clears the input (`SecretInput.clear()`) as soon as the call is dispatched, whether
  it later succeeds or fails; a failed add means the user retypes.

### `credentials.list`
- Input: `{}`. Output: `{ refs: CredentialRef[] }`. No key material, no prefix or suffix hint.

### `credentials.remove`
- Input: `{ id: string }`. Output: `{}`. Errors: `not_found`.
- Re-validates `agent.selection`: if the removed credential was selected, main emits
  `settings.changed` with a cleared selection.

## 7. `models.*` (owner: ag-providers)

### `models.list`
- Input: `{ credentialId: string }`. Output: `{ models: Array<{ id: string; displayName: string; contextWindow?: number; supportsTools: boolean }> }`.
- Errors: `not_found` (credential), `unavailable` (provider unreachable; details carry a safe
  reason, e.g. "authentication failed" or "network error", never the response body or the key).
- The call is made in main with the credential resolved just-in-time; cancellation is by a
  `models.cancelList` only if ag-providers wants one, otherwise the UI ignores a stale result.

## 8. What the renderer will not need

Stating the negative space so reviewers can hold the line:

- No channel returns a credential or any fragment of one.
- No channel lets the renderer name an arbitrary absolute path, run an arbitrary executable, set a
  child-process environment, make an HTTP request, or read a file outside the trusted root.
- No channel creates a persistent permission rule as a side effect of an approval.
- No generic key/value, "eval", or "forward this to main" channel.

## 9. Open items

1. **Channel list sign-off** from the chief (this document), then each owner confirms or amends
   their group's shapes in `@autogeek/core`. Where an owner changes a shape, this document is
   updated to match in the same change, or marked superseded.
2. **Approval payload additions** (§5, items 1–7) — ag-agent to accept, amend or refuse. Item 1
   (`offered`) is needed for the "UI renders only what main offered" rule in `docs/ui-spec.md`
   §5.1; without it the UI would have to infer session-grantability, which it must not do.
3. **Theme bootstrap.** `settings.get` is asynchronous, so first paint could flash the wrong theme.
   Either the preload exposes the initial theme value synchronously at window creation (ag-foundation,
   needs sign-off), or the stylesheet defaults to `prefers-color-scheme` and `settings.get` only
   overrides, accepting one possible flash for users who override the system setting. Recommending
   the preload value.
4. **Stop shortcut** — which global accelerator, chosen with ag-agent to avoid editor/terminal
   collisions.
5. **Terminal water marks and the large-file `maxBytes` default** — ag-workspace to choose and test;
   the renderer takes them as given.
