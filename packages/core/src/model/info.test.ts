import { describe, expect, it } from 'vitest';
import type { ModelEvent } from './event.ts';
import { checkModelEventOrder } from './event-order.ts';
import { ModelInfoSchema } from './info.ts';
import type { ModelProvider } from './info.ts';
import { providerError } from './provider-error.ts';
import { ok } from '../result.ts';

const info = {
  providerId: 'anthropic',
  id: 'claude-sonnet-5-5',
  displayName: 'Claude Sonnet 5.5',
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  capabilities: { tools: 'yes', vision: 'yes', reasoning: 'yes', promptCaching: 'yes' },
  source: 'api',
};

describe('ModelInfoSchema', () => {
  it('accepts a fully known model', () => {
    expect(ModelInfoSchema.safeParse(info).success).toBe(true);
  });

  it('accepts unknown limits and capabilities (local models)', () => {
    const unknown = {
      ...info,
      contextWindow: null,
      maxOutputTokens: null,
      capabilities: { tools: 'unknown', vision: 'no', reasoning: 'unknown', promptCaching: 'no' },
      source: 'default',
    };
    expect(ModelInfoSchema.safeParse(unknown).success).toBe(true);
  });

  it.each(['api', 'catalog', 'default'])('accepts source %s', (source) => {
    expect(ModelInfoSchema.safeParse({ ...info, source }).success).toBe(true);
  });

  it('prices in INTEGER micro-USD per million tokens: money is never a float', () => {
    const priced = {
      ...info,
      // $3.00 / $15.00 per 1M tokens, cache read $0.30, cache write $3.75
      pricing: { input: 3_000_000, output: 15_000_000, cacheRead: 300_000, cacheWrite: 3_750_000 },
    };
    expect(ModelInfoSchema.safeParse(priced).success).toBe(true);
    expect(
      ModelInfoSchema.safeParse({ ...info, pricing: { input: 3.0, output: 15.5 } }).success,
    ).toBe(false);
    expect(ModelInfoSchema.safeParse({ ...info, pricing: { input: 1, output: -1 } }).success).toBe(
      false,
    );
  });

  it('requires pricing input and output when pricing is present, and rejects unknown price fields', () => {
    expect(ModelInfoSchema.safeParse({ ...info, pricing: { input: 1 } }).success).toBe(false);
    expect(
      ModelInfoSchema.safeParse({ ...info, pricing: { input: 1, output: 1, usd: 1 } }).success,
    ).toBe(false);
  });

  it.each([
    ['an empty providerId', { providerId: '' }],
    ['an empty model id', { id: '' }],
    ['an empty displayName', { displayName: '' }],
    ['a zero context window', { contextWindow: 0 }],
    ['a fractional context window', { contextWindow: 1.5 }],
    ['an undefined context window (must be null when unknown)', { contextWindow: undefined }],
    ['a negative max output', { maxOutputTokens: -1 }],
    ['an unknown capability value', { capabilities: { ...info.capabilities, tools: 'maybe' } }],
    ['a missing capability', { capabilities: { tools: 'yes', vision: 'yes', reasoning: 'yes' } }],
    ['an unknown source', { source: 'guess' }],
    ['extra fields', { family: 'claude' }],
  ])('rejects %s', (_name, patch) => {
    expect(ModelInfoSchema.safeParse({ ...info, ...patch }).success).toBe(false);
  });
});

describe('ModelProvider', () => {
  interface Credential {
    readonly providerId: string;
  }

  /** A scripted provider shows the contract is implementable and its streams are well-ordered. */
  const scripted: ModelProvider<Credential> = {
    id: 'scripted',
    listModels() {
      return Promise.resolve(ok([ModelInfoSchema.parse({ ...info, providerId: 'scripted' })]));
    },
    async *stream(_request, credential, signal) {
      await Promise.resolve();
      if (credential.providerId !== 'scripted') {
        yield { type: 'error', error: providerError('credential_mismatch', 'scripted') };
        return;
      }
      if (signal.aborted) {
        yield { type: 'error', error: providerError('aborted', 'scripted') };
        return;
      }
      yield { type: 'text_delta', text: 'hi' };
      yield { type: 'text_done' };
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };

  const request = {
    model: 'm',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'x' }] }],
    maxOutputTokens: 10,
  };

  async function collect(credential: Credential, signal: AbortSignal): Promise<ModelEvent[]> {
    const events: ModelEvent[] = [];
    for await (const event of scripted.stream(request, credential, signal)) {
      events.push(event);
    }
    return events;
  }

  it('lists models as a Result instead of throwing', async () => {
    const result = await scripted.listModels(
      { providerId: 'scripted' },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
  });

  it('streams a well-ordered conversation ending in one terminal event', async () => {
    const events = await collect({ providerId: 'scripted' }, new AbortController().signal);
    expect(checkModelEventOrder(events)).toEqual([]);
  });

  it('reports a wrong credential as a single terminal credential_mismatch error, never a throw', async () => {
    const events = await collect({ providerId: 'other' }, new AbortController().signal);
    expect(events).toEqual([
      { type: 'error', error: providerError('credential_mismatch', 'scripted') },
    ]);
    expect(checkModelEventOrder(events)).toEqual([]);
  });

  it('reports an abort as a single terminal aborted error', async () => {
    const events = await collect({ providerId: 'scripted' }, AbortSignal.abort());
    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(checkModelEventOrder(events)).toEqual([]);
  });
});
