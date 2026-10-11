import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConformanceSuite } from '../../testing/conformance.ts';
import { anthropicProfile } from './models.ts';
import { ANTHROPIC_ORIGIN, createAnthropicProvider } from './provider.ts';
import { buildAnthropicBody } from './request.ts';

// Doc-derived fixtures (shapes from https://platform.claude.com/docs/en/build-with-claude/streaming.md);
// re-record from the real API with the opt-in smoke tests when the wire format changes.
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', `${name}.sse`), 'utf8');

const ERROR_TYPES: Readonly<Record<number, string>> = {
  401: 'authentication_error',
  429: 'rate_limit_error',
  500: 'api_error',
};

defineConformanceSuite({
  name: 'anthropic',
  providerId: 'anthropic',
  fixedOrigin: ANTHROPIC_ORIGIN,
  create: (deps) => createAnthropicProvider(deps),
  credential: () => ({
    credentialId: 'cred_anthropic',
    providerId: 'anthropic',
    kind: 'api_key',
    baseUrl: ANTHROPIC_ORIGIN,
    reveal: () => 'sk-ant-api03-CONFORMANCE',
  }),
  request: {
    model: 'claude-opus-5-5',
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
      type: 'error',
      error: { type: ERROR_TYPES[status] ?? 'api_error', message: 'conformance' },
    }),
  replay: {
    matchesOn: 'provider',
    build: (request) => buildAnthropicBody(request, anthropicProfile(request.model)),
    reasoningPart: (providerId, modelId, token) => ({
      type: 'reasoning',
      text: 'thinking',
      providerMetadata: { origin: { providerId, modelId }, data: { signature: token } },
    }),
  },
});
