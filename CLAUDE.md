# AutoGeek

BYOK agentic IDE (Electron + Monaco + TypeScript, pnpm monorepo). Source of truth: `ARCHITECTURE.md`.

- Working as an agent? Follow `docs/AGENT-PROTOCOL.md` exactly. Read `docs/LEARNINGS.md` first.
- Commands (once M0 lands): `pnpm install`, `pnpm verify` (typecheck + lint + test), `pnpm dev`.
- Never: `any`, `@ts-ignore`, lint suppressions, skipped tests, `git add -A`, commits to `main`,
  force-push (sole exception: `--force-with-lease` on your OWN agent branch after a rebase, flagged in READY TO MERGE; see docs/AGENT-PROTOCOL.md §2), machine-wide `pkill`, credentials in logs/renderer/env. Stage explicit paths. Atomic Conventional Commits.
- Questions go to the chief (`autogeek-d5`), not the user.
- Credentials exist only in the Electron main process. The renderer is untrusted.
