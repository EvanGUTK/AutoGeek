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
import { geminiProfile } from './models.ts';
import { GEMINI_MODEL_ID, GEMINI_PROVIDER_ID, buildGeminiBody } from './request.ts';
import { createGeminiStream, statusKind } from './stream.ts';

/** The only origin Gemini requests may go to (the catalog's fixed endpoint). */
export const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';
const MAX_LIST_PAGES = 20;

const REQUIREMENTS = {
  providerId: GEMINI_PROVIDER_ID,
  kinds: ['api_key'],
  fixedOrigin: GEMINI_ORIGIN,
} as const;

export interface GeminiProviderOptions {
  readonly timeouts?: TransportTimeouts;
  readonly retry?: RetryPolicy;
}

/**
 * Gemini Developer API, v1beta `streamGenerateContent?alt=sse` (stateless; explicit caching
 * available). The Interactions API is deliberately not used yet (D-008). The key is sent in the
 * `x-goog-api-key` header, never in the URL.
 */
export function createGeminiProvider(
  deps: TransportDeps,
  options: GeminiProviderOptions = {},
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
    if (!ModelRequestSchema.safeParse(request).success || !GEMINI_MODEL_ID.test(request.model)) {
      yield* writer.fail(providerError('invalid_request', GEMINI_PROVIDER_ID));
      return;
    }
    const base = checkCredential(credential, REQUIREMENTS);
    if (!base.ok) {
      yield* writer.fail(base.error);
      return;
    }
    const body = buildGeminiBody(request, geminiProfile(request.model));
    const secrets = (): readonly string[] => [credential.reveal()];
    yield* runSseStream(
      {
        providerId: GEMINI_PROVIDER_ID,
        url: `${endpoint(base.value, `v1beta/models/${request.model}:streamGenerateContent`)}?alt=sse`,
        headers: {
          'x-goog-api-key': credential.reveal(),
          accept: 'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
        secrets,
        classify: classifyGeminiError,
        ...transportOptions,
      },
      deps,
      writer,
      createGeminiStream({ writer, model: request.model, logger: deps.logger, secrets }),
    );
  }

  return {
    id: GEMINI_PROVIDER_ID,
    stream(request, credential, signal) {
      return guardStream(run(request, credential, signal), {
        providerId: GEMINI_PROVIDER_ID,
        logger: deps.logger,
      });
    },
    async listModels(credential, signal) {
      const base = checkCredential(credential, REQUIREMENTS);
      if (!base.ok) return base;
      const models: ModelInfo[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const query = new URLSearchParams({ pageSize: '1000' });
        if (pageToken !== undefined) query.set('pageToken', pageToken);
        const listed = await requestJson(
          {
            providerId: GEMINI_PROVIDER_ID,
            url: `${endpoint(base.value, 'v1beta/models')}?${query.toString()}`,
            headers: { 'x-goog-api-key': credential.reveal() },
            signal,
            secrets: () => [credential.reveal()],
            classify: classifyGeminiError,
            ...transportOptions,
          },
          deps,
          ModelPageSchema,
        );
        if (!listed.ok) return listed;
        models.push(...(listed.value.models ?? []).flatMap(toModelInfo));
        pageToken = listed.value.nextPageToken;
        if (pageToken === undefined || pageToken === '') return ok(models);
      }
      return ok(models);
    },
  };
}

const ErrorBodySchema = z.looseObject({
  error: z.looseObject({
    code: z.number().optional(),
    status: z.string().optional(),
    message: z.string().optional(),
    details: z.array(z.looseObject({ reason: z.string().optional() })).optional(),
  }),
});

const CONTEXT_LENGTH = /input token count|exceeds the maximum number of tokens|too long/i;

/**
 * Refines the status mapping from the google.rpc.Status body
 * (https://ai.google.dev/gemini-api/docs/troubleshooting): an invalid key is a 400
 * INVALID_ARGUMENT with ErrorInfo reason API_KEY_INVALID, which is an auth failure.
 */
export function classifyGeminiError(status: number, body: string): ProviderErrorKind | undefined {
  const parsed = ErrorBodySchema.safeParse(parseJsonOrUndefined(body));
  if (!parsed.success) return undefined;
  const error = parsed.data.error;
  if (error.details?.some((detail) => detail.reason === 'API_KEY_INVALID') === true) return 'auth';
  if (error.status === 'INVALID_ARGUMENT' && CONTEXT_LENGTH.test(error.message ?? ''))
    return 'context_length';
  const kind = statusKind(error.status, error.code ?? status);
  return kind === 'unknown' ? undefined : kind;
}

const ModelPageSchema = z.looseObject({
  models: z.array(z.unknown()).optional(),
  nextPageToken: z.string().optional(),
});
const Positive = z.number().int().positive();
const ModelEntrySchema = z.looseObject({
  name: z.string().min(1),
  baseModelId: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  inputTokenLimit: Positive.optional(),
  outputTokenLimit: Positive.optional(),
  supportedGenerationMethods: z.array(z.string()).optional(),
  thinking: z.boolean().optional(),
});

// The listing includes embedding, image, audio, live and agent models; they are not chat models.
const NOT_CHAT =
  /(embedding|tts|image|live|veo|lyria|transcribe|robotics|imagen|banana|omni|aqa|research|antigravity)/;

function toModelInfo(entry: unknown): ModelInfo[] {
  const parsed = ModelEntrySchema.safeParse(entry);
  if (!parsed.success) return [];
  const model = parsed.data;
  const id = model.name.startsWith('models/') ? model.name.slice('models/'.length) : model.name;
  if (!GEMINI_MODEL_ID.test(id) || NOT_CHAT.test(id)) return [];
  if (model.supportedGenerationMethods?.includes('generateContent') !== true) return [];
  const profile = geminiProfile(id);
  const info: ModelInfo = {
    providerId: GEMINI_PROVIDER_ID,
    id,
    displayName: model.displayName ?? profile?.displayName ?? id,
    contextWindow: model.inputTokenLimit ?? profile?.contextWindow ?? null,
    maxOutputTokens: model.outputTokenLimit ?? profile?.maxOutputTokens ?? null,
    capabilities: {
      tools: 'yes',
      // Every current Gemini text model takes image input (model pages); unknown ids may not.
      vision: profile === undefined ? 'unknown' : 'yes',
      reasoning: model.thinking === undefined ? 'unknown' : model.thinking ? 'yes' : 'no',
      // Implicit caching is automatic on Gemini 2.5 and later.
      promptCaching: profile === undefined ? 'unknown' : 'yes',
    },
    ...(profile === undefined ? {} : { pricing: { ...profile.pricing } }),
    source: profile === undefined ? 'api' : 'catalog',
  };
  return ModelInfoSchema.safeParse(info).success ? [info] : [];
}
