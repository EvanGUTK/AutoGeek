import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderCredential } from '../../credential.ts';
import { startFakeServer } from '../../testing/http-server.ts';
import type { FakeHandler, FakeServer } from '../../testing/http-server.ts';
import { testDeps } from '../../testing/provider-harness.ts';
import { OPENAI_ORIGIN, classifyOpenAIError, createOpenAIProvider } from './provider.ts';

const KEY = 'sk-proj-TESTKEYTESTKEY';
let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(handler: FakeHandler) {
  server = await startFakeServer(handler);
  const { deps, logs } = testDeps({ fixedOrigin: OPENAI_ORIGIN, serverOrigin: server.origin });
  return {
    fake: server,
    logs,
    provider: createOpenAIProvider(deps, {
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    }),
  };
}

const credential: ProviderCredential = {
  credentialId: 'cred_1',
  providerId: 'openai',
  kind: 'api_key',
  baseUrl: OPENAI_ORIGIN,
  reveal: () => KEY,
};

describe('openai provider', () => {
  it('posts a stateless Responses request with a bearer key', async () => {
    const { fake, provider, logs } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":null}}\n\n',
      );
    });
    const events = [];
    for await (const event of provider.stream(
      {
        model: 'gpt-5.5',
        maxOutputTokens: 64,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'const hidden = 1;' }] }],
      },
      credential,
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'done', stopReason: 'end_turn' }]);
    const [recorded] = fake.requests;
    expect(recorded?.path).toBe('/v1/responses');
    expect(recorded?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(recorded?.body ?? '')).toMatchObject({
      store: false,
      stream: true,
      model: 'gpt-5.5',
    });
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain('hidden');
  });

  it('lists chat models only, with catalog limits where known', async () => {
    const { provider } = await setup((_req, res) => {
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'gpt-5.5', object: 'model', owned_by: 'system' },
            { id: 'gpt-7-preview', object: 'model' },
            { id: 'text-embedding-3-large', object: 'model' },
            { id: 'gpt-4o-realtime-preview', object: 'model' },
            { id: 'whisper-1', object: 'model' },
            { nope: true },
          ],
        }),
      );
    });
    const result = await provider.listModels(credential, new AbortController().signal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((info) => [info.id, info.source, info.contextWindow])).toEqual([
      ['gpt-5.5', 'catalog', 922_000],
      ['gpt-7-preview', 'default', null],
    ]);
  });

  it.each([
    ['{"error":{"type":"insufficient_quota","code":"insufficient_quota"}}', 'quota'],
    ['{"error":{"type":"rate_limit_error","code":"credit_balance_exhausted"}}', 'quota'],
    [
      '{"error":{"type":"invalid_request_error","code":"context_length_exceeded"}}',
      'context_length',
    ],
    ['{"error":{"type":"service_unavailable_error","code":"server_is_overloaded"}}', 'overloaded'],
    ['{"error":{"type":"invalid_request_error","code":null}}', undefined],
    ['nope', undefined],
  ])('classifies %s', (body, kind) => {
    expect(classifyOpenAIError(429, body)).toBe(kind);
  });
});
