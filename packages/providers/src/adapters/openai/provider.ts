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
import type { RetryPolicy } from '../../http/retry.ts';
import type { TransportDeps, TransportTimeouts } from '../../http/transport.ts';
import { guardStream } from '../../stream/guard.ts';
import { createEventWriter } from '../../stream/writer.ts';
import { parseJsonOrUndefined, requestJson } from '../http-json.ts';
import { runSseStream } from '../sse-driver.ts';
import { openaiProfile } from './models.ts';
import { OPENAI_PROVIDER_ID, buildOpenAIBody } from './request.ts';
import { createOpenAIStream } from './stream.ts';

/** The only origin OpenAI requests may go to (the catalog's fixed endpoint). */
export const OPENAI_ORIGIN = 'https://api.openai.com';

const REQUIREMENTS = {
  providerId: OPENAI_PROVIDER_ID,
  kinds: ['api_key'],
  fixedOrigin: OPENAI_ORIGIN,
} as const;

export interface OpenAIProviderOptions {
  readonly timeouts?: TransportTimeouts;
  readonly retry?: RetryPolicy;
}

export function createOpenAIProvider(
  deps: TransportDeps,
  options: OpenAIProviderOptions = {},
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
      yield* writer.fail(providerError('invalid_request', OPENAI_PROVIDER_ID));
      return;
    }
    const base = checkCredential(credential, REQUIREMENTS);
    if (!base.ok) {
      yield* writer.fail(base.error);
      return;
    }
    const body = buildOpenAIBody(request, openaiProfile(request.model));
    const secrets = (): readonly string[] => [credential.reveal()];
    yield* runSseStream(
      {
        providerId: OPENAI_PROVIDER_ID,
        url: endpoint(base.value, 'v1/responses'),
        headers: {
          authorization: `Bearer ${credential.reveal()}`,
          accept: 'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
        secrets,
        classify: classifyOpenAIError,
        ...transportOptions,
      },
      deps,
      writer,
      createOpenAIStream({ writer, model: request.model, logger: deps.logger, secrets }),
    );
  }

  return {
    id: OPENAI_PROVIDER_ID,
    stream(request, credential, signal) {
      return guardStream(run(request, credential, signal), {
        providerId: OPENAI_PROVIDER_ID,
        logger: deps.logger,
      });
    },
    async listModels(credential, signal) {
      const base = checkCredential(credential, REQUIREMENTS);
      if (!base.ok) return base;
      const listed = await requestJson(
        {
          providerId: OPENAI_PROVIDER_ID,
          url: endpoint(base.value, 'v1/models'),
          headers: { authorization: `Bearer ${credential.reveal()}` },
          signal,
          secrets: () => [credential.reveal()],
          classify: classifyOpenAIError,
          ...transportOptions,
        },
        deps,
        ModelListSchema,
      );
      if (!listed.ok) return listed;
      return ok(listed.value.data.flatMap(toModelInfo));
    },
  };
}

const ErrorBodySchema = z.looseObject({
  error: z.looseObject({
    type: z.string().nullish(),
    code: z.string().nullish(),
  }),
});

const QUOTA_CODES = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
]);

/**
 * Refines the status mapping from the error body
 * (https://developers.openai.com/api/docs/guides/error-codes.md): several 429 variants are
 * exhausted credit or spend limits that need user action, not rate limits.
 */
export function classifyOpenAIError(_status: number, body: string): ProviderErrorKind | undefined {
  const parsed = ErrorBodySchema.safeParse(parseJsonOrUndefined(body));
  if (!parsed.success) return undefined;
  const { type, code } = parsed.data.error;
  if (code !== null && code !== undefined && QUOTA_CODES.has(code)) return 'quota';
  if (code === 'context_length_exceeded') return 'context_length';
  if (code === 'server_is_overloaded' || type === 'service_unavailable_error') return 'overloaded';
  return undefined;
}

const ModelListSchema = z.looseObject({ data: z.array(z.unknown()) });
const ModelEntrySchema = z.looseObject({ id: z.string().min(1) });

// GET /v1/models lists every model the key can use, embeddings and audio included; only
// text-generation families usable with the Responses API are offered.
const CHAT_FAMILY = /^(gpt-|o[1-9]|chatgpt-)/;
const NOT_CHAT = /(embedding|tts|whisper|dall-e|image|audio|realtime|transcribe|moderation|search)/;

function toModelInfo(entry: unknown): ModelInfo[] {
  const parsed = ModelEntrySchema.safeParse(entry);
  if (!parsed.success) return [];
  const { id } = parsed.data;
  if (!CHAT_FAMILY.test(id) || NOT_CHAT.test(id)) return [];
  const profile = openaiProfile(id);
  const info: ModelInfo = {
    providerId: OPENAI_PROVIDER_ID,
    id,
    displayName: profile?.displayName ?? id,
    contextWindow: profile?.contextWindow ?? null,
    maxOutputTokens: profile?.maxOutputTokens ?? null,
    capabilities: {
      tools: 'yes',
      vision: profile?.vision ?? 'unknown',
      reasoning: profile === undefined ? 'unknown' : profile.reasoning ? 'yes' : 'no',
      // Prompt caching is automatic for every model on the Responses API.
      promptCaching: 'yes',
    },
    ...(profile?.pricing === undefined ? {} : { pricing: { ...profile.pricing } }),
    // The listing has no limits or prices: they come from the catalog table, or are unknown.
    source: profile?.pricing === undefined ? 'default' : 'catalog',
  };
  return ModelInfoSchema.safeParse(info).success ? [info] : [];
}
