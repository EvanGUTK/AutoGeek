import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelProvider } from '@autogeek/core';
import type { CredentialKind, ProviderCredential } from '../../credential.ts';
import type { TransportDeps } from '../../http/transport.ts';
import { defineConformanceSuite } from '../../testing/conformance.ts';
import type { ConformanceFixtures, ReplaySpec } from '../../testing/conformance.ts';
import { buildChatBody } from './request.ts';
import type { ReasoningDialect } from './request.ts';
import {
  OPENROUTER_ORIGIN,
  createLlamaCppProvider,
  createLmStudioProvider,
  createOpenAICompatibleProvider,
  createOpenRouterProvider,
} from './providers.ts';

// Doc-derived fixtures per dialect: "openai" (plain OpenAI Chat Completions framing, also what
// LM Studio and llama.cpp emit) and "openrouter" (comment frames, usage chunk with a choice,
// reasoning_details). Re-record with the opt-in smoke tests.
const fixtures = (dialect: 'openai' | 'openrouter'): ConformanceFixtures => {
  const load = (name: string): string =>
    readFileSync(join(import.meta.dirname, 'fixtures', `${dialect}-${name}.sse`), 'utf8');
  return {
    text: load('text'),
    toolCall: load('tool-call'),
    parallelToolCalls: load('parallel-tool-calls'),
    malformedToolJson: load('malformed-tool-json'),
    unknownFields: load('unknown-fields'),
    truncatedToolCall: load('truncated-tool-call'),
  };
};

interface Variant {
  readonly providerId: string;
  readonly create: (deps: TransportDeps) => ModelProvider<ProviderCredential>;
  readonly kind: CredentialKind;
  readonly fixedBase?: string;
  readonly dialect: 'openai' | 'openrouter';
  readonly reasoning: ReasoningDialect;
  readonly replay: ReplaySpec['matchesOn'];
}

const VARIANTS: readonly Variant[] = [
  {
    providerId: 'openrouter',
    create: createOpenRouterProvider,
    kind: 'api_key',
    fixedBase: `${OPENROUTER_ORIGIN}/api/v1`,
    dialect: 'openrouter',
    reasoning: 'openrouter',
    replay: 'provider+model',
  },
  {
    providerId: 'lmstudio',
    create: createLmStudioProvider,
    kind: 'none',
    dialect: 'openai',
    reasoning: 'none',
    replay: 'none',
  },
  {
    providerId: 'llamacpp',
    create: createLlamaCppProvider,
    kind: 'none',
    dialect: 'openai',
    reasoning: 'reasoning_effort',
    replay: 'none',
  },
  {
    providerId: 'openai_compatible',
    create: createOpenAICompatibleProvider,
    kind: 'api_key',
    dialect: 'openai',
    reasoning: 'none',
    replay: 'none',
  },
];

for (const variant of VARIANTS) {
  defineConformanceSuite({
    name: variant.providerId,
    providerId: variant.providerId,
    ...(variant.fixedBase === undefined ? {} : { fixedOrigin: OPENROUTER_ORIGIN }),
    create: (deps) => variant.create(deps),
    credential: (serverOrigin) => ({
      credentialId: `cred_${variant.providerId}`,
      providerId: variant.providerId,
      kind: variant.kind,
      baseUrl: variant.fixedBase ?? `${serverOrigin}/v1`,
      reveal: () => (variant.kind === 'none' ? '' : 'sk-or-v1-CONFORMANCECONFORMANCE'),
    }),
    request: {
      model: 'vendor/model-1',
      maxOutputTokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What is the answer?' }] }],
    },
    contentType: 'text/event-stream',
    fixtures: fixtures(variant.dialect),
    expectedText: 'The answer is 42.',
    expectedToolCalls: [
      { name: 'read_file', input: { path: 'a.ts' } },
      { name: 'read_file', input: { path: 'b.ts' } },
    ],
    errorBody: (status) => JSON.stringify({ error: { code: status, message: 'conformance' } }),
    replay: {
      matchesOn: variant.replay,
      build: (request) =>
        buildChatBody(request, {
          providerId: variant.providerId,
          reasoning: variant.reasoning,
          replayReasoningDetails: variant.replay !== 'none',
        }),
      reasoningPart: (providerId, modelId, token) => ({
        type: 'reasoning',
        text: 'thinking',
        providerMetadata: {
          origin: { providerId, modelId },
          data: { reasoningDetails: [{ type: 'reasoning.encrypted', data: token, index: 0 }] },
        },
      }),
    },
  });
}
