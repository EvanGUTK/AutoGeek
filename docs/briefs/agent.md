# Brief: ag-agent (opus-5-5 / xhigh) — `@autogeek/agent` + `@autogeek/permissions` (M3)

You own the heart of the product: the agent loop and the permission gate. Develop against
scripted fakes of `ModelProvider` and `Tool` so you are not blocked on other agents.

## Deliver (atomic commits)
1. **`permissions`:** policy engine (rules: allow/deny/ask by tool, risk class, path glob, command
   pattern), `PermissionGate` implementation with an injected `Approver` (the UI, in prod), session-
   and project-scoped remembered decisions (exact-match rules only, never broad wildcards granted
   implicitly), append-only audit log, default-deny. Prompt-injection invariant: tool output and
   file contents can never create or widen a rule. Exhaustive table-driven tests.
2. **Loop as a pure state machine:** assemble context → stream `ModelProvider` → collect tool calls
   → gate → execute (parallel only for independent read-only calls) → append results → repeat.
   Termination: `end_turn`, step/token/time/spend budgets, abort. Typed `AgentEvent` stream.
   Deterministic given a scripted provider. Abort propagates to model stream, running tools, and
   pending approvals, leaving the transcript consistent (every tool_call gets a tool_result).
3. **Modes** `ask` / `plan` / `agent` with different tool allowlists enforced in the loop, not
   merely suggested in the prompt.
4. **Edit application:** search/replace blocks with exact-match + uniqueness checks; ambiguity or
   no-match returns a precise error to the model; never fuzzy-apply silently. Whole-file write.
5. **Checkpoints:** shadow git directory (separate `GIT_DIR`, user's index/branches untouched)
   snapshot before each writing turn; per-turn diff, undo, and restore; crash-safe.
6. **Context assembly:** system prompt builder, project rules (`AUTOGEEK.md`/`AGENTS.md`),
   @-mention resolution through injected resolvers, token budgeting, and compaction with a
   visible, inspectable summary. Tool-result truncation with explicit markers.
7. **Resilience:** malformed tool args → error result to the model (bounded retries), provider
   errors surfaced with typed causes, loop-detection (identical repeated calls) with a hard stop.

## Acceptance
Property/fuzz tests on the loop's transcript invariants; every abort point tested; `pnpm verify`
green per commit; ag-reviewer APPROVE. Escalate any `core` contract gap to the chief immediately.
