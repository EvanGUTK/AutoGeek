import { ModelInfoSchema, ModelRequestSchema, ok, providerError } from '@autogeek/core';
import type {
  ModelEvent,
  ModelInfo,
  ModelProvider,
  ModelRequest,
  ProviderError,
  ProviderErrorKind,
  Result,
  Support,
} from '@autogeek/core';
import { z } from 'zod';
import type { TransportDeps, TransportTimeouts } from '../../http/transport.ts';
import type { RetryPolicy } from '../../http/retry.ts';
import { guardStream } from '../../stream/guard.ts';
import { createEventWriter } from '../../stream/writer.ts';
import { checkCredential, endpoint } from '../../credential.ts';
import type { ProviderCredential } from '../../credential.ts';
import { parseJsonOrUndefined, requestJson } from '../http-json.ts';
import { runSseStream } from '../sse-driver.ts';
import { anthropicProfile } from './models.ts';
import { ANTHROPIC_PROVIDER_ID, buildAnthropicBody } from './request.ts';
import { createAnthropicStream, errorKind } from './stream.ts';

/** The only origin Anthropic requests may go to (the catalog's fixed endpoint). */
export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const MAX_LIST_PAGES = 20;

const REQUIREMENTS = {
  providerId: ANTHROPIC_PROVIDER_ID,
  kinds: ['api_key'],
  fixedOrigin: ANTHROPIC_ORIGIN,
} as const;

export interface AnthropicProviderOptions {
  readonly timeouts?: TransportTimeouts;
  readonly retry?: RetryPolicy;
}

export function createAnthropicProvider(
  deps: TransportDeps,
  options: AnthropicProviderOptions = {},
): ModelProvider<ProviderCredential> {
  const transportOptions = {
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  };

  async function* run(
    request: ModelRequest,
    credential: ProviderCredential,
    signal: AbortSignal,
  ): AsyncGenerator<ModelEvent, void, undefined> {
    const writer = createEventWriter();
    if (!ModelRequestSchema.safeParse(request).success) {
      yield* writer.fail(providerError('invalid_request', ANTHROPIC_PROVIDER_ID));
      return;
    }
    const base = checkCredential(credential, REQUIREMENTS);
    if (!base.ok) {
      yield* writer.fail(base.error);
      return;
    }
    const body = buildAnthropicBody(request, anthropicProfile(request.model));
    const secrets = (): readonly string[] => [credential.reveal()];
    yield* runSseStream(
      {
        providerId: ANTHROPIC_PROVIDER_ID,
        url: endpoint(base.value, 'v1/messages'),
        headers: {
          ...headers(credential),
          accept: 'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
        secrets,
        classify: classifyAnthropicError,
        ...transportOptions,
      },
      deps,
      writer,
      createAnthropicStream({ writer, model: request.model, logger: deps.logger, secrets }),
    );
  }

  return {
    id: ANTHROPIC_PROVIDER_ID,
    stream(request, credential, signal) {
      return guardStream(run(request, credential, signal), {
        providerId: ANTHROPIC_PROVIDER_ID,
        logger: deps.logger,
      });
    },
    async listModels(credential, signal) {
      const base = checkCredential(credential, REQUIREMENTS);
      if (!base.ok) return base;
      const models: ModelInfo[] = [];
      let afterId: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const query = new URLSearchParams({ limit: '1000' });
        if (afterId !== undefined) query.set('after_id', afterId);
        const listed = await fetchModelPage(
          `${endpoint(base.value, 'v1/models')}?${query.toString()}`,
          credential,
          signal,
        );
        if (!listed.ok) return listed;
        for (const entry of listed.value.data) {
          const info = toModelInfo(entry);
          if (info !== undefined) models.push(info);
        }
        const lastId = listed.value.last_id;
        if (listed.value.has_more !== true || lastId === null || lastId === undefined)
          return ok(models);
        afterId = lastId;
      }
      return ok(models);
    },
  };

  function fetchModelPage(
    url: string,
    credential: ProviderCredential,
    signal: AbortSignal,
  ): Promise<Result<z.infer<typeof ModelPageSchema>, ProviderError>> {
    return requestJson(
      {
        providerId: ANTHROPIC_PROVIDER_ID,
        url,
        headers: headers(credential),
        signal,
        secrets: () => [credential.reveal()],
        classify: classifyAnthropicError,
        ...transportOptions,
      },
      deps,
      ModelPageSchema,
    );
  }
}

/** Headers shared by every request. The key is revealed inline and never stored. */
function headers(credential: ProviderCredential): Record<string, string> {
  return { 'anthropic-version': API_VERSION, 'x-api-key': credential.reveal() };
}

const ErrorBodySchema = z.looseObject({
  error: z.looseObject({
    type: z.string(),
    message: z.string().optional(),
    details: z.looseObject({ error_code: z.string().optional() }).nullish(),
  }),
});

const CONTEXT_LENGTH = /prompt is too long|context (window|length)|too many (input )?tokens/i;
const OUT_OF_CREDIT = /credit balance|usage limits|spend limit/i;

/**
 * Refines the status mapping from the error body (https://platform.claude.com/docs/en/api/errors):
 * an over-long prompt is a 400 `invalid_request_error`; billing problems and spend limits need
 * user action (quota) even when sent as 400 or 429; `overloaded_error` can come with a 500.
 */
export function classifyAnthropicError(
  _status: number,
  body: string,
): ProviderErrorKind | undefined {
  const parsed = ErrorBodySchema.safeParse(parseJsonOrUndefined(body));
  if (!parsed.success) return undefined;
  const { type, message = '', details } = parsed.data.error;
  if (type === 'billing_error' || details?.error_code === 'enforced_spend_limit_reached')
    return 'quota';
  if (type === 'invalid_request_error' && OUT_OF_CREDIT.test(message)) return 'quota';
  if (type === 'invalid_request_error' && CONTEXT_LENGTH.test(message)) return 'context_length';
  if (type === 'overloaded_error') return 'overloaded';
  const kind = errorKind(type);
  return kind === 'unknown' ? undefined : kind;
}

const Positive = z.number().int().positive();
const SupportedSchema = z.looseObject({ supported: z.boolean() }).nullish();
const ModelEntrySchema = z.looseObject({
  id: z.string().min(1),
  display_name: z.string().min(1).nullish(),
  max_input_tokens: Positive.nullish(),
  max_tokens: Positive.nullish(),
  capabilities: z
    .looseObject({ image_input: SupportedSchema, thinking: SupportedSchema })
    .nullish(),
});
const ModelPageSchema = z.looseObject({
  data: z.array(z.unknown()),
  has_more: z.boolean().optional(),
  last_id: z.string().nullish(),
});

/** One listed model, or undefined when the entry is malformed (it is skipped, not fatal). */
function toModelInfo(entry: unknown): ModelInfo | undefined {
  const parsed = ModelEntrySchema.safeParse(entry);
  if (!parsed.success) return undefined;
  const model = parsed.data;
  const profile = anthropicProfile(model.id);
  const support = (value: { supported: boolean } | null | undefined, fallback: Support): Support =>
    value === null || value === undefined ? fallback : value.supported ? 'yes' : 'no';
  const info: ModelInfo = {
    providerId: ANTHROPIC_PROVIDER_ID,
    id: model.id,
    displayName: model.display_name ?? profile?.displayName ?? model.id,
    contextWindow: model.max_input_tokens ?? profile?.contextWindow ?? null,
    maxOutputTokens: model.max_tokens ?? profile?.maxOutputTokens ?? null,
    capabilities: {
      // Every Claude model takes client tools and prompt caching (no capability flag exists).
      tools: 'yes',
      vision: support(model.capabilities?.image_input, 'unknown'),
      reasoning: support(
        model.capabilities?.thinking,
        profile?.adaptiveThinking === true ? 'yes' : 'unknown',
      ),
      promptCaching: 'yes',
    },
    ...(profile?.pricing === undefined ? {} : { pricing: { ...profile.pricing } }),
    // Limits come from the API; prices only ever come from the catalog, so a priced entry is
    // marked 'catalog' and the UI shows its cost as an estimate.
    source: profile?.pricing === undefined ? 'api' : 'catalog',
  };
  return ModelInfoSchema.safeParse(info).success ? info : undefined;
}
