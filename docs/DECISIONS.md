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

## D-005 Toolchain pins and repo-policy-as-code in `@autogeek/tooling`
- **Status:** accepted (chief, 2026-10-11; proposed by ag-foundation)
- **Context:** Latest `typescript` is 7.0.x, but `typescript-eslint` 8.71.1 (latest) peers
  `typescript >=4.8.4 <6.1.0`, so type-aware linting does not support 7.x yet. Lint policy and
  dependency rules are only trustworthy if they are themselves tested, through the real command
  path rather than config-object APIs.
- **Decision:** Pin `typescript` 6.0.3 until typescript-eslint supports a newer line; no
  peer-dependency overrides or ignores to force a newer TypeScript. **Revisit** when a
  typescript-eslint release widens its `typescript` peer range to include the next TypeScript
  major. Every third-party dependency is declared as `catalog:` in package.json with an exact
  version in the `pnpm-workspace.yaml` catalog (enforced by `tooling/src/workspace-policy.test.ts`).
  The lint policy (`tooling/src/eslint-config.ts`), the package-boundary matrix
  (`tooling/src/dependency-rules.ts`) and the shared Vitest config (`tooling/src/vitest/`) live in a
  private `@autogeek/tooling` workspace package; `eslint.config.js` and `.dependency-cruiser.mjs`
  at the root are thin wrappers. `noInlineConfig` is on and ESLint is always run with
  `--config eslint.config.js`, so no file or nested config can opt out. The pnpm release-age
  cooldown is enforced with `minimumReleaseAgeStrict: true` and there is no
  `minimumReleaseAgeExclude`; any exclusion needs its own DECISIONS entry and the chief's approval.
- **Consequences:** `tooling/` is part of the §4 layout. Dependency boundaries use
  dependency-cruiser (cycles, unresolvable and undeclared imports for free) rather than
  eslint-plugin-boundaries. Turborepo's `agentGuidance` is disabled so it does not write
  `AGENTS.md`, which §7 reserves for project rules, and its cache is per checkout with root
  config files hashed (LEARNINGS L-001).
