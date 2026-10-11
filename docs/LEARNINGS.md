# Learnings

Maintained by the chief. Corrections and conventions learned during the build, so no agent repeats
a mistake. Re-read after every `git rebase main`. Newest at the bottom; each entry says *why*.


## L-001 Turbo's cache is shared across worktrees and misses root config (2026-10-11)
`pnpm verify` can replay ANOTHER branch's green result (shared local cache) and does not hash
`tsconfig.base.json`. **Until ag-foundation's fix lands, run `TURBO_FORCE=true pnpm verify`** (authors
before every commit and review request; reviewers always). A green run that printed "cache hit" proves
nothing. *Why:* ag-reviewer reproduced a stale pass by editing the base tsconfig.

## L-002 Disclose every automatic or tool-driven config change (2026-10-11)
pnpm 12 silently added zod 4.6.6 to `minimumReleaseAgeExclude`, bypassing the supply-chain cooldown,
and nobody noticed. After any install/upgrade command, diff the workspace and lockfile config and
disclose every change in the commit body. Never use a release younger than the cooldown; any
`minimumReleaseAgeExclude` entry needs a DECISIONS entry and the chief's approval. *Why:* the
cooldown exists for the window before a compromised publish is caught (ARCHITECTURE §8.8).

## L-003 A policy that can be opted out of is not a policy (2026-10-11)
Enforcement (lint bans, skipped-test bans, boundary rules, tsconfig strictness) must be tested by
running the REAL command path (e.g. the actual `eslint` CLI over a fixture tree containing a nested
config), not by config-object test APIs that skip the lookup. For every ban, write the circumvention
you would try (nested config, alias import, chained modifier, double assertion, `dist/` exports) and
test that it fails. Rules fail closed: unknown package, missing script, or unmatched path = deny.
*Why:* slice 1-2 shipped six majors of this kind; wave-2 agents copy whatever pattern exists.

## L-004 Agents propose, the chief accepts (2026-10-11)
A DECISIONS entry written by an agent is `proposed (<agent>)` until the chief acknowledges it; then
`accepted (chief, <date>; proposed by <agent>)`. Do not claim "accepted" yourself, and do not state
a decision's effects as true before the code does ("all versions are exact" while ranges remain).

## L-005 Cross-package capabilities are injected through ports in core (2026-10-11)
When package A needs a capability implemented by package B and §4 has no A→B edge, do NOT add the
edge: define a port (interface) in `@autogeek/core`, implement it in B, and wire it in
`apps/desktop`. Example: `mcp` gets OAuth through a core `OAuthPort` implemented by `auth`.

## L-006 Never run machine-wide process killers (2026-10-11)
`pkill -f 'pnpm verify'` matches every agent's process on the shared machine and killed in-flight runs.
Kill only your own processes by PID. *Why:* eight agents share one machine.

## L-007 Tests that execute generated input need a sandbox, not just a vocabulary (2026-10-11)
A "closed grammar" shell fuzz still allowed a recursive function named after the harness (fork bomb) and
`PATH=''` still ran cwd files in macOS sh. Execute only strings that BOTH the parser accepts AND an
independent guard confirms are harmless; never execute rejected strings; add resource limits, timeouts,
process-group kill, and a canary proving the test can fail. *Why:* the strings a parser-hunting fuzz
looks for are exactly the ones that smuggle commands.

## L-008 READY TO MERGE must be mergeable by evidence (2026-10-11)
State the approved SHA, the ref to merge (containing only approved commits), that it is based on current
main (re-check main before sending), and `git range-diff` against each approved SHA after any rebase. The
chief verifies ancestry and equivalence itself; a claim without evidence is not accepted. *Why:* several
messages quoted stale SHAs or bases after main moved.

## L-009 Fail-closed means every error path denies (2026-10-11)
Missing classifier, unreadable rule store, failed flush, degraded watcher, stat error, unknown subcommand,
unparseable shell string, unreadable trust history: all treat the situation as the dangerous case. Any
"allow" must come from a positive, successful, current check. *Why:* most major findings so far were
fail-open edges (quarantine write failures, A→B→A identity, cache replays, `|| true`).
