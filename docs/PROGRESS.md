# AutoGeek — progress record and resume guide

Snapshot: **2026-10-11, paused at the user's request.** `main` = the commit that adds this file
(parent `0e2491b`). Remote: private `https://github.com/EvanGUTK/AutoGeek` (all `agent/*` branches pushed).
Written by the chief (session `autogeek-d5`). Agent handoff summaries are appended in §9 as they arrive.

## 1. What this is
AutoGeek is a BYOK agentic IDE (Cursor/Antigravity-style): Electron + Monaco from scratch, TypeScript pnpm/Turbo
monorepo, no AutoGeek-hosted service, credentials only in the Electron main process, renderer untrusted.
Source of truth: `ARCHITECTURE.md`. Contracts: `docs/model-contract.md`, `docs/agent-contract.md`,
`docs/ui-spec.md`, `docs/ipc-channels.md`, `docs/workspace-*-cases.md`. Decisions: `docs/DECISIONS.md`
(D-001..D-006, D-010..D-012 on main; D-007 auth, D-008/D-013 providers live on agent branches).
Lessons learned by the build: `docs/LEARNINGS.md` (L-001..L-009). Protocol: `docs/AGENT-PROTOCOL.md`.

## 2. How the build runs
- **Chief** (this session, Sonnet 5.5 here; the user may switch to Fable 5.1 with `/model`) decides contracts,
  answers all agent questions (asks the user only if truly unsure), verifies and fast-forwards `main`.
- **Agents** are separate Claude CLI sessions in their own git worktrees (`../AutoGeek-worktrees/<agent>`):
  `ag-foundation`, `ag-auth`, `ag-agent`, `ag-providers`, `ag-workspace`, `ag-ui` (Sonnet 5.5 high except
  auth/agent/providers = Opus 5.5 high/xhigh), plus **`ag-reviewer`** (Opus 5.5 xhigh, read-only gate).
- **Gate:** nothing merges without `ag-reviewer` APPROVE on the exact SHA; the chief independently re-verifies
  ancestry, `git range-diff` equivalence and (for code) a clean uncached `TURBO_FORCE=true pnpm verify`
  in a scratch worktree, then fast-forwards `main` and pushes. Authors never touch `main`.
- Atomic Conventional Commits; every commit passes forced verify; no `any`, suppressions, skipped tests,
  `git add -A`, machine-wide `pkill`; narrow `--force-with-lease` exception only on one's own branch.

## 3. What is on `main` (all reviewed and independently verified)
- Docs: architecture, protocol, briefs, all contracts and specs, decisions D-001..D-006/D-010..D-012,
  lessons L-001..L-009, `scripts/agents/launch.sh`.
- Real tooling (`tooling/`): strict TS/ESLint (incl. `no-unsafe-type-assertion`), dependency-cruiser boundaries,
  shared Vitest config failing on skipped tests, package-policy checks (scripts exact, environment typing
  neutral/node/dom, triple-slash ban, leak check via `ts.createProgram`), uncached `test` tasks (asserted).
- 8 stub packages (`auth providers agent tools mcp workspace permissions ui-kit`) with policy tests.
- `@autogeek/core` base: `Result`, bounded iterative JSON validation (depth 64 / 100,000 nodes, accessors
  rejected), `CoreError` + closed 26-code `ErrorCode` (snapshot + docs-consistency tests),
  `createCoreErrorSchema`, abort-aware emitter, `ToolOutput` (strict base64, 4 MiB image / 8 MiB caps).
- Not yet on main: any app code (`apps/desktop` does not exist), model-contract schemas, permissions, providers,
  auth, workspace services, UI components. **There is nothing runnable yet.**

## 4. Review ledger (31 verdicts: 21 APPROVE, 10 CHANGES_REQUESTED)
Every CHANGES_REQUESTED had a reproduced defect; the big ones, and the lesson each produced:
| Area | Finding | Lesson |
|---|---|---|
| tooling | nested `eslint.config` disabled the whole policy; `@ts-expect-error` allowed with a description; turbo cache replayed foreign/stale greens; `dist/` excluded dependency edges; zod pin bypassed the pnpm release cooldown silently | L-001, L-002, L-003 |
| stubs | policy check passable with `|| true`, substring checks, option passthrough; env check escapable via triple-slash directives and dependency typings | L-003 |
| core base | recursive JSON validator threw RangeError at ~4 KB nesting; tests reading outside the package replayed a stale cache; missing error code; unbounded ToolOutput | L-009 |
| workspace docs | shell-fuzz design could fork-bomb (function named after the harness; `PATH=''` ran cwd files) | L-007 |
| ui docs | renderer could escalate (trust, persistent rules, terminal); base-URL editable with no channel; approval guard focus-based | D-010 |
Reviewer also drove: root identity binding (D-012), exec-grant soundness (D-011), watcher tap, fail-closed everywhere.

## 5. Branch map (heads at pause; `main` = base for "ahead")
Merged to main: see §3. Approved but NOT merged: `agent/workspace/docs-r5` family (reviewed APPROVE at
`2bc7ba0`; ask ag-workspace for a READY TO MERGE with range-diff). Everything else below is unreviewed or
in review, and may carry WIP.
| Branch | Ahead | Head | State |
|---|---|---|---|
| agent/foundation/model-contract | 6 | db4d91d | schemas done; **review not yet requested** (blocks providers+agent) |
| agent/foundation/smoke-tooling | 2 | fe82caa | WIP (factory + policy + boundary rules pending) |
| agent/foundation/core, bootstrap | 11, 30 | 74fe799, e31327f | superseded drafts (permission/Tool commits to be redone vs agent-contract) |
| agent/auth/core-credentials | 1 | aa43c68 | slice 1 (CredentialRef/ResolvedCredential/AuthError) in progress |
| agent/auth/store | 14 | 3815767 | PKCE, GCM envelope, atomic writer, redaction, loopback, vault file, token client/refresher/revocation/ledger; 14/14 green; needs rebase + review |
| agent/auth/oauth-port-design | 2 | 857cd1a | docs-only OAuthPort design for ag-mcp |
| agent/agent/loop | 25 | 179b3d0 | design/plan docs + early code per slice 1a/1b/1c; unreviewed |
| agent/providers/adapters | 50 | 1c96843 | shared streaming core, Anthropic, OpenAI adapters, conformance (350 tests); Gemini next; unreviewed |
| agent/ui/ui-kit-tokens | 7 | d9754c7 | design tokens (161 tests); awaiting review |
| agent/ui/spec-identity-2 | 4 | cd55435 | UI side of identity_unavailable; awaiting review |
| agent/workspace/path-security | 3 | b99eddc | lexical path resolution; unreviewed |
| agent/workspace/docs-r5, fs-tools-next, docs-r3* | — | 2b3cbae, 83a314d | docs deltas (identity_unavailable, wording) |

## 6. Decisions that need the user eventually
1. **D-010 (renderer isolation) is a hard gate before agent mode (M3) ships**: split webContents by role or a
   sandboxed frame for model content; the user must accept the residual risk otherwise.
2. MCP OAuth client identity (wave 3): one candidate needs an AutoGeek-hosted metadata URL, in tension with the
   no-hosted-service principle.
3. Subscription-OAuth for Claude/ChatGPT plans stays OFF until provider terms are verified (D-002).
4. DOM test environment for `ui-kit` (happy-dom vs jsdom vs Playwright component tests) — evidence pending from ag-ui.
5. Consider a **second reviewer** once more than 3 code slices queue.

## 7. Milestones and honest ETA (estimates; ±2x)
M0 secure Electron window ~3–5 h of agent time after resume · M1 usable editor shell (open folder, tree, Monaco,
terminal, git status) ~+10–16 h · M2 chat with your own key ~+6–10 h · M3 agent with approvals/diff/undo
~+12–24 h and gated on D-010 · M4 MCP/rules/context · M5 packaging, signing, e2e, security pass.
Next foundation slices (in order): model-contract review → smoke tooling → IPC format + agent-contract schemas
→ `apps/desktop` (this is what produces the first runnable app).

## 8. How to resume
1. In each agent pane, `/exit` any old session, then relaunch (reuses the worktree; context comes from status
   files + docs; read `.agents/status/*.md` and §9 below):
   `cd "/Users/alpha1/Coding Projects/bridgemind/AutoGeek" && scripts/agents/launch.sh --here <agent> <model> <effort> <topic>`
   | agent | model | effort | topic |
   |---|---|---|---|
   | foundation | claude-sonnet-5-5 | high | bootstrap |
   | reviewer | claude-opus-5-5 | xhigh | reviews |
   | auth | claude-opus-5-5 | high | vault |
   | agent | claude-opus-5-5 | xhigh | loop |
   | providers | claude-opus-5-5 | high | adapters |
   | workspace | claude-sonnet-5-5 | high | fs-tools |
   | ui | claude-sonnet-5-5 | high | shell |
   (Sessions that are still running need no relaunch; the launch script refuses duplicate tmux windows.)
2. **Chief address:** agents message `autogeek-d5`. A new chief session gets a new name — tell every agent the
   new name (or have them use the inbox fallback `.agents/inbox/chief/` in the primary checkout).
3. Send each agent `RESUME` plus the first step from its §9 handoff. Merge queue first: ag-workspace docs
   (range-diff vs `2bc7ba0`), ask foundation to rebase + request review of `agent/foundation/model-contract`,
   then the review order: model-contract → ag-auth core-credentials → ag-agent 1a/1b → ui tokens, workspace
   path-security, auth store, providers.
4. Housekeeping: close the duplicate `ag-ui` session `[8374fe]`; the untracked `.mcp.json` in the repo root is the
   user's BridgeMind config (not committed); `.agents/` is gitignored (reviews, mailboxes, status live there).

## 9. Agent handoffs (as received at pause)

### ag-reviewer (Opus 5.5 xhigh) — PAUSED clean, nothing in progress, queue empty
- Completed since last summary: foundation stubs 7285bba APPROVE (merged); core base 557cece CR → ada10b0 CR → 69de871 APPROVE (merged); ui spec-identity 45b2888 APPROVE (minors I1–I4); workspace docs-r3 1f51572 + 9f23ca1 APPROVE; docs-r5 2bc7ba0 APPROVE (2 nits).
- Standing rules for a fresh reviewer: (1) never trust author claims; `TURBO_FORCE=true pnpm verify` from clean at EVERY commit for auth/permissions/agent-gate/workspace path-exec-trust/core/tooling, first/middle/last otherwise; the log must say "cache bypass", not "cache hit"; parallel runs via git-archive exports in the scratchpad (no shared worktrees). (2) Probe on the real path with the circumventions you would try (L-003). (3) Delta-only re-reviews: confirm base is an unchanged ancestor (range-diff), review only new commits, re-run earlier probes. (4) Never pkill by pattern; never edit or commit author code.
- Open nits to carry: add notice kind `identity_unavailable` to the spec-identity IPC doc (ag-ui); `git_remote_credentials` missing from the fixed category order in workspace docs-r5 (fix before ag-workspace's classifier code slice); watch any new turbo.json edits (tests must stay uncached).
- Expected review order after RESUME: foundation model-contract → ag-auth core-credentials → ag-agent 1a/1b → ui tokens / workspace path-security / auth store / providers.
