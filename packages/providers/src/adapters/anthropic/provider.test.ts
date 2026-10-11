import { ModelEventSchema, checkModelEventOrder } from '@autogeek/core';
import type { ModelEvent, ModelRequest } from '@autogeek/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderCredential } from '../../credential.ts';
import { startFakeServer } from '../../testing/http-server.ts';
import type { FakeHandler, FakeServer } from '../../testing/http-server.ts';
import { testDeps } from '../../testing/provider-harness.ts';
import { ANTHROPIC_ORIGIN, classifyAnthropicError, createAnthropicProvider } from './provider.ts';

const KEY = 'sk-ant-api03-TESTKEYTESTKEYTESTKEY';
const NO_RETRY = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 };

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(handler: FakeHandler) {
  server = await startFakeServer(handler);
  const harness = testDeps({ fixedOrigin: ANTHROPIC_ORIGIN, serverOrigin: server.origin });
  return {
    fake: server,
    ...harness,
    provider: createAnthropicProvider(harness.deps, { retry: NO_RETRY }),
  };
}

function credential(
  overrides: Partial<ProviderCredential> = {},
): ProviderCredential & { reveals: () => number } {
  let reveals = 0;
  return {
    credentialId: 'cred_1',
    providerId: 'anthropic',
    kind: 'api_key',
    baseUrl: ANTHROPIC_ORIGIN,
    reveal: () => {
      reveals += 1;
      return KEY;
    },
    reveals: () => reveals,
    ...overrides,
  };
}

const REQUEST: ModelRequest = {
  model: 'claude-opus-5-5',
  maxOutputTokens: 256,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'function secretSauce() {}' }] }],
};

function frames(events: readonly Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

const TEXT_STREAM = frames([
  {
    type: 'message_start',
    message: { model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 1 } },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]);

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  for (const event of events) ModelEventSchema.parse(event);
  expect(checkModelEventOrder(events)).toEqual([]);
  return events;
}

describe('anthropic provider: stream', () => {
  it('sends a well-formed request and streams the answer', async () => {
    const { fake, provider, logs } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_1' });
      res.end(TEXT_STREAM);
    });
    const events = await collect(
      provider.stream(REQUEST, credential(), new AbortController().signal),
    );
    expect(events).toEqual([
      { type: 'text_delta', text: 'Hi' },
      { type: 'text_done' },
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    const [recorded] = fake.requests;
    expect(recorded?.path).toBe('/v1/messages');
    expect(recorded?.headers['x-api-key']).toBe(KEY);
    expect(recorded?.headers['anthropic-version']).toBe('2023-06-01');
    expect(recorded?.headers.authorization).toBeUndefined();
    expect(JSON.parse(recorded?.body ?? '')).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      max_tokens: 256,
    });
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('secretSauce');
  });

  it('refuses a credential for another provider before any I/O, without revealing it', async () => {
    const { fake, provider } = await setup((_req, res) => {
      res.end();
    });
    const cred = credential({ providerId: 'openai' });
    const events = await collect(provider.stream(REQUEST, cred, new AbortController().signal));
    expect(events).toEqual([
      { type: 'error', error: expect.objectContaining({ kind: 'credential_mismatch' }) as unknown },
    ]);
    expect(fake.requests).toHaveLength(0);
    expect(cred.reveals()).toBe(0);
  });

  it('refuses a credential pointing at another origin', async () => {
    const { fake, provider } = await setup((_req, res) => {
      res.end();
    });
    const events = await collect(
      provider.stream(
        REQUEST,
        credential({ baseUrl: 'https://evil.example' }),
        new AbortController().signal,
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'credential_mismatch' } });
    expect(fake.requests).toHaveLength(0);
  });

  it('rejects an invalid request locally', async () => {
    const { fake, provider } = await setup((_req, res) => {
      res.end();
    });
    const events = await collect(
      provider.stream(
        { ...REQUEST, maxOutputTokens: 0 },
        credential(),
        new AbortController().signal,
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'invalid_request' } });
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    [401, { type: 'authentication_error', message: 'invalid x-api-key' }, 'auth'],
    [429, { type: 'rate_limit_error', message: 'slow down' }, 'rate_limit'],
    [500, { type: 'api_error', message: 'boom' }, 'server'],
    [529, { type: 'overloaded_error', message: 'Overloaded' }, 'overloaded'],
    [
      400,
      {
        type: 'invalid_request_error',
        message: 'prompt is too long: 1200000 tokens > 1000000 maximum',
      },
      'context_length',
    ],
    [400, { type: 'invalid_request_error', message: 'Your credit balance is too low' }, 'quota'],
  ] as const)('maps HTTP %i %s to %s', async (status, error, kind) => {
    const { provider } = await setup((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_e' });
      res.end(JSON.stringify({ type: 'error', error, request_id: 'req_e' }));
    });
    const events = await collect(
      provider.stream(REQUEST, credential(), new AbortController().signal),
    );
    expect(events).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({ kind, status, requestId: 'req_e' }) as unknown,
      },
    ]);
  });

  it('aborts mid-stream with a single aborted terminal and releases the socket', async () => {
    const controller = new AbortController();
    const { fake, provider } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(TEXT_STREAM.split('event: content_block_stop')[0]);
    });
    const events: ModelEvent[] = [];
    for await (const event of provider.stream(REQUEST, credential(), controller.signal)) {
      events.push(event);
      if (event.type === 'text_delta') controller.abort();
    }
    expect(checkModelEventOrder(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'aborted' } });
    await fake.waitForNoSockets();
  });

  it('applies an abort between events that arrived in the same chunk', async () => {
    const controller = new AbortController();
    const { fake, provider } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(TEXT_STREAM.split('event: message_stop')[0]);
    });
    const events: ModelEvent[] = [];
    for await (const event of provider.stream(REQUEST, credential(), controller.signal)) {
      events.push(event);
      if (event.type === 'text_delta') controller.abort();
    }
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'usage', 'error']);
    expect(events.at(-1)).toMatchObject({ error: { kind: 'aborted' } });
    await fake.waitForNoSockets();
  });

  it('releases the socket when the consumer stops early', async () => {
    const { fake, provider } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(TEXT_STREAM.split('event: content_block_stop')[0]);
    });
    for await (const event of provider.stream(
      REQUEST,
      credential(),
      new AbortController().signal,
    )) {
      expect(event.type).toBe('text_delta');
      break;
    }
    await fake.waitForNoSockets();
  });

  it('reports a mid-stream disconnect as network with usage first', async () => {
    const { fake, provider } = await setup((_req, res, socket) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(TEXT_STREAM.split('event: content_block_stop')[0]);
      setTimeout(() => socket.destroy(), 20);
    });
    const events = await collect(
      provider.stream(REQUEST, credential(), new AbortController().signal),
    );
    expect(events.slice(-2)).toEqual([
      { type: 'usage', inputTokens: 5, outputTokens: 1 },
      { type: 'error', error: expect.objectContaining({ kind: 'network' }) as unknown },
    ]);
    await fake.waitForNoSockets();
  });
});

describe('anthropic provider: listModels', () => {
  const entry = (id: string, extra: Record<string, unknown> = {}) => ({
    type: 'model',
    id,
    display_name: id.toUpperCase(),
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: { image_input: { supported: true }, thinking: { supported: true } },
    ...extra,
  });

  it('follows pagination, maps entries and skips malformed ones', async () => {
    const { fake, provider } = await setup((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (!req.path.includes('after_id')) {
        res.end(
          JSON.stringify({
            data: [entry('claude-opus-5-5'), { id: 5 }],
            has_more: true,
            last_id: 'claude-opus-5-5',
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          data: [
            entry('claude-new-model', { max_input_tokens: null, capabilities: null, future: 1 }),
          ],
          has_more: false,
          last_id: 'claude-new-model',
        }),
      );
    });
    const result = await provider.listModels(credential(), new AbortController().signal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      {
        providerId: 'anthropic',
        id: 'claude-opus-5-5',
        displayName: 'CLAUDE-OPUS-5-5',
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        capabilities: { tools: 'yes', vision: 'yes', reasoning: 'yes', promptCaching: 'yes' },
        pricing: {
          input: 4_000_000,
          output: 20_000_000,
          cacheRead: 200_000,
          cacheWrite: 5_000_000,
        },
        source: 'api',
      },
      {
        providerId: 'anthropic',
        id: 'claude-new-model',
        displayName: 'CLAUDE-NEW-MODEL',
        contextWindow: null,
        maxOutputTokens: 128_000,
        capabilities: {
          tools: 'yes',
          vision: 'unknown',
          reasoning: 'unknown',
          promptCaching: 'yes',
        },
        source: 'api',
      },
    ]);
    expect(fake.requests.map((r) => [r.method, r.path])).toEqual([
      ['GET', '/v1/models?limit=1000'],
      ['GET', '/v1/models?limit=1000&after_id=claude-opus-5-5'],
    ]);
    expect(fake.requests[0]?.headers['x-api-key']).toBe(KEY);
  });

  it('returns a typed error instead of throwing', async () => {
    const { provider } = await setup((_req, res) => {
      res.writeHead(401);
      res.end(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      );
    });
    const result = await provider.listModels(credential(), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { kind: 'auth', status: 401 } });
  });

  it('rejects an unparseable listing as invalid_response', async () => {
    const { provider } = await setup((_req, res) => {
      res.end('<html>');
    });
    const result = await provider.listModels(credential(), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
  });

  it('refuses a mismatched credential without I/O', async () => {
    const { fake, provider } = await setup((_req, res) => {
      res.end();
    });
    const result = await provider.listModels(
      credential({ kind: 'none' }),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'credential_mismatch' } });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('classifyAnthropicError', () => {
  it.each([
    ['{"error":{"type":"billing_error","message":"x"}}', 'quota'],
    [
      '{"error":{"type":"rate_limit_error","message":"x","details":{"error_code":"enforced_spend_limit_reached"}}}',
      'quota',
    ],
    [
      '{"error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits"}}',
      'quota',
    ],
    ['{"error":{"type":"overloaded_error","message":"Overloaded"}}', 'overloaded'],
    ['{"error":{"type":"invalid_request_error","message":"messages.1: bad"}}', 'invalid_request'],
    ['{"error":{"type":"brand_new_error"}}', undefined],
    ['not json', undefined],
  ])('classifies %s', (body, kind) => {
    expect(classifyAnthropicError(400, body)).toBe(kind);
  });
});
