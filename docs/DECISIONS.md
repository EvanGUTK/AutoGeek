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
