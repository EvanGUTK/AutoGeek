# Model contract (authoritative)

Status: **accepted by the chief, 2026-10-11** (author: ag-providers). This file is the source of
truth for the model seam in `@autogeek/core`; it supersedes the model-related snippets in
`ARCHITECTURE.md` §5 and amends D-004. Chief rulings on the open items:
(a) `text_done` approved. (b) `JsonObject` tool input, shared `ToolOutput` approved; `ToolResult.content`
in ARCHITECTURE.md §5 MUST use the same type. (c) no `temperature`/`top_p`, `toolChoice` auto|none
approved; add the vendor doc reference for the 400 behavior in a code comment, and revisit behind a
capability flag if needed. (d) `listModels` returns `Result`; `stream()` never throws, approved.
Unchanged additions: `credential_mismatch` kind, `reasoningTokens` in usage.

---

These are the concrete `@autogeek/core` shapes for the model seam. They apply your rulings on (1)–(5).
Vendor-specific mapping notes are flagged where my wire-format research is still running; none of
them change the core shapes.

## 1. ContentPart and Message

```ts
// Opaque per-adapter data. Only the adapter whose providerId matches `origin.providerId` may read
// `data`. Every other component treats it as an opaque blob that it stores and replays. ORIGIN
// MATCHING IS ADAPTER-DEFINED: each adapter documents whether it matches on provider or on
// provider+model, per its vendor's replay rules (e.g. Anthropic keeps every Anthropic-origin block
// across a Claude→Claude model switch because the API itself ignores unreadable ones, and removing
// blocks from the middle of history would be an edit; Gemini/OpenAI may match provider+model).
// Parts whose origin the adapter rejects are dropped (for reasoning, the whole part), and the
// choice must never turn into a mid-history edit that the vendor treats as invalidating.
// The JSON must be serializable because checkpoints persist it.
const ProviderMetadata = z.object({
  origin: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }),
  data: z.json(),                       // zod 4 JSON value; never `unknown` to avoid non-serializable blobs
});

type ContentPart =
  | { type: 'text'; text: string; providerMetadata?: ProviderMetadata }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; dataBase64: string }
  | { type: 'tool_call'; id: string; name: string; input: JsonObject; providerMetadata?: ProviderMetadata }
  | { type: 'tool_result'; callId: string; output: ToolOutput; isError: boolean }
  | { type: 'reasoning'; text: string; providerMetadata?: ProviderMetadata };

type ToolOutput = string | Array<{ type: 'text'; text: string } | { type: 'image'; mediaType: ...; dataBase64: string }>;

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ContentPart[];
  cacheHint?: 'ephemeral';
}
```

**Decision: fold `signature` / `redactedData` into `providerMetadata`.** The case for it:
- There is one mechanism instead of three. Anthropic thinking signatures, Anthropic redacted thinking,
  OpenAI encrypted reasoning items (`id` + `encrypted_content`), and Gemini `thoughtSignature` (which
  sits on functionCall/text parts, not on a reasoning block) all become `providerMetadata` on the part
  they belong to. Core then has no vendor-shaped fields.
- Without an origin, a signature is unsafe to replay. Anthropic thinking blocks are bound to the
  model, and the other vendors reject or ignore foreign blobs. Keeping the signature inside the
  origin-tagged object makes "drop on model switch" one rule in one place.
- Redacted reasoning is a `reasoning` part with `text: ''` plus metadata. The UI shows "reasoning
  hidden" when text is empty. That also covers OpenAI reasoning without a summary and Anthropic
  `display: "omitted"`, so no vendor-specific `redacted` flag is needed.

Other changes, with reasons:
- `tool_call.input` is narrowed to `JsonObject`. Every vendor requires an object, and your ruling
  replays invalid calls as `{}`. `unknown` would let a non-object slip through to replay.
- `tool_result.output` is narrowed to string or a text/image block array. Vendors accept exactly
  this, and it keeps `unknown` out of the seam. The agent decides how to stringify structured tool
  output.
- Image `mediaType` becomes an enum of the four types all vendors accept.

**System and tool roles** (adapter behavior, documented in core JSDoc):
- The leading run of `system` messages forms the system prompt. A `system` message after the first
  non-system message is a mid-conversation operator instruction. It maps to Anthropic in-`messages`
  system (on supporting models), an OpenAI `developer` message, or, for Gemini and the generic
  OpenAI-compatible adapter, a user turn wrapped in a fixed `<system-instruction>` envelope (lossy;
  documented).
- `tool` messages contain only `tool_result` parts. Adapters map them to the vendor form (Anthropic
  user turn, OpenAI `function_call_output` items, Gemini `functionResponse` parts).

## 2. ModelRequest

```ts
interface ToolSpec {
  name: string;                         // /^[a-zA-Z0-9_-]{1,64}$/ (strictest common vendor rule)
  description: string;
  inputSchema: JsonObject;              // JSON Schema (draft 2020-12 subset); the agent produces it via z.toJSONSchema
}

interface ModelRequest {
  model: string;                        // vendor model id
  messages: Message[];                  // ≥1 non-system message
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none';         // no forced tool use: current Anthropic models 400 on it
  maxOutputTokens: number;              // required; the agent picks from ModelInfo
  reasoning?: {
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';   // adapter maps to nearest supported level
    visibility?: 'summary' | 'hidden';  // default 'summary' (Anthropic display, OpenAI summary, Gemini includeThoughts)
  };
  stopSequences?: string[];
  // 'preserve' (default): adapters replay reasoning parts byte-exact (dropping foreign-origin ones).
  // 'drop': recovery path — adapters omit reasoning parts from replayed history, except where the
  // vendor requires the current in-progress tool-use turn's reasoning (adapter's responsibility).
  // The loop sets 'drop' only to recover from an `invalid_request` caused by edited history.
  reasoningReplay?: 'preserve' | 'drop';
}
```

**History is append-only (loop invariant).** Preserved/signed reasoning is valid only if the
prefix before it (system, tools, earlier messages) is unchanged. Editing or compacting earlier
turns, or changing the system prompt/tool list mid-conversation, can make a vendor return 400 or
silently discard reasoning. Therefore: never rewrite earlier messages in place; deliver
mid-conversation operator instructions as appended `system` messages; compaction starts a new
prefix and must drop reasoning parts (those with `providerMetadata`) from the summarized region;
checkpoint restore may truncate (a prefix) but must not edit-then-continue. Source: ag-providers'
wire research of the Anthropic docs (preserved thinking; date-gated 400 vs. silent loss) — cite the
exact doc URLs in the adapter and re-verify when models change.

Left out on purpose: `temperature`/`top_p`. Current Anthropic models reject them with a 400, and
reasoning models elsewhere ignore or reject them. If we need them later, they get added
behind a capability flag.

## 3. ModelEvent (amends D-004)

```ts
type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'text_done'; providerMetadata?: ProviderMetadata }     // NEW, see below
  | { type: 'reasoning_delta'; text: string }
  | { type: 'reasoning_done'; text: string; providerMetadata?: ProviderMetadata }
  | { type: 'tool_call'; id: string; name: string; input: JsonObject; providerMetadata?: ProviderMetadata }
  | { type: 'tool_call_invalid'; id: string; name: string; rawInput: string; reason: 'invalid_json' | 'not_an_object' | 'truncated' }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' }
  | { type: 'error'; error: ProviderError };
```

**New: `text_done`.** Gemini attaches `thoughtSignature` to text parts, and OpenAI message items
carry ids, so a text part needs a close event that can carry metadata. It also makes part
boundaries explicit, which the loop needs to rebuild the assistant message in vendor order.

**Ordering rules** (the conformance suite enforces all of these):
1. Parts are sequential, never interleaved. A text part is `text_delta`* then exactly one
   `text_done`. A reasoning part is `reasoning_delta`* then exactly one `reasoning_done`. A tool
   call is exactly one `tool_call` or `tool_call_invalid`. The loop appends parts in event order,
   and that order is the replay order.
2. Parallel tool calls are separate consecutive `tool_call` events. Their ids are unique within a
   response.
3a. **Usage normalization.** `inputTokens` is UNCACHED input only: it excludes `cacheReadTokens` and
   `cacheWriteTokens`, so the three plus `outputTokens` sum without double counting. Vendors differ
   (some report cached tokens as a subset of their input count), so each adapter normalizes by
   subtracting and the conformance suite asserts it with a fixture per vendor. `reasoningTokens` is
   informational and must not be added to `outputTokens` unless the vendor excludes it from that count.
3. `usage` appears at most once, immediately before the terminal event, as the final cumulative
   count. It is also emitted before an `error` terminal when the vendor reported usage, because a
   failed stream can still be billed. Local servers that report nothing omit it.
4. Exactly one terminal event (`done` | `error`), and nothing after it. An abort produces `error`
   with kind `aborted`.
5. `stopReason: 'tool_use'` iff at least one `tool_call` or `tool_call_invalid` was emitted and the
   vendor stopped to call tools. `refusal` covers Anthropic `refusal`, OpenAI refusal content,
   Gemini SAFETY/PROHIBITED_CONTENT/blocked prompt, and similar (vendor detail stays in logs).
   Anthropic `pause_turn` is handled inside the adapter: it is surfaced as `end_turn` only when no
   continuation is possible. Its exact handling is pending research and doesn't affect the shape.
6. `tool_call_invalid.rawInput` is truncated to 4 KiB. `reason: 'truncated'` means the stream hit
   max_tokens mid-input, in which case the stopReason is `max_tokens`.

## 4. ProviderError

```ts
const ProviderErrorKind = z.enum([
  'auth',            // 401, bad/expired key or token
  'permission',      // 403, key valid but model/region/feature not allowed
  'not_found',       // 404, unknown model or endpoint
  'invalid_request', // 400/413/422, a request we built that the vendor rejected
  'context_length',  // input exceeds the model's window (vendor-specific detection)
  'rate_limit',      // 429, transient
  'quota',           // out of credits / insufficient_quota / 402, needs user action
  'overloaded',      // 529 / 503 overloaded
  'server',          // other 5xx
  'network',         // DNS/TCP/TLS/reset before or during the stream
  'timeout',         // first-byte or idle timeout
  'aborted',         // caller's signal
  'invalid_response',// unparseable stream / schema violation / stream ended without a terminal vendor event
  'credential_mismatch', // credential.providerId !== provider id (no I/O performed)
  'unknown',
]);

interface ProviderError {
  kind: ProviderErrorKind;
  message: string;          // CONSTANT per kind (a table in core); never interpolated vendor text
  retryable: boolean;       // safe for the caller to retry the whole request later (the adapter already retried internally)
  providerId: string;
  status?: number;
  requestId?: string;       // vendor request id header, for support
  retryAfterMs?: number;
  detail?: string;          // redacted, ≤2 KiB vendor body/excerpt; logs/UI only, NEVER sent to the model
}
```

`retryable` per kind: rate_limit, overloaded, server, network, timeout → true; everything else →
false.

## 5. ModelInfo

```ts
type Support = 'yes' | 'no' | 'unknown';
interface ModelInfo {
  providerId: string;
  id: string;
  displayName: string;
  contextWindow: number | null;      // null = unknown
  maxOutputTokens: number | null;
  capabilities: { tools: Support; vision: Support; reasoning: Support; promptCaching: Support };
  pricing?: {                        // USD per 1M tokens; absent = unknown (spend caps then warn, not compute)
    input: number; output: number; cacheRead?: number; cacheWrite?: number;
  };
  source: 'api' | 'catalog' | 'default';  // where the data came from (the UI can show "estimated")
}
```

`@autogeek/providers` will also export `effectiveLimits(info)`, giving conservative numbers for
unknowns: context 8_192 and max output 4_096. That keeps the loop and compaction safe on unknown
local models.

## 6. ModelProvider (unchanged signature)

`stream()` never throws and never rejects. Every failure, including a `credential_mismatch` or an
invalid request detected locally, becomes the single terminal `error` event. `listModels()` returns
`Promise<Result<ModelInfo[], ProviderError>>` instead of throwing, which matches the "typed Results
for expected failures" rule. **This is a signature change from §5. Please confirm it.**
