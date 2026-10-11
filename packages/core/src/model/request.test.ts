import { describe, expect, it } from 'vitest';
import { ModelRequestSchema, ToolSpecSchema } from './request.ts';

const user = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
const system = { role: 'system', content: [{ type: 'text', text: 'be brief' }] };
const spec = { name: 'read_file', description: 'Reads a file.', inputSchema: { type: 'object' } };
const base = { model: 'claude-sonnet-5-5', messages: [user], maxOutputTokens: 1024 };

describe('ToolSpecSchema', () => {
  it('accepts a spec with a JSON Schema object', () => {
    expect(ToolSpecSchema.safeParse(spec).success).toBe(true);
    expect(
      ToolSpecSchema.safeParse({
        ...spec,
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      }).success,
    ).toBe(true);
  });

  it.each(['a', 'read_file', 'mcp__server__tool', 'A-b_9', 'x'.repeat(64)])(
    'accepts the tool name %j',
    (name) => {
      expect(ToolSpecSchema.safeParse({ ...spec, name }).success).toBe(true);
    },
  );

  it.each(['', 'has space', 'dot.name', 'slash/name', 'ünïcode', 'x'.repeat(65)])(
    'rejects the tool name %j (strictest common vendor rule)',
    (name) => {
      expect(ToolSpecSchema.safeParse({ ...spec, name }).success).toBe(false);
    },
  );

  it('rejects an empty description, a non-object schema and extra fields', () => {
    expect(ToolSpecSchema.safeParse({ ...spec, description: '' }).success).toBe(false);
    expect(ToolSpecSchema.safeParse({ ...spec, inputSchema: [] }).success).toBe(false);
    expect(ToolSpecSchema.safeParse({ ...spec, inputSchema: 'object' }).success).toBe(false);
    expect(ToolSpecSchema.safeParse({ ...spec, strict: true }).success).toBe(false);
  });
});

describe('ModelRequestSchema', () => {
  it('accepts the minimal request', () => {
    expect(ModelRequestSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a fully specified request', () => {
    const request = {
      ...base,
      messages: [system, user],
      tools: [spec, { ...spec, name: 'write_file' }],
      toolChoice: 'auto',
      reasoning: { effort: 'high', visibility: 'summary' },
      stopSequences: ['END'],
      reasoningReplay: 'drop',
    };
    expect(ModelRequestSchema.safeParse(request).success).toBe(true);
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('accepts reasoning effort %s', (effort) => {
    expect(ModelRequestSchema.safeParse({ ...base, reasoning: { effort } }).success).toBe(true);
  });

  it.each(['summary', 'hidden'])('accepts reasoning visibility %s', (visibility) => {
    expect(ModelRequestSchema.safeParse({ ...base, reasoning: { visibility } }).success).toBe(true);
  });

  it.each(['preserve', 'drop'])('accepts reasoningReplay %s', (reasoningReplay) => {
    expect(ModelRequestSchema.safeParse({ ...base, reasoningReplay }).success).toBe(true);
  });

  it('requires at least one non-system message', () => {
    expect(ModelRequestSchema.safeParse({ ...base, messages: [] }).success).toBe(false);
    expect(ModelRequestSchema.safeParse({ ...base, messages: [system] }).success).toBe(false);
    expect(ModelRequestSchema.safeParse({ ...base, messages: [system, system] }).success).toBe(
      false,
    );
  });

  it('allows a mid-conversation system message after the first non-system message', () => {
    const request = {
      ...base,
      messages: [system, user, { role: 'assistant', content: [] }, system],
    };
    expect(ModelRequestSchema.safeParse(request).success).toBe(true);
  });

  it('requires a positive integer maxOutputTokens (the agent picks it from ModelInfo)', () => {
    const without = { model: base.model, messages: base.messages };
    expect(ModelRequestSchema.safeParse(without).success).toBe(false);
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(ModelRequestSchema.safeParse({ ...base, maxOutputTokens: value }).success).toBe(false);
    }
  });

  it('requires a model id', () => {
    expect(ModelRequestSchema.safeParse({ ...base, model: '' }).success).toBe(false);
  });

  it('requires unique tool names', () => {
    expect(ModelRequestSchema.safeParse({ ...base, tools: [spec, spec] }).success).toBe(false);
  });

  it.each([
    ['forced tool use: any', { toolChoice: 'any' }],
    ['forced tool use: tool', { toolChoice: 'tool' }],
    ['forced tool use: an object', { toolChoice: { type: 'tool', name: 'read_file' } }],
    ['temperature', { temperature: 0.2 }],
    ['top_p', { top_p: 0.9 }],
    ['an unknown reasoning effort', { reasoning: { effort: 'ultra' } }],
    ['an unknown reasoning visibility', { reasoning: { visibility: 'full' } }],
    ['an unknown reasoning field', { reasoning: { budgetTokens: 1000 } }],
    ['an unknown reasoningReplay', { reasoningReplay: 'rewrite' }],
    ['an empty stop sequence', { stopSequences: [''] }],
    ['an unknown field', { stream: true }],
  ])('rejects %s', (_name, patch) => {
    expect(ModelRequestSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it('validates the messages it carries', () => {
    const bad = { role: 'tool', content: [{ type: 'text', text: 'not a result' }] };
    expect(ModelRequestSchema.safeParse({ ...base, messages: [user, bad] }).success).toBe(false);
  });
});
