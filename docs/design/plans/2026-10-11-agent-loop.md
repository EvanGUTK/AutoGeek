# `@autogeek/agent` Loop Implementation Plan (slices 2–3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic agent loop that turns one user message into a run:
- stream the model;
- validate and gate tool calls;
- execute them, in parallel only for read-only calls;
- append results, and repeat until a typed outcome.

The transcript stays vendor-valid and append-only at every stop point.

**Architecture:** A pure reducer `transition(state, input) → { state, commands }` holds all
policy. A thin driver executes commands (model stream, tool batches, checkpoints, timers) and
feeds results back through one FIFO queue. Tools receive a call-scoped gate that stamps
provenance and reports decisions back to the reducer. `AgentSession` freezes the prefix, and
`AgentRuntime` binds sessions to windows and buffers events for replay.

**Tech Stack:** TypeScript, zod 4 (`z.toJSONSchema`, `z.prettifyError`), Vitest, fast-check.

**Spec:** `docs/design/agent-and-permissions.md` §3.1, §3.2, §3.6; `docs/agent-contract.md` §4,
§5, §7, §8; `docs/model-contract.md` §1–§3 and the append-only invariant. The contracts win.
Checkpoints (§3.4), edits (§3.3) and context/compaction (§3.5) have their own plans. Until then
this plan uses the `CheckpointPort` and `Compactor` ports defined in Task 6.

## Global Constraints

- Everything in slice 1's Global Constraints applies: core types only, no suppressions,
  `TURBO_FORCE=true pnpm verify` per commit, Conventional Commits with the Opus trailer.
- `agent` imports only `@autogeek/core`, `@autogeek/permissions` (types +
  `DetailedPermissionGate`), and later `@autogeek/workspace`. Never `providers` or `auth`.
  `ModelLimits` and pricing are injected values. The model stream is an injected
  `(req: ModelRequest, signal: AbortSignal) => AsyncIterable<ModelEvent>`, already bound to the
  credential.
- **No `Date.now`, `Math.random`, `crypto.randomUUID` or `setTimeout` outside the driver's
  injected `clock` / `ids` / `timers`.** The reducer is synchronous and I/O-free.
- **History is append-only.** The only transcript operations are `append`, `truncateTo` and
  `compact`. The tool list and system prompt are frozen per session, and each run's mode is
  announced by an appended `system` message.
- Defaults from the contract:
  - budgets: 50 steps, 2_000_000 tokens, 1_800_000 ms, 2_000_000 USD micros;
  - unknown-model limits: 8_192 context, 4_096 output;
  - `context_near_limit` at 80% of the input budget (window − maxOutput − 5%);
  - `toolAbortGraceMs` 5_000;
  - loop detection K = 3 within W = 10 executed calls;
  - invalid-call streak 3;
  - max parallel read calls 8;
  - per-result tool output cap 32_000 chars.
- Token budget = Σ(`inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`)
  (model-contract rule 2a). Spend = Σ round(tokens × price-per-1M-USD) for each component, in
  integer micros, `null` when the model is unpriced.
- Recoveries, each at most once per step and only before the step streamed any content:
  - `context_length` → compact, then retry;
  - `invalid_request` while replayed reasoning carries `providerMetadata` → retry with
    `reasoningReplay: 'drop'` and warning `reasoning_dropped`, **at most once per run**.

## Review Focus

1. **A provider that breaks the stream contract.** Examples: events after the terminal event,
   `text_done` with no open text part, a stream that ends with no terminal, duplicate call ids
   within a response. The run must end `provider_error` with kind `invalid_response`, and the
   transcript must stay valid. (Task 2 test `contract violations end the step as invalid_response`.)
2. **Parallel reads that finish out of order, mixed with a write.** For
   `[read a, read b, write c, read d]`, results must appear in call order, `write c` must start
   only after both reads settle, and `read d` only after `write c`. (Task 4 test
   `batches respect order barriers and results keep call order`.)
3. **Abort at every point.** Before the first event, mid-text, mid-reasoning, between two
   `tool_call` events, during the approval wait, during a parallel batch, during the grace
   period, and during the checkpoint. Each must yield one `run_finished` with outcome `aborted`,
   one `tool_finished` per `tool_call`, and a valid transcript. (Task 8 abort matrix.)
4. **A tool that throws, never settles, or settles after abort.**
   - a throw → error result with a correlation id, and the run continues;
   - never settles → `interrupted` after the grace period;
   - settles late → the late settle is ignored and doesn't double-emit.
   (Task 5 executor tests; Task 8.)
5. **A model that loops or keeps sending malformed calls.** Three identical `(call, result)` pairs
   → `loop_detected`. Three consecutive all-invalid steps → `invalid_tool_calls`. Neither may
   execute the offending call again. (Task 9 tests.)

---

### Task 1: Transcript and invariants

**Files:** Create `packages/agent/src/transcript/{transcript,invariants}.ts`; Tests alongside;
Modify the agent stub `package.json` (add `@autogeek/permissions` workspace dep and `fast-check`
dev dep, exact).

**Interfaces:**
- Produces:
  - `interface Epoch { id: string; start: number; summary: Message | null }`
  - `interface Transcript { readonly entries: readonly Message[]; readonly epochs: readonly [Epoch, ...Epoch[]] }`
  - `emptyTranscript(): Transcript`. The first epoch has `id: 'e0'`, `start: 0`,
    `summary: null`.
  - `append(t: Transcript, m: Message): Transcript`
  - `truncateTo(t: Transcript, index: number): Transcript`. It drops epochs whose
    `start >= index` (except epoch 0).
  - `compact(t: Transcript, start: number, summary: Message, id: string): Transcript`
  - `modelView(t: Transcript, prefix: readonly Message[]): readonly Message[]` returns
    `prefix`, then the latest epoch's summary (if any), then `entries.slice(latest.start)`.
  - `checkTranscript(entries: readonly Message[]): Result<void, TranscriptViolation>` with
    `TranscriptViolation = { code: 'empty_message' | 'tool_message_shape' | 'unpaired_tool_call' | 'orphan_tool_result' | 'first_not_user'; index: number }`

- [ ] **Step 1: Write the failing tests.**
  - Unit tests per violation code.
  - fast-check `append-only`: a random sequence of `append`/`truncateTo`/`compact` over
    deep-frozen messages. Assert:
    - (a) every stored message is reference-equal to the one appended;
    - (b) between two consecutive `compact` calls, each `modelView` is a prefix-extension of the
      previous one (element-wise reference equality);
    - (c) `truncateTo(i)` then `modelView` never contains entries `≥ i`.
- [ ] **Steps 2–4:** run → FAIL, implement, run → PASS. **Step 5:** verify, then commit
  `feat(agent): add append-only transcript and invariant checker`.

### Task 2: Stream accumulator

**Files:** Create `src/loop/stream-accumulator.ts`; Test alongside.

**Interfaces:**
- Produces:
  - `type StreamAccumulator` (opaque readonly record), `newAccumulator(step: number): StreamAccumulator`
  - `accumulate(acc: StreamAccumulator, ev: ModelEvent): Result<{ acc: StreamAccumulator; emit: readonly AgentEvent[] }, { code: 'invalid_response'; detail: string }>`
    - `text_delta` / `reasoning_delta` → emit `text_delta` / `reasoning_delta`;
    - `tool_call` / `tool_call_invalid` → emit `tool_call` (with `{ invalidRaw }` for the
      invalid form).
  - `finalize(acc: StreamAccumulator, cause: 'terminal' | 'interrupted'): { message: Message | null; calls: readonly StreamedCall[]; usage: ModelUsage | null; terminal: Extract<ModelEvent, { type: 'done' | 'error' }> | null }`
  - `type StreamedCall = { callId: string; name: string; input: JsonObject; invalid: null | { reason: 'invalid_json' | 'not_an_object' | 'truncated' } }`.
    An invalid call's `input` is `{}`, which is what gets replayed.

Rules:
- Parts are appended in event order, and `providerMetadata` is copied by reference, untouched.
- Reasoning comes only from `reasoning_done`.
- With `cause: 'interrupted'`, open text is kept as a plain text part and open reasoning is
  dropped.
- `message` is `null` when there are no parts.

- [ ] **Step 1: Write the failing tests:**
  - text + reasoning + 2 calls, replayed in order;
  - metadata is identity-preserved (`toBe`);
  - `interrupted keeps text, drops open reasoning`;
  - `tool_call_invalid replays as {} and emits invalidRaw`;
  - `contract violations end the step as invalid_response` (Review Focus 1): event after
    terminal, `text_done` without text, duplicate call id, a second `usage`;
  - an empty stream (`done` only) → `message: null`.
- [ ] **Steps 2–5**, then commit `feat(agent): accumulate model events into assistant messages`.

### Task 3: Call planning and batching

**Files:** Create `src/loop/tool-plan.ts`, `src/modes.ts`; Tests alongside.

**Interfaces:**
- Produces:
  - `interface CatalogEntry { name: string; risk: Risk; inputSchema: ZodType }`
    (`ToolCatalog = ReadonlyMap<string, CatalogEntry>`)
  - `allowlistFor(mode: AgentMode, catalog: ToolCatalog, builtinReadTools: ReadonlySet<string>): ReadonlySet<string>`.
    `ask` = the built-in read tools; `plan` = `ask` ∪ {`submit_plan`}; `agent` = every catalog
    tool. MCP tools are never in `ask`/`plan`.
  - `modeAnnouncement(mode: AgentMode, allow: ReadonlySet<string>): Message`. This is a
    `system` message whose text lists the permitted tools in sorted order and says other calls
    are rejected.
  - `type PlannedCall = { callId: string; name: string; disposition: 'run'; input: unknown; risk: Risk } | { callId: string; name: string; disposition: 'reject'; reason: ToolRejectReason; message: string }`
  - `planCalls(calls: readonly StreamedCall[], ctx: { catalog: ToolCatalog; allow: ReadonlySet<string>; disabled: ReadonlySet<string>; history: CallHistory }): { planned: readonly PlannedCall[]; loopTool: string | null }`
    - Check order per call:
      1. `invalid` → `invalid_json`;
      2. not in the catalog → `unknown_tool`;
      3. disabled → `tool_disabled`;
      4. not allowed → `not_in_mode`;
      5. zod failure → `invalid_input`, with `z.prettifyError` text;
      6. loop → `loop_detected`.
    - Every rejection message names the permitted tools when relevant.
  - `batchCalls(planned: readonly PlannedCall[], maxParallel: number): readonly (readonly string[])[]`.
    Only `run` calls. Maximal consecutive `read` runs are chunked by `maxParallel`; every other
    call gets its own batch.
  - `interface CallHistory { readonly items: readonly { signature: string; resultHash: string }[] }`,
    `callSignature(name: string, input: unknown): string` (canonical JSON),
    `recordResult(h: CallHistory, signature: string, resultHash: string, window: number): CallHistory`,
    `isLoop(h: CallHistory, signature: string, k: number): boolean`. `isLoop` is true iff
    ≥ k − 1 window items share `signature` and they all have one `resultHash`.

- [ ] **Step 1: Write the failing tests:**
  - one per rejection reason, plus check order;
  - batching of `[r,r,w,r]` → `[[r,r],[w],[r]]` (the pure half of Review Focus 2; Task 7 covers
    the end-to-end half);
  - a run of 10 reads with max 8 → `[8 reads],[2 reads]`;
  - `isLoop` false when results differ (read → edit → read pattern) and true on the third
    identical pair;
  - the mode announcement's text snapshot.
- [ ] **Steps 2–5**, then commit `feat(agent): plan, validate and batch tool calls per mode`.

### Task 4: Budgets and truncation

**Files:** Create `src/loop/budgets.ts`, `src/tools/truncate.ts`; Tests alongside.

**Interfaces:**
- Produces:
  - `addUsage(t: UsageTotals, u: ModelUsage, pricing: Pricing | null): UsageTotals`
    (`Pricing` = `ModelInfo['pricing']` non-null)
  - `tokensUsed(t: UsageTotals): number`
  - `budgetHit(args: { totals: UsageTotals; steps: number; budgets: RunBudgets; nextInputEstimate: number }): 'steps' | 'tokens' | 'spend' | null`.
    Time is the driver's timer.
  - `inputBudget(l: ModelLimits): number` = `floor((contextWindow − maxOutputTokens) × 0.95)`
  - `truncateToolOutput(o: ToolOutput, capChars: number): { output: ToolOutput; truncated: boolean }`.
    Head + tail around the marker `\n[… truncated ${removed} of ${total} characters …]\n`; the
    head is 60% of the kept characters. Images are untouched. The cap applies to the total text
    across parts.

- [ ] **Step 1: Write the failing tests:**
  - micros rounding is per component and deterministic;
  - unpriced → `costUsdMicros: null`, and the spend budget never triggers;
  - the token budget counts cache reads/writes;
  - steps hit at exactly `maxSteps`;
  - truncation keeps head and tail, puts exact counts in the marker, and is a no-op under the
    cap.
- [ ] **Steps 2–5**, then commit `feat(agent): add budget accounting and tool output truncation`.

### Task 5: Scoped gate and executor

**Files:** Create `src/tools/scoped-gate.ts`, `src/tools/executor.ts`; Tests alongside.

**Interfaces:**
- Consumes: `DetailedPermissionGate` (permissions), core `PermissionGate`, `ToolContext`, `Tool`.
- Produces:
  - `createScopedGate(a: { gate: DetailedPermissionGate; provenance: { sessionId: string; runId: string; callId: string; mode: AgentMode }; newCheckId: () => string; onDecided(d: PermissionDecidedInput): void }): PermissionGate`
    - It builds the `PermissionRequest` (adds provenance and `checkId`).
    - **Defense in depth:** in `ask`/`plan`, any request with a non-`read` declared or action
      risk is denied `mode` / via `mode` without calling the inner gate.
    - It calls `onDecided` exactly once per check, before returning.
  - `type PermissionDecidedInput = { type: 'permission_decided'; callId: string; checkId: string; request: PermissionRequest; decision: PermissionDecision; via: DecisionVia }`
  - `executeCall(a: { tool: Tool<unknown, unknown>; input: unknown; ctx: ToolContext; clock: () => number; newCorrelationId: () => string }): Promise<ToolSettled>`
  - `type ToolSettled = { type: 'tool_settled'; callId: string; durationMs: number; result: { kind: 'returned'; value: ToolResult<unknown> } | { kind: 'threw'; correlationId: string } }`.
    It never rejects.

- [ ] **Step 1: Write the failing tests:**
  - provenance is stamped and `checkId`s are unique;
  - the mode ceiling denies without calling the inner gate (spy);
  - `onDecided` is called once per check;
  - a tool that throws → `threw` with a correlation id, and the executor promise resolves;
  - `durationMs` comes from the injected clock.
- [ ] **Steps 2–5**, then commit `feat(agent): add call-scoped gate and tool executor`.

### Task 6: Loop state, inputs, commands, and the reducer (no tools yet)

**Files:** Create `src/loop/{state,reducer}.ts`; Test `src/loop/reducer.test.ts`.

**Interfaces:**
- Produces:
  - `interface LoopConfig { sessionId: string; runId: string; mode: AgentMode; budgets: RunBudgets; limits: ModelLimits; pricing: Pricing | null; model: { providerId: string; modelId: string; credentialLabel: string }; prefix: readonly Message[]; tools: readonly ToolSpec[]; catalog: ToolCatalog; allow: ReadonlySet<string>; maxOutputTokens: number; reasoning?: ModelRequest['reasoning']; params: LoopParams }`
    - `LoopParams` holds the Global Constraints' numeric defaults: `graceMs`, `loopK`,
      `loopWindow`, `invalidStreakMax`, `maxParallel`, `toolOutputCap`, `nearLimitRatio`.
  - `type LoopInput`:
    - `{ type: 'start'; user: Message; display: { text: string; contextItems: readonly { kind: MentionKind; label: string }[] }; transcript: Transcript; disabled: ReadonlySet<string> }`
    - `{ type: 'model_event'; event: ModelEvent }`
    - `{ type: 'model_closed' }`
    - `PermissionDecidedInput`
    - `ToolSettled`
    - `{ type: 'checkpoint_done'; phase: 'before' | 'after'; result: Result<{ checkpointId: string; excluded: number }, { code: string }> }`
    - `{ type: 'compaction_done'; result: Result<{ start: number; summary: Message; id: string; tokensAfter: number }, { code: string }> }`
    - `{ type: 'abort'; reason: 'user' | 'time' }`
    - `{ type: 'grace_expired' }`
  - `type LoopCommand`:
    - `{ type: 'emit'; event: AgentEvent }`
    - `{ type: 'call_model'; request: ModelRequest }`
    - `{ type: 'cancel_model' }`
    - `{ type: 'checkpoint'; phase: 'before' | 'after' }`
    - `{ type: 'run_batch'; calls: readonly { callId: string; name: string; input: unknown }[] }`
    - `{ type: 'cancel_tools' }`
    - `{ type: 'start_grace_timer'; ms: number }`
    - `{ type: 'compact'; view: readonly Message[]; start: number }`
    - `{ type: 'finish'; result: RunResult }`
  - `interface RunResult { outcome: RunOutcome; transcript: Transcript; totals: UsageTotals; steps: number; disabled: ReadonlySet<string>; wrote: boolean }`
  - `initialState(config: LoopConfig): LoopState` and
    `transition(s: LoopState, i: LoopInput): { state: LoopState; commands: readonly LoopCommand[] }`
  - Ports used by the driver (Task 7):
    - `interface CheckpointPort { snapshot(phase: 'before' | 'after', runId: string, signal: AbortSignal): Promise<Result<{ checkpointId: string; excluded: number }, { code: string }>> }`
    - `interface Compactor { summarize(view: readonly Message[], start: number, signal: AbortSignal): Promise<Result<{ summary: Message; tokensAfter: number }, { code: string }>> }`

Phases: `idle → streaming → (checkpointing) → executing → streaming … → finishing → finished`.
`draining` is the abort or failure path while tools settle. This task covers the no-tool paths
only:
- `start` appends the mode announcement + the user message, and emits `run_started`,
  `user_message` and `step_started`;
- `call_model` uses `modelView`, `toolChoice: 'auto'`, and `reasoningReplay` only after a
  recovery;
- `end_turn` → `finish`;
- `max_tokens` / `refusal` without calls → finish with that outcome;
- provider `error` → `provider_error`, applying the recoveries from Global Constraints;
- the budget check before each `call_model`;
- `context_near_limit` + `compact` when the estimate ≥ 80% of the input budget. The estimate
  is the last real input + utf-8 bytes/3 of the appended messages + 1_600 per image.

- [ ] **Step 1: Write the failing tests** (pure: feed inputs, assert commands and the final
  transcript):
  - text-only run;
  - `max_tokens`; `refusal`;
  - `provider error with partial text is appended and outcome provider_error`;
  - `context_length recovers once via compaction then surfaces`;
  - `invalid_request with replayed reasoning retries once per run with drop`;
  - steps budget;
  - `small-window model forces early compaction and warns` (limits 8_192/4_096);
  - `unpriced model with spend cap warns spend_cap_unpriced at start`.
- [ ] **Steps 2–5**, then commit `feat(agent): add the loop reducer for model-only steps`.

### Task 7: Reducer tool path, plus the driver

**Files:** Modify `src/loop/reducer.ts`; Create `src/loop/driver.ts`, `src/testing/{scripted-provider,scripted-tools}.ts`
(test-only helpers, not exported from `index.ts`); Tests `src/loop/driver.test.ts`.

**Interfaces:**
- Produces:
  - `runLoop(deps: LoopDeps, config: LoopConfig, start: Extract<LoopInput, { type: 'start' }>, signal: AbortSignal): Promise<RunResult>`
  - `interface LoopDeps { stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>; tools: ReadonlyMap<string, Tool<unknown, unknown>>; gate: DetailedPermissionGate; checkpoints: CheckpointPort; compactor: Compactor; emit(e: AgentEvent): void; clock: () => number; ids: { next(prefix: string): string }; timers: { setTimeout(fn: () => void, ms: number): () => void } }`
  - Test helpers:
    - `scriptedProvider(steps: readonly (readonly ModelEvent[])[])` returns
      `{ stream; requests: ModelRequest[]; pauseAt(step, index): Deferred }`;
    - `scriptedTool(name, risk, behavior)`, where behavior is one of: `deferred`, `throws`,
      `never`, `forgets-gate`, `checks-then-returns`.

Reducer additions:
- after the terminal event, run `planCalls`. Rejections get results immediately (no
  `tool_started`). If any `run` call is non-read and the run hasn't written yet, emit
  `checkpoint before` and await it.
- `run_batch` per batch. Settles are collected by `callId`, and the batch completes when every
  call has settled.
- results are truncated, placed in call order, and appended as one `tool` message
  (`tool_results` event).
- a `checkpoint_failed` result → every unexecuted call is `skipped` / `run_failed`, and the
  outcome is `checkpoint_failed`.
- `finish`: if the run wrote, emit `checkpoint after` first. `run_finished` is always the last
  event.

Driver: one FIFO queue. It runs the stream loop, pushing `model_event` inputs and then
`model_closed`. Each command starts its effect and pushes the result as an input. Every
`AbortController` is a child of the run signal, and the time budget fires `abort{time}`.

- [ ] **Step 1: Write the failing tests:**
  - single tool round trip;
  - `batches respect order barriers and results keep call order` (Review Focus 2; settle order
    driven by deferreds);
  - `checkpoint before is taken once before the first write of the run`;
  - `checkpoint failure blocks writes`;
  - `prefix never changes across steps` (`requests[i].messages` is a prefix of
    `requests[i+1].messages`; `tools` deep-equal);
  - `determinism`: the same script run twice gives deep-equal event lists and transcripts.
- [ ] **Steps 2–5**, then commit `feat(agent): execute tool batches and drive the loop`.

### Task 8: Abort matrix

**Files:** Modify `src/loop/reducer.ts` (the `draining` phase); Test `src/loop/abort.test.ts`.

Rules:
- on abort, emit `cancel_model` and/or `cancel_tools` + `start_grace_timer(graceMs)`;
- calls not started → `skipped` / `aborted`, with the result text
  `"not executed: run aborted"`;
- running calls that settle → their real result;
- after `grace_expired` → `interrupted`, with the result text
  `"aborted while running; effects unknown"`;
- a late `tool_settled` for a closed call is ignored;
- pending approvals end through the call signals (the gate denies `aborted`).

- [ ] **Step 1: Write one named test per abort point** (Review Focus 3): `before first event`,
  `mid text`, `mid reasoning`, `between tool_call events`, `during approval`, `during parallel
  batch`, `during sequential write`, `during checkpoint`, `during grace`, and
  `tool settles after grace`. Each asserts:
  - outcome `aborted`;
  - exactly one `tool_finished` per `tool_call`;
  - `checkTranscript` ok;
  - no `tool_started` after the abort input;
  - `run_finished` is last.
- [ ] **Steps 2–5**, then commit `feat(agent): make every abort point leave a consistent transcript`.

### Task 9: Resilience and gate violations

**Files:** Modify `src/loop/reducer.ts`; Test `src/loop/resilience.test.ts`.

Rules:
- `invalid_tool_calls` after `invalidStreakMax` consecutive steps in which every call was
  rejected as `invalid_json`, `invalid_input` or `unknown_tool`;
- `loop_detected` when `planCalls` returns `loopTool`. The offending call is rejected (never
  executed), and the run finishes after the results are appended;
- **gate violation:** a `returned` result with `isError: false` and zero `allow` decisions
  recorded for that `callId`, for any `Tool` (read included). Then:
  - the content is replaced by `"completed without a permission check; result withheld"`,
    `isError: true`, `ungated: true`;
  - the tool is added to `disabled`;
  - remaining calls are `skipped` / `run_failed`;
  - the outcome is `gate_violation`;
  - the audit happens through the driver's `audit` dep (add `audit: AuditSink` to `LoopDeps`).

- [ ] **Step 1: Write the failing tests** (Review Focus 5):
  - three malformed steps → `invalid_tool_calls`;
  - a `read → edit → read` sequence doesn't trip loop detection;
  - three identical pairs → `loop_detected`;
  - a `forgets-gate` read tool → `gate_violation`, the tool is disabled for the next run of the
    same session, and an audit entry is written;
  - `error result without allow is not a violation`.
- [ ] **Steps 2–5**, then commit `feat(agent): stop runs on loops, malformed calls and gate violations`.

### Task 10: Model-based property test

**Files:** Create `src/loop/loop.property.test.ts`.

- [ ] **Step 1: Write the generator.** Random scripts per step:
  - text, reasoning, and 0–4 calls (valid, invalid JSON, unknown, out-of-mode, zod-invalid);
  - read and write tools with random settle order;
  - random approver answers via a real `@autogeek/permissions` gate with an in-memory
    audit/rule store;
  - random terminal (`end_turn`, `tool_use`, `max_tokens`, `refusal`, every `ProviderError`
    kind);
  - an optional abort at a random input index;
  - random budgets.
- [ ] **Step 2: Assert, for ≥ 300 runs:**
  - the contract §4.2 invariants 1–5;
  - `checkTranscript` ok;
  - no tool ran in `ask`/`plan` with a non-read risk;
  - no tool ran after a deny for its only effect;
  - no `tool_started` after abort;
  - steps ≤ `maxSteps`;
  - determinism (re-run the same seed and compare deep-equal).
- [ ] **Step 3:** any failure is a reducer bug. Fix it in the owning task's module with a
  regression unit test. **Step 4: Commit**
  `test(agent): add model-based property tests for loop invariants`.

### Task 11: Session and runtime façade

**Files:** Create `src/session.ts`, `src/runtime/{runtime,ring-buffer}.ts`; Tests alongside;
Modify `src/index.ts` (public surface: `createAgentRuntime`, its types, `AgentSession` types;
no test helpers).

**Interfaces:**
- Produces:
  - `createAgentSession(a: { id: string; ownerId: string; systemPrompt: Message[]; tools: ReadonlyMap<string, Tool<unknown, unknown>> }): AgentSession`.
    It freezes the prefix and the `ToolSpec[]` (via `z.toJSONSchema`, with names checked
    against `/^[a-zA-Z0-9_-]{1,64}$/`), and holds `transcript` + `disabled`. There's at most
    one active run.
  - `createRingBuffer(limits: { maxEvents: number; maxBytes: number }): RingBuffer<AgentEventEnvelope>`
    with `push`, `since(seq): { kind: 'events'; events; more } | { kind: 'gap' }` (≤ 500 events
    and ≤ 8 MiB per call), and `bytes()`.
  - `createAgentRuntime(deps): AgentRuntime` with `send`, `stop`, `listRuns`, `replay` and
    `ownerGone`, using exactly the shapes of agent-contract §5 (internal forms; desktop applies
    `toWire*`).
    - Ring buffer: 5_000 events / 4 MiB per run; 10 runs and 32 MiB per owner, evicting the
      oldest first.
    - `listRuns` entries carry `firstSeq`, `lastSeq` and `undone` (contract §11). `undone` stays
      `false` until the checkpoints slice adds `undoRun`, which sets it.
    - Budgets per run come from the injected `budgetsFor(): RunBudgets` (desktop reads the
      `agent.budgets` setting). The runtime still validates them against the contract schema
      and refuses to start on invalid budgets (typed error).
    - `send` during an active run → `conflict { kind: 'run_active' }`.
    - A foreign owner's ids → `not_found`.

- [ ] **Step 1: Write the failing tests:**
  - owner isolation;
  - `ownerGone aborts runs and denies pending approvals` (with a real gate + `ApprovalBroker`);
  - replay paging and `gap`;
  - the per-owner byte cap evicts the oldest run;
  - `stop` is idempotent;
  - `listRuns reports firstSeq after eviction`;
  - `budgetsFor is read at each run start` (change between runs → the second run uses the new
    value);
  - `send` while active → conflict;
  - a session's tool list is identical across runs in different modes.
- [ ] **Steps 2–5**, then commit `feat(agent): add sessions and the agent runtime façade`.
  Request a review of Tasks 6–11. Tasks 1–5 go to review earlier, as their own slice.
