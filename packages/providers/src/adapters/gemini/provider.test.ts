import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderCredential } from '../../credential.ts';
import { startFakeServer } from '../../testing/http-server.ts';
import type { FakeHandler, FakeServer } from '../../testing/http-server.ts';
import { testDeps } from '../../testing/provider-harness.ts';
import { GEMINI_ORIGIN, classifyGeminiError, createGeminiProvider } from './provider.ts';

const KEY = 'AIzaSyTESTKEYTESTKEYTESTKEY0000000';
let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(handler: FakeHandler) {
  server = await startFakeServer(handler);
  const { deps, logs } = testDeps({ fixedOrigin: GEMINI_ORIGIN, serverOrigin: server.origin });
  return {
    fake: server,
    logs,
    provider: createGeminiProvider(deps, {
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    }),
  };
}

const credential: ProviderCredential = {
  credentialId: 'cred_1',
  providerId: 'google',
  kind: 'api_key',
  baseUrl: GEMINI_ORIGIN,
  reveal: () => KEY,
};
const request = (model: string) => ({
  model,
  maxOutputTokens: 64,
  messages: [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'let secret = 1' }] },
  ],
});

describe('gemini provider', () => {
  it('sends the key in a header, never the URL', async () => {
    const { fake, provider, logs } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n',
      );
    });
    const events = [];
    for await (const event of provider.stream(
      request('gemini-3.8-flash'),
      credential,
      new AbortController().signal,
    ))
      events.push(event);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
    const [recorded] = fake.requests;
    expect(recorded?.path).toBe('/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
    expect(recorded?.path).not.toContain(KEY);
    expect(recorded?.headers['x-goog-api-key']).toBe(KEY);
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain('secret = 1');
  });

  it('rejects a model id that would change the URL path, without I/O', async () => {
    const { fake, provider } = await setup((_req, res) => {
      res.end();
    });
    const events = [];
    for await (const event of provider.stream(
      request('../../v1beta/files'),
      credential,
      new AbortController().signal,
    ))
      events.push(event);
    expect(events).toEqual([
      { type: 'error', error: expect.objectContaining({ kind: 'invalid_request' }) as unknown },
    ]);
    expect(fake.requests).toHaveLength(0);
  });

  it('lists generateContent chat models across pages', async () => {
    const { fake, provider } = await setup((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (!req.path.includes('pageToken')) {
        res.end(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-3.8-flash',
                displayName: 'Gemini 3.8 Flash',
                inputTokenLimit: 1048576,
                outputTokenLimit: 65536,
                supportedGenerationMethods: ['generateContent', 'countTokens'],
                thinking: true,
              },
              { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] },
              {
                name: 'models/gemini-3.8-flash-tts',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
            nextPageToken: 'p2',
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          models: [
            { name: 'models/gemini-4-pro-exp', supportedGenerationMethods: ['generateContent'] },
            { bad: 1 },
          ],
        }),
      );
    });
    const result = await provider.listModels(credential, new AbortController().signal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.map((info) => [
        info.id,
        info.source,
        info.contextWindow,
        info.capabilities.reasoning,
      ]),
    ).toEqual([
      ['gemini-3.8-flash', 'catalog', 1_048_576, 'yes'],
      ['gemini-4-pro-exp', 'api', null, 'unknown'],
    ]);
    expect(fake.requests.map((r) => r.path)).toEqual([
      '/v1beta/models?pageSize=1000',
      '/v1beta/models?pageSize=1000&pageToken=p2',
    ]);
  });

  it.each([
    [
      400,
      '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"API key not valid.","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID"}]}}',
      'auth',
    ],
    [
      400,
      '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"The input token count (2000000) exceeds the maximum number of tokens allowed (1048576)."}}',
      'context_length',
    ],
    [429, '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota"}}', 'rate_limit'],
    [503, '{"error":{"code":503,"status":"UNAVAILABLE","message":"overloaded"}}', 'overloaded'],
    [400, 'not json', undefined],
  ])('classifies %i %s', (status, body, kind) => {
    expect(classifyGeminiError(status, body)).toBe(kind);
  });
});
