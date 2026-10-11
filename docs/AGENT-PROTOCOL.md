# Agent Protocol

Every AutoGeek agent is an independent Claude Code CLI session in its own tmux window and its own
git worktree. The **chief** (session `autogeek-d5`) coordinates. You are not a subagent: you own
your branch end to end, but you do not own the architecture.

Read in this order at the start of every task: `ARCHITECTURE.md`, this file, `docs/LEARNINGS.md`,
`docs/DECISIONS.md`, `CLAUDE.md`. Re-read `docs/LEARNINGS.md` after every `git rebase main`;
that is where the chief records corrections so you do not repeat them.

## 1. Quality bar (non-negotiable)

- No shortcuts taken "to go faster". If the right way is slower, take the right way.
- No `any`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `as unknown as`, skipped or
  `.only` tests, swallowed errors, or `catch {}`. If you believe you truly need one, ask the chief.
- No spaghetti: single responsibility per module, explicit dependencies (inject, do not import
  globals), functions small enough to read in one screen, no circular imports, no hidden state.
- Validate every trust boundary with zod. Return typed `Result`s for expected failures; throw only
  for programmer errors.
- Every behavior change ships with tests that fail without it (write the test first). Run the real
  thing, not only mocks, where a real thing is feasible.
- Security rules in `ARCHITECTURE.md` §8 apply to every change. When in doubt, deny.
- Match surrounding style. Do not reformat code you did not change.

## 2. Worktree & branch rules

- Your worktree: `/Users/alpha1/Coding Projects/bridgemind/AutoGeek-worktrees/<agent>` (created by
  the chief). Never edit files in the primary checkout or another agent's worktree.
- Branches are `agent/<agent>/<topic>`. One topic per branch; keep branches short-lived.
- Never commit to `main` (only the chief does, by fast-forward). Never force-push, with ONE narrow
  exception: `git push --force-with-lease` on your OWN `agent/<you>/*` branch after rebasing it onto
  `main`, never on `main`, never on another agent's branch, always stated in your READY TO MERGE message
  (with a `git range-diff` against each approved SHA). Never rewrite commits that were already reviewed
  other than by such a rebase. Keep unreviewed work on a separate ref from the approved commits.
- Never run machine-wide process killers (`pkill -f`, `killall`); kill only your own processes by PID.
- A `main` commit by the chief forces every in-flight branch to rebase, so the chief batches them.
- Stay inside your scope (ARCHITECTURE.md §10). Need a change in another package? Ask the owner
  or the chief; do not edit it yourself unless the chief says so.

## 3. Commits (atomic)

- One logical change per commit; the tree must build and `pnpm verify` must pass **at every
  commit**, not just the last.
- Conventional Commits: `feat(auth): add vault read path`. Imperative subject ≤ 72 chars, a body
  explaining *why* when it is not obvious.
- Never mix refactor + behavior change, or code + unrelated docs, in one commit.
- Add the trailer for the model you actually run as, e.g.
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` or
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage explicit paths (`git add <paths>`), never `git add -A`. Never commit secrets, `.env`, or
  anything under `.agents/`.

## 4. Review gate (no commit-to-merge without it)

1. Finish a coherent slice (typically 1–6 atomic commits). Run `pnpm verify`; it must be green.
2. Message `ag-reviewer` (see §6) with: branch, base SHA (`git merge-base HEAD main`), head SHA,
   one paragraph of intent, how to run the tests, and any area you want scrutinized.
3. `ag-reviewer` (Opus 5.5, xhigh) reads the diff, runs the checks, and writes a verdict file to
   `/Users/alpha1/Coding Projects/bridgemind/AutoGeek/.agents/reviews/<agent>-<headsha>.md`
   with `APPROVE` or `CHANGES_REQUESTED` and numbered findings (file:line, severity, why, fix).
   It also messages you. The reviewer never edits your code and never commits.
4. On `CHANGES_REQUESTED`: fix with **new** atomic commits (or a fixup you then autosquash
   *before* re-requesting review), re-run `pnpm verify`, request re-review. Disagree? Say so with
   evidence to the reviewer; if still stuck, escalate to the chief.
5. On `APPROVE` for the exact head SHA: `git fetch` if a remote exists, `git rebase main`, re-run
   `pnpm verify`. If the rebase changed anything non-trivial, request a quick re-review.
   Then push your branch (`git push -u origin <branch>` if `origin` exists) and tell the chief
   "READY TO MERGE <branch> <sha>". **The chief performs the fast-forward merge into `main`.**
6. Reviewers' own work is reviewed too: `ag-reviewer` changes (docs, review tooling) go through
   the chief.

## 5. Questions & escalation

- Ask the **chief** (never the user). The chief asks the user only if truly unsure.
- Ask early when: a contract in `@autogeek/core` seems wrong, scope is ambiguous, two reasonable
  designs have different security properties, a dependency is needed, or you are blocked >15 min.
- Do not guess on security-relevant decisions. Do not invent API shapes of libraries — read the
  installed version's types/docs.
- A good question: what you are doing, what you tried, the 2–3 options with tradeoffs, and which
  you recommend. Then keep working on something unblocked while you wait.

## 6. Messaging

Primary: `SendMessage` with `to` set to the agent's session name (`autogeek-d5` for the chief,
`ag-reviewer`, `ag-<name>`). First line must be a self-contained summary. Messages are
delivered at the recipient's next tool round.

Fallback / durable record: write a markdown file to
`/Users/alpha1/Coding Projects/bridgemind/AutoGeek/.agents/inbox/<recipient>/<UTC-timestamp>-<sender>.md`.
Check `.agents/inbox/<you>/` at the start of each task and after every review.

Status: keep `.agents/status/<you>.md` current (task, branch, head SHA, state: working / blocked /
in-review / ready-to-merge, one-line next step). The chief reads these instead of polling you.

## 7. Definition of done for a slice

- [ ] Meets the acceptance criteria in the task brief
- [ ] `pnpm verify` green at every commit
- [ ] Tests cover new behavior, including failure paths and cancellation
- [ ] No new `any` / suppressions / TODOs without a `docs/DECISIONS.md` entry
- [ ] Docs updated if a contract or behavior changed
- [ ] `ag-reviewer` APPROVE on the exact head SHA
- [ ] Rebased on current `main`, still green
