# Decisions

ADR-style log. Newest at the bottom. Format: `## D-NNN title` — Status, Context, Decision, Consequences.

## D-001 Build the shell from scratch on Electron + Monaco
- **Status:** accepted (user, 2026-10-11)
- **Context:** Options were forking Code-OSS (Cursor/Antigravity route), Tauri, or Electron + Monaco.
- **Decision:** Electron + Monaco in a pnpm/Turborepo TypeScript monorepo.
- **Consequences:** small repo and fast parallel worktrees, full control of auth and the agent loop.
  No VS Code extension compatibility; extensibility comes via MCP and our own APIs.

## D-002 Subscription-OAuth providers are deferred pending a terms check
- **Status:** accepted (chief, 2026-10-11)
- **Context:** The product wants "BYOK OAuth". Providers differ on whether consumer-subscription
  tokens may be used by third-party apps, and policies change.
- **Decision:** Ship API keys first, then OAuth only for providers whose terms permit it. The chief
  verifies and records current terms here before any subscription-OAuth adapter is built.
- **Consequences:** `AuthMethod` stays an interface so adding one later is localized.

## D-003 Providers use raw `fetch` + our own parsers, no vendor SDKs
- **Status:** accepted (chief, 2026-10-11; proposed by ag-providers)
- **Context:** Vendor SDKs bring their own retry/timeout behavior (double-counting with ours) and
  vendor types we would have to wall off from the agent loop.
- **Decision:** `@autogeek/providers` owns the HTTP layer: SSE/NDJSON parsers, retry with
  `Retry-After`, no retry once tool-call bytes were emitted, zod schemas per vendor.
- **Consequences:** more parsing code to own and test (covered by the shared conformance suite);
  no vendor SDK in the dependency graph.

## D-004 Core model contract amendments (reasoning, caching, terminal events)
- **Status:** accepted (chief, 2026-10-11; proposed by ag-providers)
- **Decision:** `usage` splits `cacheReadTokens`/`cacheWriteTokens` (replaces `cachedTokens`);
  `reasoning` parts carry `signature?`/`redactedData?` and streams emit `reasoning_done`;
  `Message.cacheHint?`; streams end with exactly one terminal `done` or `error`, and
  `stopReason` no longer includes `'error'`.
- **Consequences:** see ARCHITECTURE.md §5.

## D-006 Permission gate: tools call it, the loop wraps it (proposed by ag-agent)
- **Status:** accepted (chief, 2026-10-11)
- **Decision:** Tools call `ctx.gate.check(req, signal)` once per effect; the loop hard-denies tools
  outside the mode allowlist and supplies a call-scoped wrapper (provenance, mode risk ceiling,
  events). Decisions carry a deny reason. `ToolResult.content` is `string | (text|image)[]` plus
  `truncated`. Remembered rules are stored only in per-user app data, never in the workspace.
  Shell commands are `exec_shell`, class `unknown`, always ask.
- **Consequences:** a tool that forgets to call the gate is the main risk; mitigated by a shared
  tool conformance harness (fake gate asserting `check` precedes any mutation) and loop-side
  detection of write/exec/network tools completing without a recorded allow.
