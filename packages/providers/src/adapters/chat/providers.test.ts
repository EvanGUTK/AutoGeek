import type { ModelEvent } from '@autogeek/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { CredentialKind, ProviderCredential } from '../../credential.ts';
import type { TransportDeps } from '../../http/transport.ts';
import { startFakeServer } from '../../testing/http-server.ts';
import type { FakeHandler, FakeServer } from '../../testing/http-server.ts';
import { testDeps } from '../../testing/provider-harness.ts';
import { classifyChatError } from './provider.ts';
import {
  OPENROUTER_ORIGIN,
  createLlamaCppProvider,
  createLmStudioProvider,
  createOpenAICompatibleProvider,
  createOpenRouterProvider,
} from './providers.ts';

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serve(handler: FakeHandler, fixedOrigin?: string) {
  server = await startFakeServer(handler);
  return {
    fake: server,
    ...testDeps({
      ...(fixedOrigin === undefined ? {} : { fixedOrigin }),
      serverOrigin: server.origin,
    }),
  };
}

function credential(providerId: string, kind: CredentialKind, baseUrl: string): ProviderCredential {
  return {
    credentialId: `cred_${providerId}`,
    providerId,
    kind,
    baseUrl,
    reveal: () => (kind === 'none' ? '' : 'sk-TESTKEYTESTKEY'),
  };
}

const STREAM =
  'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const REQUEST = {
  model: 'm',
  maxOutputTokens: 16,
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
};

async function drain(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function okStream(): FakeHandler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(STREAM);
  };
}

describe('chat-family providers: requests', () => {
  it('OpenRouter sends the bearer key and the app title to /api/v1/chat/completions', async () => {
    const { fake, deps } = await serve(okStream(), OPENROUTER_ORIGIN);
    const provider = createOpenRouterProvider(deps);
    const events = await drain(
      provider.stream(
        REQUEST,
        credential('openrouter', 'api_key', `${OPENROUTER_ORIGIN}/api/v1`),
        new AbortController().signal,
      ),
    );
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
    expect(fake.requests[0]?.path).toBe('/api/v1/chat/completions');
    expect(fake.requests[0]?.headers.authorization).toBe('Bearer sk-TESTKEYTESTKEY');
    expect(fake.requests[0]?.headers['x-openrouter-title']).toBe('AutoGeek');
  });

  it('a keyless local server gets no authorization header and keeps the /v1 prefix', async () => {
    const { fake, deps, logs } = await serve(okStream());
    const provider = createLmStudioProvider(deps);
    await drain(
      provider.stream(
        REQUEST,
        credential('lmstudio', 'none', `${fake.origin}/v1`),
        new AbortController().signal,
      ),
    );
    expect(fake.requests[0]?.path).toBe('/v1/chat/completions');
    expect(fake.requests[0]?.headers.authorization).toBeUndefined();
    expect(logs.filter((entry) => entry.level === 'warn')).toEqual([]);
  });

  it('warns on plaintext http to a non-loopback host, without logging the key', async () => {
    const { fake, deps, logs } = await serve(okStream());
    // Route the remote-looking host to the local fake server; the URL the adapter sees stays remote.
    const remote = 'http://10.11.12.13:1234';
    const routed: TransportDeps = {
      ...deps,
      fetch: (input, init) =>
        deps.fetch(typeof input === 'string' ? input.replace(remote, fake.origin) : input, init),
    };
    const provider = createOpenAICompatibleProvider(routed);
    await drain(
      provider.stream(
        REQUEST,
        credential('openai_compatible', 'api_key', `${remote}/v1`),
        new AbortController().signal,
      ),
    );
    expect(logs.filter((entry) => entry.level === 'warn')).toEqual([
      {
        level: 'warn',
        message: 'plaintext http to a non-loopback provider endpoint',
        fields: { providerId: 'openai_compatible', target: remote },
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain('sk-TESTKEYTESTKEY');
    expect(fake.requests[0]?.headers.authorization).toBe('Bearer sk-TESTKEYTESTKEY');
  });

  it('refuses a keyed credential for a keyless-only server', async () => {
    const { fake, deps } = await serve(okStream());
    const provider = createLlamaCppProvider(deps);
    const events = await drain(
      provider.stream(
        REQUEST,
        credential('llamacpp', 'api_key', `${fake.origin}/v1`),
        new AbortController().signal,
      ),
    );
    expect(events).toEqual([
      { type: 'error', error: expect.objectContaining({ kind: 'credential_mismatch' }) as unknown },
    ]);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('chat-family providers: listModels', () => {
  it('OpenRouter maps live metadata and converts per-token prices to micros per MTok (highest tier)', async () => {
    const { deps } = await serve((_req, res) => {
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'anthropic/claude-opus-5.5',
              name: 'Anthropic: Claude Opus 5.5',
              context_length: 1000000,
              architecture: { input_modalities: ['text', 'image'] },
              pricing: {
                prompt: '0.000004',
                completion: '0.00002',
                input_cache_read: '0.0000002',
                overrides: [
                  { min_prompt_tokens: 200000, prompt: '0.000008', completion: '0.00003' },
                ],
              },
              top_provider: { max_completion_tokens: 128000 },
              supported_parameters: ['tools', 'reasoning', 'max_tokens'],
            },
            {
              id: 'openrouter/auto',
              name: 'Auto',
              context_length: 2000000,
              pricing: { prompt: '-1', completion: '-1' },
            },
            { broken: true },
          ],
        }),
      );
    }, OPENROUTER_ORIGIN);
    const result = await createOpenRouterProvider(deps).listModels(
      credential('openrouter', 'api_key', `${OPENROUTER_ORIGIN}/api/v1`),
      new AbortController().signal,
    );
    expect(result).toEqual({
      ok: true,
      value: [
        {
          providerId: 'openrouter',
          id: 'anthropic/claude-opus-5.5',
          displayName: 'Anthropic: Claude Opus 5.5',
          contextWindow: 1_000_000,
          maxOutputTokens: 128_000,
          capabilities: { tools: 'yes', vision: 'yes', reasoning: 'yes', promptCaching: 'yes' },
          pricing: { input: 8_000_000, output: 30_000_000, cacheRead: 200_000 },
          source: 'api',
        },
        {
          providerId: 'openrouter',
          id: 'openrouter/auto',
          displayName: 'Auto',
          contextWindow: 2_000_000,
          maxOutputTokens: null,
          capabilities: {
            tools: 'unknown',
            vision: 'unknown',
            reasoning: 'unknown',
            promptCaching: 'unknown',
          },
          source: 'api',
        },
      ],
    });
  });

  it('LM Studio prefers the loaded context length from its native listing', async () => {
    const { fake, deps } = await serve((req, res) => {
      if (req.path === '/api/v1/models') {
        res.end(
          JSON.stringify({
            models: [
              {
                type: 'llm',
                key: 'qwen/qwen3-coder',
                display_name: 'Qwen3 Coder',
                max_context_length: 262144,
                loaded_instances: [{ id: 'x', config: { context_length: 8192 } }],
                capabilities: {
                  vision: false,
                  trained_for_tool_use: true,
                  reasoning: { allowed_options: ['off', 'on'] },
                },
              },
              { type: 'embedding', key: 'nomic-embed' },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const result = await createLmStudioProvider(deps).listModels(
      credential('lmstudio', 'none', `${fake.origin}/v1`),
      new AbortController().signal,
    );
    expect(result.ok && result.value).toEqual([
      {
        providerId: 'lmstudio',
        id: 'qwen/qwen3-coder',
        displayName: 'Qwen3 Coder',
        contextWindow: 8192,
        maxOutputTokens: null,
        capabilities: { tools: 'yes', vision: 'no', reasoning: 'yes', promptCaching: 'unknown' },
        source: 'api',
      },
    ]);
  });

  it('LM Studio falls back to ids when the native listing is missing', async () => {
    const { fake, deps } = await serve((req, res) => {
      if (req.path === '/v1/models') {
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'some-model', object: 'model' }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const result = await createLmStudioProvider(deps, {
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    }).listModels(
      credential('lmstudio', 'none', `${fake.origin}/v1`),
      new AbortController().signal,
    );
    expect(result.ok && result.value.map((info) => [info.id, info.contextWindow])).toEqual([
      ['some-model', null],
    ]);
  });

  it('llama.cpp uses the served context from /props over the training context', async () => {
    const { fake, deps } = await serve((req, res) => {
      if (req.path === '/props') {
        res.end(JSON.stringify({ default_generation_settings: { n_ctx: 16384 } }));
        return;
      }
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            {
              id: 'llama.gguf',
              meta: { n_ctx_train: 131072 },
              architecture: { input_modalities: ['text'] },
            },
          ],
        }),
      );
    });
    const result = await createLlamaCppProvider(deps).listModels(
      credential('llamacpp', 'none', `${fake.origin}/v1`),
      new AbortController().signal,
    );
    expect(
      result.ok &&
        result.value.map((info) => [info.id, info.contextWindow, info.capabilities.vision]),
    ).toEqual([['llama.gguf', 16384, 'no']]);
  });
});

describe('classifyChatError', () => {
  it.each([
    ['{"error":{"code":402,"message":"Insufficient credits"}}', 402, 'quota'],
    [
      '{"error":{"code":400,"message":"x","type":"exceed_context_size_error"}}',
      400,
      'context_length',
    ],
    [
      '{"error":{"code":400,"message":"x","metadata":{"error_type":"context_length_exceeded"}}}',
      400,
      'context_length',
    ],
    ['{"error":"model not found"}', 404, undefined],
    ['nope', 500, undefined],
  ])('classifies %s', (body, status, kind) => {
    expect(classifyChatError(status, body)).toBe(kind);
  });
});
