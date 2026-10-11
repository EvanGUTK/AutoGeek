import { ModelInfoSchema, ModelRequestSchema, ok, providerError } from '@autogeek/core';
import type {
  ModelEvent,
  ModelInfo,
  ModelProvider,
  ModelRequest,
  ProviderError,
  ProviderErrorKind,
  Result,
} from '@autogeek/core';
import { z } from 'zod';
import { checkCredential, endpoint } from '../../credential.ts';
import type { CredentialKind, ProviderCredential } from '../../credential.ts';
import { isInsecureRemote } from '../../http/loopback.ts';
import type { RetryPolicy } from '../../http/retry.ts';
import type { HttpRequest, TransportDeps, TransportTimeouts } from '../../http/transport.ts';
import { guardStream } from '../../stream/guard.ts';
import { createEventWriter } from '../../stream/writer.ts';
import { parseJsonOrUndefined, requestJson } from '../http-json.ts';
import { runSseStream } from '../sse-driver.ts';
import { buildChatBody } from './request.ts';
import type { ReasoningDialect } from './request.ts';
import { createChatStream, errorKind } from './stream.ts';

/** Context handed to a provider-specific model listing. */
export interface ListingContext {
  readonly base: URL;
  readonly credential: ProviderCredential;
  readonly signal: AbortSignal;
  /** A GET request to `url` with this provider's auth headers. */
  readonly get: <S extends z.ZodType>(
    url: string,
    schema: S,
  ) => Promise<Result<z.infer<S>, ProviderError>>;
}

export interface ChatProviderSpec {
  readonly providerId: string;
  /** Stored credential kinds accepted (the catalog's `credentialKinds`). */
  readonly kinds: readonly CredentialKind[];
  /** Fixed-endpoint providers only. */
  readonly fixedOrigin?: string;
  readonly reasoning: ReasoningDialect;
  readonly replayReasoningDetails: boolean;
  /** Non-secret headers every request carries (e.g. OpenRouter app attribution). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly listModels: (context: ListingContext) => Promise<Result<ModelInfo[], ProviderError>>;
}

export interface ChatProviderOptions {
  readonly timeouts?: TransportTimeouts;
  readonly retry?: RetryPolicy;
}

/**
 * One OpenAI Chat Completions adapter for every compatible server (D-008). The base URL comes only
 * from the credential and, by the OpenAI SDK convention, includes the API prefix (e.g.
 * `http://127.0.0.1:1234/v1`); fixed paths are appended. Plain http to a non-loopback host is
 * allowed (the user confirmed it when setting the URL) but logged as a warning on every request.
 */
export function createChatCompletionsProvider(
  spec: ChatProviderSpec,
  deps: TransportDeps,
  options: ChatProviderOptions = {},
): ModelProvider<ProviderCredential> {
  const { providerId } = spec;
  const requirements = {
    providerId,
    kinds: spec.kinds,
    ...(spec.fixedOrigin === undefined ? {} : { fixedOrigin: spec.fixedOrigin }),
  };
  const transportOptions = {
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  };

  /** Auth and attribution headers; the key is revealed inline and never stored. */
  function headers(credential: ProviderCredential): Record<string, string> {
    return {
      ...spec.headers,
      ...(credential.kind === 'none' ? {} : { authorization: `Bearer ${credential.reveal()}` }),
    };
  }

  function secrets(credential: ProviderCredential): () => readonly string[] {
    return () => (credential.kind === 'none' ? [] : [credential.reveal()]);
  }

  function http(credential: ProviderCredential, url: string, signal: AbortSignal): HttpRequest {
    return {
      providerId,
      url,
      headers: headers(credential),
      signal,
      secrets: secrets(credential),
      classify: classifyChatError,
      ...transportOptions,
    };
  }

  function warnIfInsecure(base: URL): void {
    if (isInsecureRemote(base)) {
      deps.logger.warn('plaintext http to a non-loopback provider endpoint', {
        providerId,
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
      yield* writer.fail(providerError('invalid_request', providerId));
      return;
    }
    const base = checkCredential(credential, requirements);
    if (!base.ok) {
      yield* writer.fail(base.error);
      return;
    }
    warnIfInsecure(base.value);
    const body = buildChatBody(request, {
      providerId,
      reasoning: spec.reasoning,
      replayReasoningDetails: spec.replayReasoningDetails,
    });
    const target = http(credential, endpoint(base.value, 'chat/completions'), signal);
    yield* runSseStream(
      {
        ...target,
        headers: {
          ...target.headers,
          accept: 'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      deps,
      writer,
      createChatStream({
        writer,
        providerId,
        model: request.model,
        logger: deps.logger,
        secrets: secrets(credential),
      }),
    );
  }

  return {
    id: providerId,
    stream(request, credential, signal) {
      return guardStream(run(request, credential, signal), { providerId, logger: deps.logger });
    },
    async listModels(credential, signal) {
      const base = checkCredential(credential, requirements);
      if (!base.ok) return base;
      warnIfInsecure(base.value);
      return spec.listModels({
        base: base.value,
        credential,
        signal,
        get: (url, schema) => requestJson(http(credential, url, signal), deps, schema),
      });
    },
  };
}

const ErrorBodySchema = z.looseObject({
  error: z.union([
    z.looseObject({
      code: z.union([z.number(), z.string()]).nullish(),
      type: z.string().nullish(),
      metadata: z.looseObject({ error_type: z.string().nullish() }).nullish(),
    }),
    z.string(),
  ]),
});

/** Refines the status mapping from OpenAI-style, OpenRouter and llama.cpp error bodies. */
export function classifyChatError(status: number, body: string): ProviderErrorKind | undefined {
  const parsed = ErrorBodySchema.safeParse(parseJsonOrUndefined(body));
  if (!parsed.success || typeof parsed.data.error === 'string') return undefined;
  const { code, type, metadata } = parsed.data.error;
  const kind = errorKind(
    typeof code === 'string' ? code : status,
    metadata?.error_type ?? type ?? undefined,
  );
  return kind === 'unknown' ? undefined : kind;
}

/** `GET {base}/models`: ids only, the shape every compatible server returns. */
export const OpenAIModelListSchema = z.looseObject({
  data: z.array(z.looseObject({ id: z.string().min(1) })),
});

/** A model the server lists but describes nowhere: limits unknown, effectiveLimits applies. */
export function unknownModel(
  providerId: string,
  id: string,
  overrides: Partial<ModelInfo> = {},
): ModelInfo[] {
  const info: ModelInfo = {
    providerId,
    id,
    displayName: id,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: {
      tools: 'unknown',
      vision: 'unknown',
      reasoning: 'unknown',
      promptCaching: 'unknown',
    },
    source: 'api',
    ...overrides,
  };
  return ModelInfoSchema.safeParse(info).success ? [info] : [];
}

/** Lists `GET {base}/models` with no metadata; used by servers without a richer endpoint. */
export async function listIdsOnly(
  providerId: string,
  context: ListingContext,
): Promise<Result<ModelInfo[], ProviderError>> {
  const listed = await context.get(endpoint(context.base, 'models'), OpenAIModelListSchema);
  if (!listed.ok) return listed;
  return ok(listed.value.data.flatMap((entry) => unknownModel(providerId, entry.id)));
}
