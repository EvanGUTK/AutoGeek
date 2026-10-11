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

## D-008 Vendor API surfaces per adapter
- **Status:** accepted (chief, 2026-10-11; proposed by ag-providers)
- **Context:** Most vendors expose several API generations, and they differ in what can be replayed
  statelessly, how usage is counted and where context limits come from.
- **Decision:**
  - **Anthropic:** Messages API with SSE. Reasoning origin matching is on the provider only: every
    Claude thinking block is replayed. Preserved-thinking enforcement is account- and date-gated,
    so history stays append-only either way.
  - **OpenAI:** Responses API, stateless (`store: false` plus
    `include: ["reasoning.encrypted_content"]`). Output items are replayed unmodified, and reasoning
    only to the model that produced it. Whether another model accepts foreign encrypted items is
    INFERRED and covered by an opt-in smoke test.
  - **Gemini:** v1beta `streamGenerateContent?alt=sse`; the Interactions API is explicitly
    deferred. The dummy `thoughtSignature` value `skip_thought_signature_validator` is a documented
    workaround: the Google doc URL is cited in code, a conformance test covers it, and it is
    re-verified when the API changes.
  - **OpenRouter, LM Studio, llama.cpp and `openai_compatible`:** one shared, tolerant Chat
    Completions parser.
  - **Ollama:** native `/api/chat` NDJSON with `num_ctx` set from `/api/show`. `/v1` cannot set
    `num_ctx`, and `effectiveLimits` must use the real context.
  - **Usage normalization:** `inputTokens` is uncached input only.
    - Anthropic maps 1:1.
    - OpenAI and the Chat Completions family subtract cached tokens but NOT cache writes, until a
      smoke test shows writes are a subset.
    - Gemini subtracts `cachedContentTokenCount` and adds thoughts to output. A non-zero
      `toolUsePromptTokenCount` is ignored with a warning.
    - Ollama subtracts `prompt_eval_cached_count`.
    - Where semantics are unverified, err toward over-counting.
- **Consequences:**
  - Five wire formats to own, behind one conformance suite.
  - Opt-in smoke tests check the INFERRED claims with the user's own keys.

## D-010 Renderer trust model: harden now, isolate before agent mode ships
- **Status:** accepted (chief, 2026-10-11; raised by ag-reviewer in the ag-ui docs review)
- **Context:** One renderer both displays untrusted model output and holds privileged capabilities
  (`terminal.*`, `workspace.setTrust`, `permissions.respondApproval`/`addRule`, `auth.*`). A single
  XSS in rendered markdown would give arbitrary execution and let the attacker approve their own
  requests, so the permission gate is only as strong as the renderer. An integrated terminal is
  arbitrary execution by design, so gating it is not the answer; isolating untrusted content is.
- **Decision (now, M0–M2):**
  1. Main shows a **native confirmation built from main's own data** for `workspace.setTrust(true)`
     and for `permissions.addRule` with effect `allow` (error `user_declined` on refusal).
  2. Renderer hardening invariants: strict CSP (no inline script, no `eval`), exactly one sanitizing
     markdown component backed by an XSS-corpus test suite, no `dangerouslySetInnerHTML` elsewhere,
     external links only through a main-mediated allowlist.
  3. The IPC channel format supports a per-channel **sender allowlist** (`allowedSenders`, default
     the primary app view) from day one, so a renderer split is a configuration change later.
  4. `ARCHITECTURE.md` §8 and `docs/SECURITY.md` state the residual risk honestly: "the renderer
     is untrusted" holds only while sanitization holds, until step 5 lands.
- **Decision (design gate before M3):** ag-foundation and ag-ui deliver a proposal to isolate
  untrusted-content rendering from privileged capabilities. Candidates: (a) separate `webContents`/
  `WebContentsView`s by role (transcript view without `terminal.*`, `auth.*`, `permissions.*`,
  `setTrust`; approvals in a small privileged view that renders structured data as inert text) or
  (b) rendering model content in an opaque-origin sandboxed frame with a hash-pinned bootstrap.
  The chief decides. **Agent mode does not ship until the chosen isolation is implemented or the
  user explicitly accepts the residual risk.**
- **Consequences:** a small cost now (two native dialogs, one IPC-format field); a real architecture
  task before M3, tracked here.

## D-011 Exec-grant soundness: grants do not pin what a command runs
- **Status:** accepted (chief, 2026-10-11; raised by ag-workspace and ag-reviewer, designed with ag-agent)
- **Decision:** exec/exec_shell session grants are cleared on writes to exec-vector files, on mutating
  execs, on work-tree-mutating tools, and on tap change/degradation, with a bounded flush before use;
  persistent exact rules are not suspended (documented residual). Full text: agent-contract §12.1–12.2.
- **Consequences:** a few extra prompts after installs and branch switches; one residual class in SECURITY.md.

## D-012 Trust and root-scoped rules bind to folder identity
- **Status:** accepted (chief, 2026-10-11; raised by ag-reviewer)
- **Decision:** rootKey = realpath + opaque identity token; a mismatch opens untrusted and quarantines the
  root's rules until natively reconfirmed; restore at launch never auto-opens a changed root. See
  agent-contract §12.3.
- **Consequences:** re-trust after a re-clone or remount (fail closed); identity probing is per-filesystem
  and documented by ag-workspace.

## D-013 Tiered (long-context) pricing deferred
- **Status:** accepted (chief, 2026-10-11; proposed by ag-providers)
- **Context:** Some vendors charge more above a prompt-size threshold:
  - OpenAI GPT-6.x and GPT-5.4 to 5.6: about 2x input and 1.5x output above 272K input tokens.
  - Gemini 3.1 Pro and 2.5 Pro: about 2x above 200K.

  `ModelInfo.pricing` has one price per field.
- **Decision:** the catalog lists the HIGHER tier for these models, so spend caps over-count and
  never under-count.
  - Each entry carries its source URL, the date it was verified, and a comment giving the base
    tier and the possible over-estimate.
  - Priced listings are marked `source: 'catalog'`, so the UI labels costs as conservative
    estimates.
- **Alternative (not taken now):** add
  `pricing.longContext?: { thresholdTokens, input, output, cacheRead?, cacheWrite? }` to the core
  contract, and have the cost function pick the tier per request.
- **Revisit when:** users report that short-prompt spend estimates trip caps early, or at M2 polish,
  whichever comes first.
- **Consequences:** costs of short prompts on tiered models can be over-estimated by up to 2x.
