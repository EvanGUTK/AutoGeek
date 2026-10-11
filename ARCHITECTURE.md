# AutoGeek — Architecture

AutoGeek is a **bring-your-own-key (BYOK) agentic IDE** in the vein of Cursor and Antigravity.
The user supplies their own model credentials (API keys, or OAuth where the provider sanctions it);
AutoGeek supplies the editor, the agent loop, the tools, and the safety rails. There is no
AutoGeek-hosted inference and no AutoGeek account: credentials and code never leave the user's
machine except to the model provider the user chose.

> Status: M0 (foundation) in progress. This document is the source of truth. If code and this
> document disagree, stop and raise it with the chief — do not silently diverge.

## 1. Principles

1. **Security before features.** Credentials live only in the Electron main process, encrypted at rest.
   The renderer is untrusted. Every tool call that touches disk, shell, or network goes through one
   permission gate.
2. **No shortcuts.** No `any`, no `@ts-ignore`, no skipped tests, no TODO-as-implementation,
   no "temporary" bypasses of the permission gate. If something is deferred, it is written in
   `docs/DECISIONS.md` with a reason, not hidden in code.
3. **Small, acyclic packages with typed seams.** Packages talk through interfaces defined in
   `@autogeek/core`. No package imports another's internals, only its public `index.ts`.
4. **Everything is cancellable and observable.** Every long operation takes an `AbortSignal` and
   emits typed events. Nothing blocks the UI thread.
5. **Provider-agnostic.** The agent loop never sees a provider SDK type, only normalized messages
   and events.
6. **Reversible by default.** Every agent edit is checkpointed; the user can undo any agent turn.

## 2. Tech stack

| Concern | Choice |
|---|---|
| Shell | Electron (latest stable), `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| Monorepo | pnpm workspaces + Turborepo |
| Renderer | React + Vite, Zustand for UI state, Monaco editor |
| Terminal | xterm.js in renderer, `node-pty` in main |
| Validation | zod at every trust boundary (IPC, provider responses, config files, MCP) |
| Tests | Vitest (unit/integration), Playwright (Electron e2e) |
| Lint/format | ESLint (typescript-eslint strict) + Prettier; CI-equivalent `pnpm verify` |
| Search | ripgrep (bundled) for text; tree-sitter for symbols/repo map |

## 3. Process model

```
┌────────────────────────── Electron main (trusted) ──────────────────────────┐
│  AuthVault ─ ProviderRegistry ─ AgentRuntime ─ ToolHost ─ McpHost            │
│       │            │                │             │          │              │
│  CredentialStore   LLM adapters     Loop+Planner  PermissionGate  MCP clients│
│  WorkspaceService (fs, git, watch, index, pty)  CheckpointStore  Settings    │
└───────────────▲──────────────────────────────────────────────────────────────┘
                │ typed, zod-validated IPC (preload bridge, no raw ipcRenderer)
┌───────────────┴────────────── Renderer (untrusted, sandboxed) ───────────────┐
│  Layout · Monaco editors · File tree · Terminal · Agent panel · Diff review   │
│  Settings/Auth UI · Command palette                                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Renderer never receives a credential, only a `CredentialRef` (opaque id + display label).
- Provider HTTP calls happen **only in main**. The renderer cannot make them.
- Agent runs live in main (or a utility process) and stream `AgentEvent`s to the renderer.

## 4. Repository layout

```
apps/
  desktop/                 Electron main, preload, renderer (React)
packages/
  core/                    Shared types, zod schemas, IPC contracts, Result/Error types, event bus
  auth/                    CredentialStore (safeStorage/Keychain), API-key + OAuth(PKCE) flows
  providers/               LLM adapters → normalized streaming (Anthropic, OpenAI, Google,
                           OpenRouter, OpenAI-compatible/local e.g. Ollama, LM Studio)
  agent/                   Agent loop, modes, context assembly, planner, checkpoints
  tools/                   Built-in tools: read/write/edit file, list, grep, glob, shell, git
  mcp/                     MCP client host (stdio + streamable HTTP), tool/resource bridging
  workspace/               FS service, file watcher, git service, ignore rules, indexer, pty
  permissions/             PermissionGate: policy engine, approval requests, audit log
  ui-kit/                  Design tokens + shared React components
docs/
  DECISIONS.md             ADR-style log of decisions and deferrals
  AGENT-PROTOCOL.md        How agents work, commit, review, and escalate
  SECURITY.md              Threat model and rules
.agents/                   Local-only (gitignored): mailbox, review verdicts, status
```

**Dependency rules** (enforced by an ESLint boundary rule + `pnpm verify`):
`core` ← everything. `permissions` ← `tools`, `agent`, `mcp`. `workspace` ← `tools`, `agent`.
`providers` ← `agent`. `auth` ← `providers`. `apps/desktop` may import any package; no package
imports `apps/desktop`. No cycles.

## 5. Key interfaces (owned by `@autogeek/core`)

These are the contracts every agent codes against. Changing one requires the chief's sign-off.

```ts
// Normalized conversation model — the ONLY thing the agent loop sees.
type Role = 'system' | 'user' | 'assistant' | 'tool';
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; dataBase64: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; output: unknown; isError: boolean }
  // Opaque provider data must round-trip untouched. `redactedData` is set (text empty) for
  // redacted thinking blocks.
  | { type: 'reasoning'; text: string; signature?: string; redactedData?: string };
// `cacheHint` marks a prompt-cache breakpoint after this message; adapters without caching ignore it.
interface Message { role: Role; content: ContentPart[]; cacheHint?: 'ephemeral' }

// Streaming events from any provider, normalized. A stream ends with EXACTLY ONE terminal
// event: `done` or `error`, never both, never neither (adapters guarantee this, incl. on abort).
type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  // Emitted once per reasoning block when complete, so signatures/redacted data are not lost.
  | { type: 'reasoning_done'; text: string; signature?: string; redactedData?: string }
  // Emitted only when the tool input is fully assembled and parsed; adapters never leak partial JSON.
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number;
      cacheReadTokens?: number; cacheWriteTokens?: number }   // priced differently
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' }
  | { type: 'error'; error: ProviderError };

interface ModelProvider {
  readonly id: string;                    // 'anthropic' | 'openai' | ...
  listModels(cred: ResolvedCredential, signal: AbortSignal): Promise<ModelInfo[]>;
  stream(req: ModelRequest, cred: ResolvedCredential, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

interface AuthMethod {                    // API key, OAuth PKCE, none (local)
  readonly kind: 'api_key' | 'oauth_pkce' | 'none';
  begin(...): Promise<AuthSession>;
  refresh?(...): Promise<void>;
}

interface Tool<I, O> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<I>;
  readonly risk: 'read' | 'write' | 'exec' | 'network';
  run(input: I, ctx: ToolContext): Promise<ToolResult<O>>;   // ctx carries signal + gate
}

// Model-facing result is measurable/truncatable; `structured` is for UI/AgentEvents only.
interface ToolResult<O> {
  content: string | Array<TextPart | ImagePart>;   // also the shape of ContentPart tool_result output
  truncated: boolean;
  isError: boolean;
  structured?: O;
}

// TOOLS call the gate, once per effect, with the precise literal effect (only the tool knows the
// realpath / sensitive class / command class). The LOOP hard-denies tools outside the mode
// allowlist before `run` and hands each call a call-scoped gate wrapper that stamps provenance,
// enforces the mode risk ceiling, and emits permission events. Tools build a PermissionRequestInput
// (no provenance); only the wrapper produces a full PermissionRequest.
interface PermissionGate {
  check(req: PermissionRequestInput, signal: AbortSignal): Promise<PermissionDecision>;
}
type PermissionDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: 'policy' | 'user' | 'mode' | 'untrusted_workspace' | 'aborted' };
// PermissionRequestInput = { tool, risk, action, literal } where
// action = fs_read{path(realpath),sensitive} | fs_write{path,sensitive,op,to?}
//        | exec{argv,cwd,class} | exec_shell{command,cwd} (always class 'unknown' → ask)
//        | network{url} | mcp{server,tool,input}; `literal` is tool-built, never model prose.
```

Remembered permission rules live ONLY in per-user app data (keyed by workspace-root realpath),
exact-match only, and are never read from or written to the workspace, so a repository can never
ship pre-approved actions.

## 6. Auth model (BYOK)

- **API keys** for every provider: stored via Electron `safeStorage` (macOS Keychain / Windows DPAPI /
  Linux libsecret; refuse to store if only the plaintext fallback backend is available, and tell the
  user). Keys are decrypted just-in-time inside main, never logged, never put in env of child
  processes, never sent to the renderer.
- **OAuth (PKCE, loopback redirect)** only for providers whose terms permit third-party apps
  (e.g. OpenRouter, Google). Tokens stored the same way; refresh handled in `auth`.
- **Subscription OAuth (e.g. consumer Claude plans, ChatGPT plans):** each provider's terms on
  third-party use of subscription tokens differ and change. These are **off by default and
  not built until the chief has verified the current terms in writing** in `docs/DECISIONS.md`.
  The `AuthMethod` seam makes adding one later a localized change.
- Per-project credential selection, per-key spend caps, and a visible "which key/model is this
  turn using" indicator are first-class.

## 7. Agent runtime

- **Modes:** `ask` (read-only), `plan` (read-only + produces a plan artifact), `agent` (tools with
  gate), each with a different tool allowlist.
- **Loop:** assemble context → stream model → collect tool calls → gate → execute (parallel when
  independent and read-only) → append results → repeat until `end_turn`, step budget, token
  budget, or user abort. Loop is a pure state machine over `ModelProvider` + `ToolHost`
  so it is testable with a scripted fake provider.
- **Edits:** search/replace block edits with exact-match + uniqueness checks (fail loudly, never
  fuzzy-apply silently), plus whole-file write. Every turn that writes creates a **checkpoint**
  (shadow git ref in a private git dir, never touching the user's branches/index) enabling
  per-turn undo and diff review.
- **Context:** @-mentions (files, folders, symbols, terminal, git diff), a tree-sitter repo map,
  ripgrep tool, project rules from `AUTOGEEK.md` / `AGENTS.md`, automatic compaction when near
  the window with a visible summary the user can inspect.
- **MCP:** servers configured per-user/per-project, tools surfaced through the same `Tool`
  interface and the same gate (MCP tools are `network`/`exec` risk until proven otherwise).
- **Budgets:** hard caps on steps, tokens, wall time, and spend per run; all user-configurable.

## 8. Security rules (summary — full model in `docs/SECURITY.md`)

1. Renderer: sandboxed, CSP strict, no `remote`, no `eval`, navigation and `window.open` denied.
2. IPC: every channel declared in `@autogeek/core`, input and output validated with zod; no
   wildcard channels; senders verified.
3. Paths: all tool paths resolved + realpath'd and must stay inside the trusted workspace roots
   (symlink escapes rejected). Files like `.env`, key files, `.git/config` need explicit approval.
4. Shell: executed with a scrubbed env (no AutoGeek credentials), cwd pinned to workspace,
   timeout + output cap, process-group kill on abort. Commands classified; destructive/network
   commands always require approval unless the user pinned an exact rule.
5. Prompt-injection posture: tool results and file contents are untrusted data; they can never
   widen permissions. Approval prompts show the literal action, not model prose.
6. Workspace trust prompt on first open; agent mode disabled in untrusted workspaces.
7. Logs redact secrets; telemetry is off and not implemented in v1.
8. Dependencies pinned, `pnpm audit` clean, lockfile reviewed.

## 9. Milestones

| M | Goal | Done when |
|---|---|---|
| M0 | Foundation | Monorepo builds; `pnpm verify` (typecheck, lint, test) green; Electron window boots with secure defaults; typed IPC skeleton; core contracts in place |
| M1 | Editor shell | Open folder, file tree, Monaco tabs, save, terminal, git status |
| M2 | BYOK + chat | Add API key (vault), pick model, streaming chat panel against ≥2 providers |
| M3 | Agent v1 | Tool loop with gate, edits + checkpoints + diff review/undo, ask/plan/agent modes |
| M4 | Extensibility | MCP host, project rules, repo map, @-mentions, context compaction |
| M5 | Hardening | OAuth providers (permitted only), Playwright e2e, packaging/signing, security review pass |

## 10. Agent roster (summary — protocol in `docs/AGENT-PROTOCOL.md`)

Models: **sonnet-5-5 @ high** by default. **opus-5-5** only where noted (hard integrations / security).
Only the chief runs Fable 5.1.

| Agent | Worktree branch | Model / effort | Scope | Wave |
|---|---|---|---|---|
| chief | `main` | fable 5.1 | Architecture, review routing, merges, answers questions | — |
| ag-foundation | `agent/foundation/*` | sonnet-5-5 / high | Monorepo, tooling, `core` contracts, Electron secure boot, IPC skeleton | 1 |
| ag-reviewer | `agent/reviewer/*` | opus-5-5 / xhigh | Independent review of every branch before merge | 1 (standing) |
| ag-auth | `agent/auth/*` | opus-5-5 / high | `auth`, credential vault, OAuth PKCE | 2 |
| ag-providers | `agent/providers/*` | opus-5-5 / high | `providers` adapters + streaming normalization | 2 |
| ag-agent | `agent/agent/*` | opus-5-5 / xhigh | `agent` loop, checkpoints, modes, `permissions` | 2 |
| ag-mcp | `agent/mcp/*` | opus-5-5 / high | `mcp` host | 3 |
| ag-workspace | `agent/workspace/*` | sonnet-5-5 / high | `workspace`, `tools` (fs/git/grep/shell/pty) | 2 |
| ag-ui | `agent/ui/*` | sonnet-5-5 / high | `ui-kit`, renderer shell, Monaco, panels | 2 |

Wave 2 starts only after ag-foundation is reviewed and merged, because every other package builds
on its contracts and tooling.
