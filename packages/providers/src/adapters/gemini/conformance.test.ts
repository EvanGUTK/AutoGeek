import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConformanceSuite } from '../../testing/conformance.ts';
import { geminiProfile } from './models.ts';
import { GEMINI_ORIGIN, createGeminiProvider } from './provider.ts';
import { buildGeminiBody } from './request.ts';

// Doc-derived fixtures (shapes from https://ai.google.dev/api/generate-content and the
// thought-signatures guide, CRLF framed); re-record with the opt-in smoke tests.
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', `${name}.sse`), 'utf8');

const STATUS: Readonly<Record<number, string>> = {
  401: 'UNAUTHENTICATED',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
};

defineConformanceSuite({
  name: 'gemini',
  providerId: 'google',
  fixedOrigin: GEMINI_ORIGIN,
  create: (deps) => createGeminiProvider(deps),
  credential: () => ({
    credentialId: 'cred_google',
    providerId: 'google',
    kind: 'api_key',
    baseUrl: GEMINI_ORIGIN,
    reveal: () => 'AIzaSyCONFORMANCECONFORMANCE000000',
  }),
  request: {
    model: 'gemini-3.8-flash',
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
    truncatedToolCall: {
      notApplicable:
        'The Gemini Developer API delivers each functionCall whole (no streamed arguments), so a call is never cut mid-arguments; MAX_TOKENS ends the turn as max_tokens.',
    },
  },
  expectedText: 'The answer is 42.',
  expectedToolCalls: [
    { name: 'read_file', input: { path: 'a.ts' } },
    { name: 'read_file', input: { path: 'b.ts' } },
  ],
  errorBody: (status) =>
    JSON.stringify({
      error: { code: status, message: 'conformance', status: STATUS[status] ?? 'INTERNAL' },
    }),
  replay: {
    matchesOn: 'provider+model',
    build: (request) => buildGeminiBody(request, geminiProfile(request.model)),
    reasoningPart: (providerId, modelId, token) => ({
      type: 'reasoning',
      text: 'summary',
      providerMetadata: { origin: { providerId, modelId }, data: { thoughtSignature: token } },
    }),
  },
});
