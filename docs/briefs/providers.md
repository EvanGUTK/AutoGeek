# Brief: ag-providers (opus-5-5 / high) — `@autogeek/providers` (M2)

You turn every vendor API into the single normalized `ModelProvider` contract from
`@autogeek/core`. The agent loop must never see a vendor type.

## Deliver (atomic commits, one provider per slice)
1. **Shared streaming core:** SSE/NDJSON parsers (spec-correct: multi-line data, comments, CRLF,
   chunk boundaries splitting events), `fetch` with `AbortSignal`, timeout, bounded retry with
   jitter on 429/5xx/network (honor `Retry-After`; never retry after bytes of a tool call were
   emitted), redacted request logging, response validation with zod.
2. **Anthropic Messages API** adapter: text, extended thinking/reasoning blocks (preserve
   signatures round-trip), tool use with partial-JSON input streaming assembled safely, prompt
   caching markers, images, usage incl. cache tokens, stop reasons incl. `refusal`.
3. **OpenAI** adapter (current recommended API surface — read the installed docs/types, do not
   rely on memory): text, reasoning, function calls, usage.
4. **Google Gemini** adapter; 5. **OpenRouter**; 6. **OpenAI-compatible/local** (Ollama, LM Studio,
   llama.cpp server) with a configurable base URL (validate; warn on non-loopback http).
7. **Model catalog:** `listModels` per provider + a capability table (context window, tool use,
   vision, reasoning, pricing when known) with a safe "unknown model" path (conservative defaults).
8. **Conformance suite:** one shared test suite every adapter must pass against recorded fixtures
   AND a scripted fake server: text stream, tool call, parallel tool calls, malformed JSON in tool
   args, mid-stream disconnect, abort mid-stream (no dangling sockets), 401/429/500 mapping to the
   core `ProviderError` taxonomy.

## Rules
Credentials arrive only as `ResolvedCredential` from `@autogeek/auth` interfaces (inject; do not
import auth internals). Never log request bodies containing user code at info level. Unknown
vendor fields must not crash the stream. Real-API smoke tests are opt-in via env and skipped
by default **with an explicit reason string, never silently**.

## Acceptance
Conformance suite green for all adapters; `pnpm verify` green per commit; ag-reviewer APPROVE.
