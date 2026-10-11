import { ModelEventSchema, checkModelEventOrder } from '@autogeek/core';
import type {
  ContentPart,
  JsonObject,
  Message,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from '@autogeek/core';
import type { ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderCredential } from '../credential.ts';
import type { TransportDeps } from '../http/transport.ts';
import { startFakeServer } from './http-server.ts';
import type { FakeServer } from './http-server.ts';
import { testDeps } from './provider-harness.ts';

/** Wire bodies for one adapter, each a complete vendor response unless noted. */
export interface ConformanceFixtures {
  /** Answers with exactly `expectedText`. */
  readonly text: string;
  /** One call to `expectedToolCalls[0]`. */
  readonly toolCall: string;
  /** Every call in `expectedToolCalls`, in order, in one response. */
  readonly parallelToolCalls: string;
  /** One call whose argument JSON is malformed. */
  readonly malformedToolJson: string;
  /** Like `text`, with unknown events, fields and enum values sprinkled in. */
  readonly unknownFields: string;
  /**
   * A tool call cut off by the output limit, or why that cannot happen on this vendor (e.g. Gemini
   * delivers each call whole, so a call is never cut mid-arguments).
   */
  readonly truncatedToolCall: string | { readonly notApplicable: string };
}

export interface ConformanceSpec {
  readonly name: string;
  readonly providerId: string;
  /** Fixed-endpoint providers: requests to it are routed to the fake server. */
  readonly fixedOrigin?: string;
  readonly create: (deps: TransportDeps) => ModelProvider<ProviderCredential>;
  /** A valid credential; editable providers point `baseUrl` at `serverOrigin`. */
  readonly credential: (serverOrigin: string) => ProviderCredential;
  readonly request: ModelRequest;
  readonly contentType: string;
  readonly fixtures: ConformanceFixtures;
  readonly expectedText: string;
  readonly expectedToolCalls: readonly { readonly name: string; readonly input: JsonObject }[];
  /** A vendor error body for an HTTP status. */
  readonly errorBody: (status: number) => string;
  readonly replay: ReplaySpec;
  /**
   * Canned answers for metadata endpoints an adapter calls before streaming (Ollama `/api/show`);
   * every other path gets the scenario's response.
   */
  readonly auxiliary?: (
    path: string,
  ) => { readonly status: number; readonly body: string } | undefined;
}

/** How the adapter replays reasoning from history (its documented origin-matching rule). */
export interface ReplaySpec {
  /**
   * 'provider': every same-provider part is replayed; 'provider+model': only the request model's;
   * 'none': the vendor has no field to replay reasoning in, so nothing ever is.
   */
  readonly matchesOn: 'provider' | 'provider+model' | 'none';
  /** The adapter's request body for `request`. */
  readonly build: (request: ModelRequest) => unknown;
  /** A replayable reasoning part from `providerId`/`modelId` whose wire form contains `token`. */
  readonly reasoningPart: (providerId: string, modelId: string, token: string) => ContentPart;
}

/**
 * The provider conformance suite (docs/briefs/providers.md): every adapter runs it against its
 * fixtures over a real local HTTP server. All event sequences are validated with the core schema
 * and ordering checker, and every connection must be closed afterwards.
 */
export function defineConformanceSuite(spec: ConformanceSpec): void {
  describe(`${spec.name} conformance`, () => {
    let server: FakeServer | undefined;
    afterEach(async () => {
      await server?.close();
      server = undefined;
    });

    async function serve(write: (res: ServerResponse, socket: Socket) => void) {
      server = await startFakeServer((req, res, socket) => {
        const canned = spec.auxiliary?.(req.path);
        if (canned !== undefined) {
          res.writeHead(canned.status, { 'content-type': 'application/json' });
          res.end(canned.body);
          return;
        }
        write(res, socket);
      });
      const { deps } = testDeps({
        ...(spec.fixedOrigin === undefined ? {} : { fixedOrigin: spec.fixedOrigin }),
        serverOrigin: server.origin,
      });
      const provider = spec.create({ ...deps });
      return { fake: server, provider, credential: spec.credential(server.origin) };
    }

    async function streamBody(body: string): Promise<ModelEvent[]> {
      const { provider, credential } = await serve((res) => {
        res.writeHead(200, { 'content-type': spec.contentType });
        res.end(body);
      });
      // A completed response may stay in the keep-alive pool, which is not a dangling socket;
      // the socket tests below cover the unfinished cases.
      return collect(provider.stream(spec.request, credential, new AbortController().signal));
    }

    it('streams text', async () => {
      const events = await streamBody(spec.fixtures.text);
      expect(textOf(events)).toBe(spec.expectedText);
      expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
    });

    it('streams one tool call', async () => {
      const events = await streamBody(spec.fixtures.toolCall);
      const calls = events.filter((event) => event.type === 'tool_call');
      expect(calls.map(({ name, input }) => ({ name, input }))).toEqual(
        spec.expectedToolCalls.slice(0, 1),
      );
      expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
    });

    it('streams parallel tool calls consecutively with unique ids', async () => {
      const events = await streamBody(spec.fixtures.parallelToolCalls);
      const indexes = events.flatMap((event, index) => (event.type === 'tool_call' ? [index] : []));
      const calls = events.filter((event) => event.type === 'tool_call');
      expect(calls.map(({ name, input }) => ({ name, input }))).toEqual(spec.expectedToolCalls);
      expect(new Set(calls.map((call) => call.id)).size).toBe(calls.length);
      expect(indexes.every((value, i) => i === 0 || value === (indexes[i - 1] ?? -2) + 1)).toBe(
        true,
      );
      expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
    });

    it('reports malformed tool JSON as tool_call_invalid', async () => {
      const events = await streamBody(spec.fixtures.malformedToolJson);
      expect(events.some((event) => event.type === 'tool_call')).toBe(false);
      expect(events.filter((event) => event.type === 'tool_call_invalid')).toEqual([
        expect.objectContaining({ reason: 'invalid_json' }),
      ]);
    });

    const truncated = spec.fixtures.truncatedToolCall;
    if (typeof truncated === 'string') {
      it('marks a call cut off by the output limit as truncated', async () => {
        const events = await streamBody(truncated);
        expect(events.filter((event) => event.type === 'tool_call_invalid')).toEqual([
          expect.objectContaining({ reason: 'truncated' }),
        ]);
        expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });
      });
    } else {
      it('documents why a call cannot be cut off by the output limit', () => {
        expect(truncated.notApplicable.length).toBeGreaterThan(20);
      });
    }

    it('does not crash on unknown vendor fields and events', async () => {
      const events = await streamBody(spec.fixtures.unknownFields);
      expect(textOf(events)).toBe(spec.expectedText);
      expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
    });

    it('reports a mid-stream disconnect as a network error and releases the socket', async () => {
      const { fake, provider, credential } = await serve((res, socket) => {
        res.writeHead(200, { 'content-type': spec.contentType });
        res.write(firstHalf(spec.fixtures.text));
        setTimeout(() => socket.destroy(), 20);
      });
      const events = await collect(
        provider.stream(spec.request, credential, new AbortController().signal),
      );
      expect(events.at(-1)).toMatchObject({
        type: 'error',
        error: { kind: 'network', retryable: true },
      });
      await fake.waitForNoSockets();
    });

    it('aborts with one aborted terminal and no dangling socket', async () => {
      const controller = new AbortController();
      const { fake, provider, credential } = await serve((res) => {
        res.writeHead(200, { 'content-type': spec.contentType });
        res.write(firstHalf(spec.fixtures.text));
      });
      const events: ModelEvent[] = [];
      for await (const event of provider.stream(spec.request, credential, controller.signal)) {
        events.push(event);
        if (events.length === 1) controller.abort();
      }
      assertContract(events);
      expect(events.at(-1)).toMatchObject({
        type: 'error',
        error: { kind: 'aborted', retryable: false },
      });
      await fake.waitForNoSockets();
    });

    it('releases the socket when the consumer stops iterating', async () => {
      const { fake, provider, credential } = await serve((res) => {
        res.writeHead(200, { 'content-type': spec.contentType });
        res.write(firstHalf(spec.fixtures.text));
      });
      for await (const event of provider.stream(
        spec.request,
        credential,
        new AbortController().signal,
      )) {
        expect(event.type).not.toBe('error');
        break;
      }
      await fake.waitForNoSockets();
    });

    it.each([
      [401, 'auth', false],
      [429, 'rate_limit', true],
      [500, 'server', true],
    ] as const)('maps HTTP %i to %s with retryable=%s', async (status, kind, retryable) => {
      const { provider, credential } = await serve((res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(spec.errorBody(status));
      });
      const events = await collect(
        provider.stream(spec.request, credential, new AbortController().signal),
      );
      expect(events).toEqual([
        {
          type: 'error',
          error: expect.objectContaining({
            kind,
            status,
            retryable,
            providerId: spec.providerId,
          }) as unknown,
        },
      ]);
    });

    describe('reasoning replay', () => {
      const { replay } = spec;
      const model = spec.request.model;
      const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
      const answer = (part: ContentPart): Message => ({
        role: 'assistant',
        content: [part, { type: 'text', text: 'ok' }],
      });
      // Unique tokens, so presence in the serialized body proves the part was replayed.
      const SAME_MODEL = 'TOKEN_SAME_MODEL_7f3a';
      const OTHER_MODEL = 'TOKEN_OTHER_MODEL_2c9e';
      const OTHER_PROVIDER = 'TOKEN_OTHER_PROVIDER_5b1d';
      const IN_PROGRESS = 'TOKEN_IN_PROGRESS_8e4c';
      const history: Message[] = [
        user('q1'),
        answer(replay.reasoningPart(spec.providerId, `${model}-previous`, OTHER_MODEL)),
        user('q2'),
        answer(replay.reasoningPart('some-other-provider', 'their-model', OTHER_PROVIDER)),
        user('q3'),
        answer(replay.reasoningPart(spec.providerId, model, SAME_MODEL)),
        user('q4'),
        {
          role: 'assistant',
          content: [
            replay.reasoningPart(spec.providerId, model, IN_PROGRESS),
            { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'tool_result', callId: 'call_1', output: 'x', isError: false }],
        },
      ];
      const replayed = (request: ModelRequest): string[] => {
        const body = JSON.stringify(replay.build(request));
        return [OTHER_MODEL, OTHER_PROVIDER, SAME_MODEL, IN_PROGRESS].filter((token) =>
          body.includes(token),
        );
      };

      it(`replays per its documented rule (${replay.matchesOn}) across a same-provider model switch`, () => {
        const expected =
          replay.matchesOn === 'provider'
            ? [OTHER_MODEL, SAME_MODEL, IN_PROGRESS]
            : replay.matchesOn === 'provider+model'
              ? [SAME_MODEL, IN_PROGRESS]
              : [];
        expect(replayed({ ...spec.request, messages: history })).toEqual(expected);
      });

      it('never replays reasoning from another provider', () => {
        expect(replayed({ ...spec.request, messages: history })).not.toContain(OTHER_PROVIDER);
      });

      it("keeps only the in-progress tool-use turn's reasoning with reasoningReplay 'drop'", () => {
        expect(replayed({ ...spec.request, messages: history, reasoningReplay: 'drop' })).toEqual(
          replay.matchesOn === 'none' ? [] : [IN_PROGRESS],
        );
      });

      if (replay.matchesOn === 'provider') {
        it('never removes reasoning from the middle of history while keeping a later part', () => {
          // A switch keeps every earlier part: dropping one from the middle would be an edit that
          // invalidates the later ones (Anthropic preserved thinking).
          const kept = replayed({ ...spec.request, messages: history });
          expect(kept.slice(0, 2)).toEqual([OTHER_MODEL, SAME_MODEL]);
        });
      } else {
        it('drops other-model reasoning, which this vendor does not treat as a history edit', () => {
          expect(replayed({ ...spec.request, messages: history })).not.toContain(OTHER_MODEL);
        });
      }
    });

    it('refuses a credential for another provider before any I/O', async () => {
      const { fake, provider, credential } = await serve((res) => {
        res.end();
      });
      let revealed = false;
      const foreign: ProviderCredential = {
        ...credential,
        providerId: `${spec.providerId}-other`,
        reveal: () => {
          revealed = true;
          return 'x';
        },
      };
      const events = await collect(
        provider.stream(spec.request, foreign, new AbortController().signal),
      );
      expect(events).toEqual([
        {
          type: 'error',
          error: expect.objectContaining({ kind: 'credential_mismatch' }) as unknown,
        },
      ]);
      expect(fake.requests).toHaveLength(0);
      expect(revealed).toBe(false);
    });
  });
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  assertContract(events);
  return events;
}

function assertContract(events: readonly ModelEvent[]): void {
  for (const event of events) ModelEventSchema.parse(event);
  expect(checkModelEventOrder(events)).toEqual([]);
  expect(events.filter((event) => event.type === 'done' || event.type === 'error')).toHaveLength(1);
}

function textOf(events: readonly ModelEvent[]): string {
  return events.map((event) => (event.type === 'text_delta' ? event.text : '')).join('');
}

/**
 * The first half of a body, cut just after an event boundary (a blank line for SSE, a newline for
 * NDJSON). Fixtures stream their text in several deltas so this half holds at least one.
 */
function firstHalf(body: string): string {
  const half = Math.floor(body.length / 2);
  const blank = body.indexOf('\n\n', half);
  if (blank !== -1) return body.slice(0, blank + 2);
  const line = body.indexOf('\n', half);
  return line === -1 ? body.slice(0, half) : body.slice(0, line + 1);
}
