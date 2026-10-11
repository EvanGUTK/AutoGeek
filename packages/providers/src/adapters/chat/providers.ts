import { ModelInfoSchema, ok } from '@autogeek/core';
import type { ModelInfo, Support } from '@autogeek/core';
import { z } from 'zod';
import { endpoint } from '../../credential.ts';
import type { TransportDeps } from '../../http/transport.ts';
import {
  createChatCompletionsProvider,
  listIdsOnly,
  OpenAIModelListSchema,
  unknownModel,
} from './provider.ts';
import type { ChatProviderOptions, ChatProviderSpec, ListingContext } from './provider.ts';

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';

// ---------------------------------------------------------------------------------------------
// OpenRouter: https://openrouter.ai/docs/api-reference/overview (base https://openrouter.ai/api/v1)

const Price = z.string().optional();
const OpenRouterModelSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  context_length: z.number().int().positive().nullish(),
  architecture: z.looseObject({ input_modalities: z.array(z.string()).optional() }).optional(),
  pricing: z
    .looseObject({
      prompt: Price,
      completion: Price,
      input_cache_read: Price,
      input_cache_write: Price,
      overrides: z.array(z.looseObject({ prompt: Price, completion: Price })).optional(),
    })
    .optional(),
  top_provider: z
    .looseObject({ max_completion_tokens: z.number().int().positive().nullish() })
    .optional(),
  supported_parameters: z.array(z.string()).optional(),
});

/**
 * OpenRouter prices are decimal strings of USD per token; ModelInfo wants integer micro-USD per
 * million tokens (x 1e12). Negative values mark routers whose price varies: unknown. Long-context
 * `overrides` raise the price, so the highest tier is used (over-count, D-013).
 */
function micros(values: readonly (string | undefined)[]): number | undefined {
  const parsed = values.flatMap((value) => {
    if (value === undefined || !/^\d+(\.\d+)?$/.test(value)) return [];
    return [Math.round(Number(value) * 1e12)];
  });
  return parsed.length === 0 ? undefined : Math.max(...parsed);
}

function openRouterInfo(entry: unknown): ModelInfo[] {
  const parsed = OpenRouterModelSchema.safeParse(entry);
  if (!parsed.success) return [];
  const model = parsed.data;
  const pricing = model.pricing;
  const overrides = pricing?.overrides ?? [];
  const input = micros([pricing?.prompt, ...overrides.map((tier) => tier.prompt)]);
  const output = micros([pricing?.completion, ...overrides.map((tier) => tier.completion)]);
  const cacheRead = micros([pricing?.input_cache_read]);
  const cacheWrite = micros([pricing?.input_cache_write]);
  const params = model.supported_parameters ?? [];
  const has = (name: string): Support =>
    model.supported_parameters === undefined ? 'unknown' : params.includes(name) ? 'yes' : 'no';
  const info: ModelInfo = {
    providerId: 'openrouter',
    id: model.id,
    displayName: model.name ?? model.id,
    contextWindow: model.context_length ?? null,
    maxOutputTokens: model.top_provider?.max_completion_tokens ?? null,
    capabilities: {
      tools: has('tools'),
      vision:
        model.architecture?.input_modalities === undefined
          ? 'unknown'
          : model.architecture.input_modalities.includes('image')
            ? 'yes'
            : 'no',
      reasoning: has('reasoning'),
      promptCaching: cacheRead === undefined ? 'unknown' : 'yes',
    },
    ...(input === undefined || output === undefined
      ? {}
      : {
          pricing: {
            input,
            output,
            ...(cacheRead === undefined ? {} : { cacheRead }),
            ...(cacheWrite === undefined ? {} : { cacheWrite }),
          },
        }),
    source: 'api',
  };
  return ModelInfoSchema.safeParse(info).success ? [info] : [];
}

const OPENROUTER: ChatProviderSpec = {
  providerId: 'openrouter',
  // Stored kind is always api_key: the PKCE flow mints a normal user API key
  // (https://openrouter.ai/docs/guides/overview/auth/oauth).
  kinds: ['api_key'],
  fixedOrigin: OPENROUTER_ORIGIN,
  reasoning: 'openrouter',
  replayReasoningDetails: true,
  // App attribution (https://openrouter.ai/docs/app-attribution); localhost apps need a title.
  headers: { 'x-openrouter-title': 'AutoGeek' },
  async listModels(context) {
    const listed = await context.get(
      endpoint(context.base, 'models'),
      z.looseObject({ data: z.array(z.unknown()) }),
    );
    return listed.ok ? ok(listed.value.data.flatMap(openRouterInfo)) : listed;
  },
};

// ---------------------------------------------------------------------------------------------
// LM Studio: https://lmstudio.ai/docs/developer/openai-compat (base http://127.0.0.1:1234/v1)

const LmStudioModelsSchema = z.looseObject({
  models: z.array(
    z.looseObject({
      type: z.string().optional(),
      key: z.string().min(1),
      display_name: z.string().min(1).optional(),
      max_context_length: z.number().int().positive().optional(),
      loaded_instances: z
        .array(
          z.looseObject({
            config: z
              .looseObject({ context_length: z.number().int().positive().optional() })
              .optional(),
          }),
        )
        .optional(),
      capabilities: z
        .looseObject({
          vision: z.boolean().optional(),
          trained_for_tool_use: z.boolean().optional(),
          reasoning: z.unknown().optional(),
        })
        .optional(),
    }),
  ),
});

const yesNo = (value: boolean | undefined): Support =>
  value === undefined ? 'unknown' : value ? 'yes' : 'no';

/**
 * The OpenAI-style listing has no limits, so LM Studio's native `GET /api/v1/models` (0.4.0+)
 * supplies them: a LOADED model's context length is what it will actually accept (often far below
 * its maximum), so it wins over `max_context_length`. Older servers fall back to ids only.
 */
async function listLmStudio(context: ListingContext) {
  const native = await context.get(`${context.base.origin}/api/v1/models`, LmStudioModelsSchema);
  if (!native.ok) return listIdsOnly('lmstudio', context);
  return ok(
    native.value.models
      .filter((model) => model.type === undefined || model.type === 'llm')
      .flatMap((model) => {
        const loaded = model.loaded_instances?.find(
          (instance) => instance.config?.context_length !== undefined,
        );
        return unknownModel('lmstudio', model.key, {
          displayName: model.display_name ?? model.key,
          contextWindow: loaded?.config?.context_length ?? model.max_context_length ?? null,
          capabilities: {
            tools: yesNo(model.capabilities?.trained_for_tool_use),
            vision: yesNo(model.capabilities?.vision),
            reasoning:
              model.capabilities === undefined
                ? 'unknown'
                : model.capabilities.reasoning === undefined
                  ? 'no'
                  : 'yes',
            promptCaching: 'unknown',
          },
        });
      }),
  );
}

const LMSTUDIO: ChatProviderSpec = {
  providerId: 'lmstudio',
  kinds: ['none'],
  // Reasoning controls are not in LM Studio's documented compat parameters; nothing is sent.
  reasoning: 'none',
  replayReasoningDetails: false,
  listModels: listLmStudio,
};

// ---------------------------------------------------------------------------------------------
// llama.cpp server: tools/server/README.md (base http://127.0.0.1:8080/v1; master defaults 9931)

const LlamaModelsSchema = OpenAIModelListSchema.extend({
  data: z.array(
    z.looseObject({
      id: z.string().min(1),
      meta: z.looseObject({ n_ctx_train: z.number().int().positive().optional() }).nullish(),
      architecture: z.looseObject({ input_modalities: z.array(z.string()).optional() }).optional(),
    }),
  ),
});
const LlamaPropsSchema = z.looseObject({
  default_generation_settings: z
    .looseObject({ n_ctx: z.number().int().positive().optional() })
    .optional(),
});

/**
 * llama-server serves one model. Its effective context is `-c/--ctx-size` from `GET /props`
 * (`default_generation_settings.n_ctx`); `meta.n_ctx_train` is only the training context and is
 * used when /props is unavailable.
 */
async function listLlamaCpp(context: ListingContext) {
  const listed = await context.get(endpoint(context.base, 'models'), LlamaModelsSchema);
  if (!listed.ok) return listed;
  const props = await context.get(`${context.base.origin}/props`, LlamaPropsSchema);
  const servedContext = props.ok ? props.value.default_generation_settings?.n_ctx : undefined;
  return ok(
    listed.value.data.flatMap((model) =>
      unknownModel('llamacpp', model.id, {
        contextWindow: servedContext ?? model.meta?.n_ctx_train ?? null,
        capabilities: {
          tools: 'unknown',
          vision:
            model.architecture?.input_modalities === undefined
              ? 'unknown'
              : model.architecture.input_modalities.includes('image')
                ? 'yes'
                : 'no',
          reasoning: 'unknown',
          promptCaching: 'yes', // llama.cpp reuses the KV cache for a shared prefix
        },
      }),
    ),
  );
}

const LLAMACPP: ChatProviderSpec = {
  providerId: 'llamacpp',
  kinds: ['none'],
  // `reasoning_effort` is forwarded to the chat template ("none" disables thinking).
  reasoning: 'reasoning_effort',
  replayReasoningDetails: false,
  listModels: listLlamaCpp,
};

// ---------------------------------------------------------------------------------------------
// Any other OpenAI-compatible server: user-supplied base URL, optional key.

const OPENAI_COMPATIBLE: ChatProviderSpec = {
  providerId: 'openai_compatible',
  kinds: ['api_key', 'none'],
  // Unknown servers may reject unknown parameters, so no reasoning parameter is sent.
  reasoning: 'none',
  replayReasoningDetails: false,
  listModels: (context) => listIdsOnly('openai_compatible', context),
};

export function createOpenRouterProvider(deps: TransportDeps, options: ChatProviderOptions = {}) {
  return createChatCompletionsProvider(OPENROUTER, deps, options);
}

export function createLmStudioProvider(deps: TransportDeps, options: ChatProviderOptions = {}) {
  return createChatCompletionsProvider(LMSTUDIO, deps, options);
}

export function createLlamaCppProvider(deps: TransportDeps, options: ChatProviderOptions = {}) {
  return createChatCompletionsProvider(LLAMACPP, deps, options);
}

export function createOpenAICompatibleProvider(
  deps: TransportDeps,
  options: ChatProviderOptions = {},
) {
  return createChatCompletionsProvider(OPENAI_COMPATIBLE, deps, options);
}
