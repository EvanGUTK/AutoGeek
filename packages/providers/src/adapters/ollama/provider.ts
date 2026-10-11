import { ModelInfoSchema, ModelRequestSchema, ok, providerError } from '@autogeek/core';
import type {
  ModelEvent,
  ModelInfo,
  ModelProvider,
  ModelRequest,
  ProviderErrorKind,
} from '@autogeek/core';
import { z } from 'zod';
import { checkCredential, endpoint } from '../../credential.ts';
import type { ProviderCredential } from '../../credential.ts';
import { isInsecureRemote } from '../../http/loopback.ts';
import type { RetryPolicy } from '../../http/retry.ts';
import type { HttpRequest, TransportDeps, TransportTimeouts } from '../../http/transport.ts';
import { guardStream } from '../../stream/guard.ts';
import { createEventWriter } from '../../stream/writer.ts';
import { parseJsonOrUndefined, requestJson } from '../http-json.ts';
import { runNdjsonStream } from '../ndjson-driver.ts';
import { OLLAMA_PROVIDER_ID, buildOllamaBody } from './request.ts';
import type { OllamaModelFacts } from './request.ts';
import { createOllamaStream } from './stream.ts';

export interface OllamaProviderOptions {
  readonly timeouts?: TransportTimeouts;
  readonly retry?: RetryPolicy;
  /**
   * Upper bound for `num_ctx`. A model's trained context can be far larger than local memory
   * allows; Ollama's docs recommend at least 64000 for agents. Default 65536.
   */
  readonly maxContextTokens?: number;
}

const DEFAULT_MAX_CONTEXT = 65_536;
const FATAL_SHOW_ERRORS = new Set<ProviderErrorKind>([
  'not_found',
  'aborted',
  'network',
  'timeout',
  'auth',
  'permission',
]);
const MAX_LISTED_MODELS = 200;

const ShowSchema = z.looseObject({
  capabilities: z.array(z.string()).optional(),
  model_info: z.record(z.string(), z.unknown()).optional(),
  thinking: z.looseObject({ values: z.array(z.unknown()).optional() }).optional(),
});
type Show = z.infer<typeof ShowSchema>;

/** The trained context: `model_info["<general.architecture>.context_length"]`. */
function trainedContext(show: Show): number | undefined {
  const info = show.model_info ?? {};
  const architecture = info['general.architecture'];
  if (typeof architecture !== 'string') return undefined;
  const value = info[`${architecture}.context_length`];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function thinkingKind(show: Show): OllamaModelFacts['thinking'] {
  if (show.capabilities?.includes('thinking') !== true) return 'none';
  return show.thinking?.values?.some((value) => typeof value === 'string') === true
    ? 'levels'
    : 'boolean';
}

/**
 * Ollama native API (D-008): `POST /api/chat` (NDJSON) with `options.num_ctx` set from
 * `POST /api/show`, because the OpenAI-compatible `/v1` cannot set the context and Ollama's
 * default silently truncates long prompts. The context we run with (trained context capped by
 * `maxContextTokens`) is what `listModels` reports, so effectiveLimits uses the real number.
 * The base URL is the server root (default http://127.0.0.1:11434). Keyless only.
 */
export function createOllamaProvider(
  deps: TransportDeps,
  options: OllamaProviderOptions = {},
): ModelProvider<ProviderCredential> {
  const maxContext = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT;
  const requirements = { providerId: OLLAMA_PROVIDER_ID, kinds: ['none'] } as const;
  const transportOptions = {
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  };
  // Per base URL and model; models rarely change under a running server.
  const facts = new Map<string, OllamaModelFacts & { readonly show: Show }>();

  function http(url: string, signal: AbortSignal, body?: string): HttpRequest {
    return {
      providerId: OLLAMA_PROVIDER_ID,
      url,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      signal,
      classify: classifyOllamaError,
      ...(body === undefined ? {} : { body }),
      ...transportOptions,
    };
  }

  async function show(base: URL, model: string, signal: AbortSignal) {
    const key = `${base.href} ${model}`;
    const cached = facts.get(key);
    if (cached !== undefined) return ok(cached);
    const shown = await requestJson(
      http(endpoint(base, 'api/show'), signal, JSON.stringify({ model })),
      deps,
      ShowSchema,
    );
    if (!shown.ok) return shown;
    const trained = trainedContext(shown.value);
    const entry = {
      show: shown.value,
      thinking: thinkingKind(shown.value),
      ...(trained === undefined ? {} : { numCtx: Math.min(trained, maxContext) }),
    };
    facts.set(key, entry);
    return ok(entry);
  }

  function warnIfInsecure(base: URL): void {
    if (isInsecureRemote(base)) {
      deps.logger.warn('plaintext http to a non-loopback provider endpoint', {
        providerId: OLLAMA_PROVIDER_ID,
        target: base.origin,
      });
    }
  }

  async function* run(
    request: ModelRequest,
    credential: ProviderCredential,
    signal: AbortSignal,
  ): AsyncGenerator<ModelEvent, void, undefined> {
    const writer = createEventWriter();
    if (!ModelRequestSchema.safeParse(request).success) {
      yield* writer.fail(providerError('invalid_request', OLLAMA_PROVIDER_ID));
      return;
    }
    const base = checkCredential(credential, requirements);
    if (!base.ok) {
      yield* writer.fail(base.error);
      return;
    }
    warnIfInsecure(base.value);
    const shown = await show(base.value, request.model, signal);
    if (!shown.ok) {
      // An unknown model, an unreachable server or a cancellation ends the turn; a metadata
      // endpoint that misbehaves otherwise still lets the chat run with server defaults.
      if (FATAL_SHOW_ERRORS.has(shown.error.kind)) {
        yield* writer.fail(shown.error);
        return;
      }
      deps.logger.warn('Ollama /api/show failed; using server defaults', {
        providerId: OLLAMA_PROVIDER_ID,
        kind: shown.error.kind,
      });
    }
    const body = buildOllamaBody(request, shown.ok ? shown.value : undefined);
    yield* runNdjsonStream(
      { ...http(endpoint(base.value, 'api/chat'), signal, JSON.stringify(body)) },
      deps,
      writer,
      createOllamaStream({ writer, model: request.model, logger: deps.logger }),
    );
  }

  return {
    id: OLLAMA_PROVIDER_ID,
    stream(request, credential, signal) {
      return guardStream(run(request, credential, signal), {
        providerId: OLLAMA_PROVIDER_ID,
        logger: deps.logger,
      });
    },
    async listModels(credential, signal) {
      const base = checkCredential(credential, requirements);
      if (!base.ok) return base;
      warnIfInsecure(base.value);
      const tags = await requestJson(
        http(endpoint(base.value, 'api/tags'), signal),
        deps,
        TagsSchema,
      );
      if (!tags.ok) return tags;
      const models: ModelInfo[] = [];
      for (const tag of tags.value.models.slice(0, MAX_LISTED_MODELS)) {
        const shown = await show(base.value, tag.name, signal);
        if (!shown.ok && shown.error.kind === 'aborted') return shown;
        models.push(...toModelInfo(tag.name, shown.ok ? shown.value : undefined));
      }
      return ok(models);
    },
  };
}

const TagsSchema = z.looseObject({ models: z.array(z.looseObject({ name: z.string().min(1) })) });

function toModelInfo(
  name: string,
  known: (OllamaModelFacts & { show: Show }) | undefined,
): ModelInfo[] {
  const capabilities = known?.show.capabilities;
  if (capabilities !== undefined && !capabilities.includes('completion')) return []; // embedding-only
  const has = (capability: string) =>
    capabilities === undefined ? 'unknown' : capabilities.includes(capability) ? 'yes' : 'no';
  const info: ModelInfo = {
    providerId: OLLAMA_PROVIDER_ID,
    id: name,
    displayName: name,
    contextWindow: known?.numCtx ?? null,
    maxOutputTokens: null,
    capabilities: {
      tools: has('tools'),
      vision: has('vision'),
      reasoning: has('thinking'),
      promptCaching: 'yes',
    },
    source: 'api',
  };
  return ModelInfoSchema.safeParse(info).success ? [info] : [];
}

const ErrorBodySchema = z.looseObject({ error: z.string() });

/** Ollama errors are `{"error": "<message>"}`; an unknown model is a 404 with "not found". */
export function classifyOllamaError(status: number, body: string): ProviderErrorKind | undefined {
  const parsed = ErrorBodySchema.safeParse(parseJsonOrUndefined(body));
  if (!parsed.success) return undefined;
  if (/not found/i.test(parsed.data.error) && (status === 404 || status === 400))
    return 'not_found';
  if (/context|too long/i.test(parsed.data.error) && status === 400) return 'context_length';
  return undefined;
}
