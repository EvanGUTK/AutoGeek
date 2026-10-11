import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConformanceSuite } from '../../testing/conformance.ts';
import { openaiProfile } from './models.ts';
import { OPENAI_ORIGIN, createOpenAIProvider } from './provider.ts';
import { buildOpenAIBody } from './request.ts';

// Doc-derived fixtures (shapes from https://developers.openai.com/api/docs/guides/streaming-responses.md
// and the openai-node ResponseStreamEvent types); re-record with the opt-in smoke tests.
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', `${name}.sse`), 'utf8');

defineConformanceSuite({
  name: 'openai',
  providerId: 'openai',
  fixedOrigin: OPENAI_ORIGIN,
  create: (deps) => createOpenAIProvider(deps),
  credential: () => ({
    credentialId: 'cred_openai',
    providerId: 'openai',
    kind: 'api_key',
    baseUrl: OPENAI_ORIGIN,
    reveal: () => 'sk-proj-CONFORMANCE',
  }),
  request: {
    model: 'gpt-5.5',
    maxOutputTokens: 1024,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is the answer?' }] }],
  },
  contentType: 'text/event-stream',
  fixtures: {
    text: fixture('text'),
    toolCall: fixture('tool-call'),
    parallelToolCalls: fixture('parallel-tool-calls'),
    malformedToolJson: fixture('malformed-tool-json'),
    unknownFields: fixture('unknown-fields'),
    truncatedToolCall: fixture('truncated-tool-call'),
  },
  expectedText: 'The answer is 42.',
  expectedToolCalls: [
    { name: 'read_file', input: { path: 'a.ts' } },
    { name: 'read_file', input: { path: 'b.ts' } },
  ],
  errorBody: (status) =>
    JSON.stringify({
      error: {
        message: 'conformance',
        type: status === 401 ? 'invalid_request_error' : 'server_error',
        param: null,
        code: null,
      },
    }),
  replay: {
    matchesOn: 'provider+model',
    build: (request) => buildOpenAIBody(request, openaiProfile(request.model)),
    reasoningPart: (providerId, modelId, token) => ({
      type: 'reasoning',
      text: 'summary',
      providerMetadata: {
        origin: { providerId, modelId },
        data: { item: { type: 'reasoning', id: 'rs_x', summary: [], encrypted_content: token } },
      },
    }),
  },
});
