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
  `RunOutcome.provider_error` included) carry only an owner's closed projection and a constant
  message. For providers that is `ProviderErrorSafe` (`docs/agent-contract.md` §4):
  `{ kind, retryable, status?, retryAfterMs?, requestId? }`, where `requestId` is schema-constrained
  (≤ 128 chars, `[A-Za-z0-9._:-]`, otherwise dropped) and is a support reference, not a secret.
  Never vendor text, response bodies or `detail`: a vendor 401 body can echo part of a key, so that
  text stays in main's logs.
- Untrusted strings that reach a human (including native dialogs built in main) go through one
  display-safe function from `core` (`docs/ui-spec.md` §5.2).
- **State-bearing events carry a sequence.** An event that reports state a renderer also reads with
  a getter carries a monotonically increasing `seq` (or `rev`), and the getter returns the current
  value. A mount subscribes and buffers, reads the getter, then applies buffered events above that
  value. Examples: `agent.event` with `agent.replay`, `workspace.fsWatchState` with
  `workspace.getState`, `settings.changed` with `settings.get`. Main never needs to know who
  subscribes.
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
| `protected_path` | Hard-denied write to repository-integrity paths (`.git/{HEAD,index,objects}`); no dialog and no override |
| `untrusted_workspace` | Operation needs a trusted workspace |
| `too_long` | The text main must put in a native confirmation exceeds the dialog bound (`docs/ui-spec.md` §8); the operation is refused, never shown cut |
| `conflict` | Stale write or run state conflict; `details.kind` says which (`paths_changed`, `run_active`, a disk change) |
| `too_large` | Exceeds a size cap |
| `cancelled` | Operation was cancelled |
| `domain_error` | A failure from an owner's own error taxonomy (`AuthError`, `ProviderError`). The error stays `{ code, message, details? }` (no new `IpcError` variant); `details` is `{ domain: 'auth' \| 'provider', kind: <closed enum from the owner's error type> }`, validated by that channel's own `errorDetails` schema. `message` is the owner's safe constant for that kind. Vendor `detail` text never crosses |
| `invalid_base_url` | A base URL that cannot be used (unparseable, wrong scheme, embedded credentials, non-loopback `http:` where not allowed) |
| `base_url_not_editable` | The provider's endpoint is fixed by the catalog |
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
| `models.*` (including `models.setBaseUrl`) | ag-providers |
| `app.*` | ag-foundation |

(Channel classes for a later split of views are in §1.5.)

ag-ui is a consumer of every group except `settings.*`. Where a channel below is not mine, the
shape is **the renderer's requirement**, to be confirmed or amended by the owner.

### 1.5 Channel classes (input to the D-010 isolation proposal; not a contract)

Today one renderer calls everything. D-010's design gate may split views by role, and the channel
format supports a per-channel sender allowlist (`allowedSenders`). The UI is written so each feature
declares the channels it uses (`docs/ui-spec.md` §6.3). The classes I am working to:

| Class | Channels | Why separate |
|---|---|---|
| `transcript` | subscribe `agent.event`; `settings.get`; `app.openExternal` (every call is gated by a native confirmation showing the exact URL); read-only display | Renders model output; no privilege beyond a confirmed link open |
| `approvals` | subscribe `agent.approvalRequested`/`Resolved`; `permissions.respondApproval`, `listPending` | Small view, structured data only, rendered as inert text |
| `composer` | `agent.send`, `agent.stop`, `agent.undoRun`, `agent.getRunDiff`, `agent.listRuns`, `agent.replay` | Starts and controls runs |
| `terminal` | `terminal.*` | Arbitrary execution by design |
| `settings` | `auth.*`, `models.list`, `models.setBaseUrl`, `permissions.listRules`/`addRule`/`removeRule`/session approvals, `settings.*` | Credentials and policy |
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
| `explorer.hideIgnored` | boolean (hide entries whose `ignored` is `'yes'`; cosmetic only) | `false` |
| `agent.selection` | `{ credentialId: string; modelId: string } \| null` (opaque ids, no key material). **Per workspace root** | `null` |
| `agent.budgets` | `{ maxSteps: int 1–1000; maxTokens: int 1_000–20_000_000 \| null; maxWallMs: int 60_000–14_400_000 \| null; maxSpendUsdMicros: int 10_000–100_000_000 \| null }`. The bounds are hard schema limits ($0.01 to $100, 4 hours). **Any raise above the contract defaults (50 steps, 2M tokens, 30 min, $2), and `null`, raises privilege**, so main confirms it with a native dialog showing old → new through the display-safe function (a renderer-side confirm proves nothing); `user_declined` leaves the value unchanged. Lowering needs no dialog. Read by main at run start through `budgetsFor()` (`docs/agent-contract.md` §11) | contract defaults |

Keys marked per workspace root are stored by main keyed by the root's realpath; the renderer never
names the root. Adding a key is a change to this table, reviewed like any contract change.

### `settings.get`
- Input: `{ keys?: SettingKey[] }` (omitted = all).
- Output: `{ values: Partial<Settings>; reset: SettingKey[]; rev: number }` (`rev` is the revision of
  the latest `settings.changed` reflected in `values`). `reset` lists keys whose stored value
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
- Payload: `{ rev: number; key: SettingKey; value: SettingValue }`. Emitted after any successful
  `settings.set` (including from another window), so state converges without polling. A mount applies
  buffered events whose `rev` is above the `rev` returned by `settings.get`.

## 3. `workspace.*` and `git.*` (owner: ag-workspace)

One workspace root is active at a time in v1; multi-root is out of scope and would be a new contract
version.

**Restricted mode (untrusted folder).** The renderer's requirement, for ag-workspace to confirm:
`workspace.listDir`, `readFile` and `writeFile` work (browsing and editing text is safe, and the user
needs it to decide whether to trust the folder), while `git.status`, `terminal.*` and `agent.*`
return `untrusted_workspace`. `git.status` needs trust because a repository's own configuration can
make git run programs. Containment and the sensitive-path rules apply in both modes.

### `workspace.openFolder`
- Input: `{}` (the renderer cannot supply a path; main shows the native dialog).
- Output: `{ root: { name: string; trusted: boolean } } | null` (`null` = user cancelled).
  The absolute path is not returned, only a display name.
- Errors: none beyond universal. New roots start untrusted until `workspace.setTrust`.

### `workspace.getState`
- Input: `{}`. Output: `{ root: { name: string; trusted: boolean } | null; watch: WatchState }` where
  `WatchState = { seq: number } & ({ state: 'ok' } | { state: 'degraded'; reason: 'ignore_rules_limit' | 'watch_limit' | 'overflow' | 'watch_error' })`.
  `seq` is the sequence of the latest `workspace.fsWatchState` event reflected in `watch`; main reads
  the state and its `seq` atomically (ag-workspace to confirm).

### `workspace.setTrust`
- Input: `{ trusted: boolean }` (applies to the current root, set only from the trust-prompt UI).
- Output: `{ trusted: boolean }`. Errors: `not_found` (no root open), `user_declined`, `too_long` (the
  folder path is too long to show in the confirmation, so trust is refused).
- `trusted: true` needs a **native confirmation built by main from its own data** (the folder name
  and path, through the display-safe function). A renderer-supplied flag proves nothing, since a
  compromised renderer could send it (D-010). `trusted: false` takes effect at once and needs no
  dialog; main drops the session approvals for that root.
- Trust is enforced in main; the renderer flag is display only. Agent mode and the terminal are
  disabled by main in an untrusted workspace.

### `workspace.listDir`
- Input: `{ path: string }` (`''` = root).
- Output: `{ entries: Array<{ name: string; kind: 'file' | 'dir' | 'symlink'; size?: number; ignored: 'yes' | 'no' | 'unknown' }>; ignoreRules: 'ok' | 'limit_exceeded'; truncated: boolean }`
  sorted directories first, then files in name order. Symlinks are listed but never followed across
  the root boundary.
- **`truncated`:** `listDir` always stops at `LIST_DIR_MAX_ENTRIES` = 5,000 entries, reading the
  directory as a stream so memory and time stay bounded. `truncated: true` means there were more.
  This applies to every call. The 5,000 are the first the filesystem returned, then sorted, not the
  alphabetically first, so the UI row reads "Showing 5,000 of more entries".
- **`ignored` is tri-state and cosmetic only.** The matcher never runs `git` (trusted or not) and has
  hard input caps (ag-workspace, `docs/workspace-path-cases.md` §11). When a cap trips because of a
  hostile or broken `.gitignore`/`.ignore`, `listDir` still **succeeds**: every entry is `'unknown'`
  and `ignoreRules` is `'limit_exceeded'`, so a hostile folder stays browsable. The UI then shows
  all entries normally with a banner "This folder has ignore rules that are too large to read, so
  ignored files can't be marked." A missing, unreadable or directory-typed ignore file counts as no
  rules (`'ok'`). `ignored` never affects permissions, classification, containment or what the agent
  may read, so **no security UI is built on it**: no "protected" badge, no read prompt. A path
  flagged `'yes'` or `'unknown'` is classified exactly like any other. (The glob, grep and agent
  tools return a typed error instead, since an agent must not search on guessed rules; that is not
  this channel.)
- Errors: `not_found`, `outside_workspace`.

### `workspace.readFile`
- Input: `{ path: string; maxBytes?: number }`.
- Output: `{ text: string; encoding: 'utf8'; size: number; mtimeMs: number; version: string; truncated: boolean; lineEnding: 'lf' | 'crlf' }`
  or `{ binary: true; size: number }`. `version` is an **opaque** token (ag-workspace builds it from a
  hash of the bytes plus size and mtime); the renderer never parses it. `mtimeMs` is for display
  only. Default `maxBytes` is 2 MiB; above it `truncated` is `true` and the editor opens read-only
  with the large-file fallback; the hard cap is 16 MiB (`too_large`). These defaults are ag-workspace's
  and may be revised.
- Errors: `not_found`, `outside_workspace`, `user_declined`, `too_large` (hard cap), `too_long` (the
  path is too long to show in the confirmation dialog, so the read is refused).
- This is a user-driven editor action; main still enforces containment and the sensitive-path
  rules, split into two classes by ag-workspace:
  - **Confirmable** (`.env*`, key and credential files, `.git/config`, `.git/hooks`; templates such as
    `.env.example` are read without a dialog): main shows a **native confirmation dialog** (built by
    main from the resolved path; the renderer supplies no "confirmed" flag, since a compromised
    renderer could spoof one) and the call resolves only after the user answers. Decline →
    `user_declined`. The call can therefore take arbitrarily long; the editor shows a "waiting for
    confirmation" state and no timeout. Confirmation is per call.
  - **Hard-denied** (writes to `.git/{HEAD,index,objects}`): `protected_path`, no dialog and no
    override. AutoGeek's own configuration and credential store answer `outside_workspace`, so
    their existence is not confirmed. The editor explains a `protected_path` result in words and
    offers no way around it.
  Hardening of the dialog and the race between the answer and the I/O is in §9.4.

### `workspace.writeFile`
- Input: `{ path: string; text: string; expectedVersion?: string }` (the `version` from the read).
- Output: `{ version: string; mtimeMs: number }`.
- Errors: `outside_workspace`, `user_declined`, `protected_path`, `conflict` (disk changed since
  `expectedVersion`), `too_large`, `too_long` (as for `readFile`). Confirmable paths use the same native
  confirmation as `workspace.readFile`; hard-denied paths are `protected_path`.
- Writes are atomic (temp file + rename) in main. The UI offers "overwrite / reload / compare" on
  `conflict`.

### Event `workspace.fsChanged`
- Payload: `{ changes: Array<{ kind: 'created' | 'modified' | 'deleted'; path: string }> }` (batched,
  coalesced and ignore-rule filtered in main; there is no per-file subscribe channel).
- The tree and open editors reconcile from this; the renderer never polls.
- If the ignore matcher hits a cap, the watcher falls back to fixed excludes (`.git`,
  `node_modules`). Watcher health is reported by the event below.

### Event `workspace.fsWatchState`
- Payload: `WatchState` as above: `{ seq: number; state: 'ok' }` or
  `{ seq: number; state: 'degraded'; reason: 'ignore_rules_limit' | 'watch_limit' | 'overflow' | 'watch_error' }`.
  The `reason` enum is closed and exactly these four values; the payload has no paths and no message
  strings. Approved by the chief.
  - `ignore_rules_limit`: the ignore caps tripped, so the fixed excludes apply.
  - `watch_limit`: the OS watch limit was hit.
  - `overflow`: an event storm such as a large checkout. The renderer gets one rescan batch, and
    `ok` follows after the rescan.
  - `watch_error`: the root was removed or permission was lost.
- `seq` increases by one per emitted event, per window. It is sent on every (debounced) transition.
  Debouncing is on the **trailing edge**, so a flapping watcher ends on its latest state and sends at
  most one event per window.
- **Sync, not "first message on subscribe".** `Bridge.subscribe` is renderer-local and main never
  learns about subscribers, so main cannot send state to a new one. The renderer follows the same
  pattern as agent events: subscribe and **buffer**, call `workspace.getState`, apply its `watch`,
  then drain buffered events whose `seq` is above `watch.seq`. A reloaded renderer therefore re-syncs
  with no extra message.
- `workspace.fsChanged` keeps its shape and batches keep arriving while degraded.
- The UI shows "File watching is limited in this folder" for all four reasons and clears it on `ok`.
  `watch_error` also tells the user the folder may have been removed or become unreadable.

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
  below a low-water mark (ag-workspace's defaults to test: 256 KiB and 64 KiB). The renderer acks in
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

### 5.3 Requests that landed in the agent contract

The chief accepted these into `docs/agent-contract.md` (§2, §4, §11). They are facts the UI relies
on:

1. `agent.listRuns` entries carry `firstSeq` (the oldest retained event) and `undone`. `agent.undoRun`
   marks undone runs, `agent.replay` still returns their events (auditable), and the UI hides undone
   runs by the flag, so a reload does not resurrect a transcript that no longer exists.
2. Session grants include the canonical `env` and the exec `class` in their key, are keyed by the
   workspace-root realpath, and are cleared on root change and on `setTrust(false)`. Policy rules of
   kind `argv`, `argv_prefix` and `shell` never match a request with a non-empty `env`.
3. Env redaction is structural (`EnvValue`). A redacted value, or an env key outside the benign
   allowlist (owned by ag-workspace's classifier), makes the action elevated: no `session` option.
4. `core` exports the display-safe string function (`docs/ui-spec.md` §8), which main uses for the
   text of every native dialog (`addRule`, `setTrust`, protected-path confirms, `app.openExternal`,
   budget changes).
5. Budgets come from the `agent.budgets` setting (§2), read by main at run start through an injected
   `budgetsFor()`. The native confirmation lives in the `settings.set` handler.

### 5.4 `permissions.addRule` and `too_long`

`permissions.addRule` shows a native confirmation whose text is bounded (`docs/ui-spec.md` §8), so a
rule whose literal text exceeds the bound is refused, never shown cut. This landed: `too_long` is among
its errors in `docs/agent-contract.md` §6.

## 6. `auth.*` (owner: ag-auth)

ag-auth's channel set, from their proposal to the chief. `CredentialRef` is ag-auth's strict core
schema, which is the only credential shape the renderer ever receives:

```ts
CredentialRef = {          // .strict()
  id: string;              // /^cred_[A-Za-z0-9_-]{22}$/, opaque
  label: string;           // 1–100 chars
  providerId: string;
  kind: 'api_key' | 'oauth_pkce' | 'none';   // 'none' = keyless local server; a secretless record
  baseUrl?: string;        // display-safe; present only for providers whose endpoint is editable
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

## 7. `models.*` (owner: ag-providers) and `app.*` (owner: ag-foundation)

### 7.0 `models.list`
- Input: `{ credentialId: string }`.
- Output: `ModelInfo[]`, core's schema from `docs/model-contract.md` §5 (`providerId`, `id`,
  `displayName`, `contextWindow: number | null`, `maxOutputTokens: number | null`,
  `capabilities: { tools, vision, reasoning, promptCaching }` each `'yes' | 'no' | 'unknown'`,
  optional `pricing`, `source: 'api' | 'catalog' | 'default'`).
- Errors: `not_found` (credential); `domain_error` with `details: { domain: 'provider' } & ProviderErrorSafe`
  (`kind` such as `auth`, `network`, `quota`; `retryable`; optional `status`, `retryAfterMs`,
  `requestId`). `message` is the constant for that kind. Nothing else crosses: not `detail`. The UI
  uses `retryable` as given and may show `requestId` as a copyable support reference.
- The call runs in main with the credential resolved just-in-time. A stale result for a credential
  that is no longer selected is ignored by the UI; there is no cancel channel unless ag-providers
  wants one.
- The picker renders `unknown` honestly (`docs/ui-spec.md` §4.1): never as "no", never as "yes".

### 7.0.1 `models.setBaseUrl` (owner: ag-providers; shape settled with ag-auth, named by them)

A base URL decides where the stored key and the user's code are sent, so it is security-critical and
**never a renderer setting** (the chief's ruling). It belongs to the credential or provider-config
record in main, and a stored key is bound to the host it was created with.

- Input: `{ credentialId: string; baseUrl: string }`.
- Output: `CredentialRef` (with the new display-safe `baseUrl`).
- Errors: `not_found`, `base_url_not_editable` (hosted providers: anthropic, openai, google,
  openrouter have fixed catalog URLs), `invalid_base_url` (unparseable, scheme other than
  `http:`/`https:`, embedded credentials), `user_declined`, `too_long` (the URL does not fit the
  confirmation), plus the provider-domain projection (`domain_error`, `ProviderErrorSafe`).
- Only `openai_compatible` and the local servers (ollama, lmstudio, llamacpp) are editable. The
  provider catalog says so with `baseUrl: { editable: false; url } | { editable: true; defaultUrl? }`.
- Main shows a native confirmation, built by main, at one of two levels: **confirm** for any
  non-loopback editable target, **loud** for sending a key over plaintext `http:` or an https→http
  downgrade. The text states that the key and the user's code will be sent to the NEW host, shows old
  → new through the display-safe function with punycode visible, and warns extra on non-loopback
  `http:`. **The renderer never builds, substitutes or influences the dialog text.** It shows a
  "Waiting for confirmation in the system dialog" state and then the result (`user_declined` leaves
  the URL unchanged and is not an error).
- Creating a **keyless connection** (`kind: 'none'`) to a non-loopback URL triggers the same native
  confirm in main. The channel that creates a keyless connection is ag-auth's to name; the renderer
  only needs it to return a `CredentialRef`.
- `models.list` is unchanged (`{ credentialId }`). After a successful `setBaseUrl` the UI refreshes
  `auth.list` and re-requests the model list.

### 7.1 `app.openExternal`
Proposed shape, for the chief to relay to ag-foundation's `app.*` domain.

- Input: `{ url: string }` (≤ 8 KiB).
- Output: `{ opened: true }`.
- Errors: `invalid_input` (not a parseable URL, a scheme other than `http:`/`https:`, embedded
  credentials `user:pass@`, or over the size bound), `user_declined`, `too_long` (the normalized URL
  does not fit the confirmation, so it is refused rather than shown cut).
- Main parses with the WHATWG URL parser and normalizes. It rejects every scheme but `http` and
  `https`. It then **always** shows a native confirmation that displays the exact normalized URL
  through the display-safe function (`docs/ui-spec.md` §8), with the host shown separately and
  punycode visible. There is no "remember this host" in v1 and no renderer-supplied "trusted source"
  flag; the renderer's link text is never shown in the dialog. Only after the user accepts does main
  open that exact string in the default browser.
- The dialog's `defaultId` and `cancelId` are the decline button. Dialogs are serialized, and a
  repeat for the same URL right after a decline is auto-declined for a short time.
- The renderer shows the real URL next to any link text (`docs/ui-spec.md` §6.1.4), so what the user
  sees in the dialog is what they saw in the transcript.

## 8. Trust boundaries: what the IPC allows, and the residual risk

### 8.1 What no channel provides

- No channel returns a credential or any fragment of one, and only `auth.addApiKey` and
  `auth.rotateApiKey` accept one.
- No channel lets the renderer name an arbitrary absolute path, set a child-process environment,
  make an HTTP request, or read a file outside the trusted root by itself (the terminal in §8.2 is
  the exception, by design). Main decides containment,
  and a protected path needs a native confirmation that only main can show.
- No channel (and no renderer-supplied flag) confirms a protected-path access, trusts a workspace,
  or persists an allow rule. Main shows a native confirmation, built from its own data, for each of
  `workspace.readFile`/`writeFile` on a protected path, `workspace.setTrust(true)` and
  `permissions.addRule` with effect `allow` (D-010). Refusal is `user_declined`.
- No channel creates a persistent permission rule as a side effect of an approval.
- No renderer setting holds a base URL, and the renderer cannot supply or alter a confirmation
  dialog's text; both belong to main.
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
   included), uses the owner's closed projection plus a constant message (`ProviderErrorSafe` for
   providers); vendor `detail` stays in main's logs. `docs/model-contract.md` says `detail` is logs
   only. Still to confirm with ag-foundation: that `domain_error` is the shared `code`.
4. **Native confirmations** (ag-workspace for files; ag-foundation/ag-agent for trust, rules and links).
   The dialogs live in `apps/desktop` behind an injected port
   (`ProtectedAccessConfirmer.confirm({ realpath, category, op }, signal)` for files), and `workspace`
   does the following around it (agreed with ag-workspace):
   - the dialog's `defaultId` and `cancelId` are both the decline button, so a stray Enter cannot
     confirm;
   - requests are serialized, and a repeat for the same path is auto-declined for a short cooldown
     after a decline, so a compromised renderer cannot spam until the user clicks yes;
   - the target is opened no-follow *before* the dialog and the I/O uses that handle; for writes,
     containment and identity are re-verified after the answer;
   - new-file writes `realpath` the deepest existing ancestor;
   - sensitive-path matching ignores case and Unicode normalization (APFS: `.ENV`, `.Git/config`);
   - the PTY service refuses `terminal.create` unless the workspace is trusted, as a second check
     besides the handler;
   - the dialog text goes through the display-safe function (§5.3.4), and a text that exceeds the
     dialog bound is refused (`too_long`), never cut.
5. **Wire path schema** (a `core` export, decided by the chief). The schema rejects NUL, backslash,
   empty and `.` segments, `..`, absolute paths and over-long paths. It is deliberately stricter than
   the tool-path rules. ag-workspace keeps the case table in `docs/workspace-path-cases.md` so the
   schema tests can use it without `workspace` importing `core`.
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
9. **External links** (decided by the chief): `app.openExternal`, shape in §7.1, owned by
   ag-foundation's `app.*` domain.
10. **Display-safe string function** (decided by the chief): a pure `core` export specified in
    `docs/ui-spec.md` §8 (ag-ui specifies, ag-foundation implements, ag-reviewer reviews).
11. **`auth.getUsage` shape** (ag-auth): align with D-004 and the model contract:
    `cacheReadTokens`, `cacheWriteTokens` and `reasoningTokens` instead of `cachedTokens`.
12. **Per-root settings** (this document, §2): `agent.selection` is keyed by workspace root, per
    `ARCHITECTURE.md` §6.
13. **Terminal water marks and file size defaults** (ag-workspace): 256/64 KiB and 2 MiB default /
    16 MiB hard cap, to be tested and possibly revised there; the renderer takes them as given.
14. **Base URL channels** (ag-providers and ag-auth, settled; their channel names win): `models.setBaseUrl`
    as in §7.0.1, the catalog endpoint union, `CredentialRef.kind: 'none'` and `baseUrl`, and the
    keyless-connection creation channel.
15. **D-010 isolation proposal** (joint with ag-foundation): starts with M2, decided before M3. §1.5 is
    my input.
