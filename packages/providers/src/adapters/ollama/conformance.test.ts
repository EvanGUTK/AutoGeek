import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConformanceSuite } from '../../testing/conformance.ts';
import { createOllamaProvider } from './provider.ts';
import { buildOllamaBody } from './request.ts';

// Doc-derived fixtures (shapes from https://github.com/ollama/ollama/blob/main/docs/api.md and
// docs/capabilities/tool-calling.mdx); re-record with the opt-in smoke tests.
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', `${name}.ndjson`), 'utf8');

const SHOW = JSON.stringify({
  capabilities: ['completion', 'tools', 'thinking'],
  model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 },
  thinking: { values: [true, false] },
});

defineConformanceSuite({
  name: 'ollama',
  providerId: 'ollama',
  create: (deps) => createOllamaProvider(deps),
  credential: (serverOrigin) => ({
    credentialId: 'cred_ollama',
    providerId: 'ollama',
    kind: 'none',
    baseUrl: serverOrigin,
    reveal: () => '',
  }),
  request: {
    model: 'qwen3:8b',
    maxOutputTokens: 1024,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is the answer?' }] }],
  },
  contentType: 'application/x-ndjson',
  fixtures: {
    text: fixture('text'),
    toolCall: fixture('tool-call'),
    parallelToolCalls: fixture('parallel-tool-calls'),
    malformedToolJson: fixture('malformed-tool-json'),
    unknownFields: fixture('unknown-fields'),
    truncatedToolCall: {
      notApplicable:
        'Ollama delivers each tool call whole with object arguments, so a call is never cut mid-arguments; done_reason "length" ends the turn as max_tokens.',
    },
  },
  expectedText: 'The answer is 42.',
  expectedToolCalls: [
    { name: 'read_file', input: { path: 'a.ts' } },
    { name: 'read_file', input: { path: 'b.ts' } },
  ],
  errorBody: (status) => JSON.stringify({ error: `conformance ${String(status)}` }),
  auxiliary: (path) => (path === '/api/show' ? { status: 200, body: SHOW } : undefined),
  replay: {
    matchesOn: 'provider+model',
    build: (request) => buildOllamaBody(request, { thinking: 'boolean', numCtx: 40960 }),
    reasoningPart: (providerId, modelId, token) => ({
      type: 'reasoning',
      text: token,
      providerMetadata: { origin: { providerId, modelId }, data: {} },
    }),
  },
});
