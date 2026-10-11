import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { denyAllGate } from './permissions.ts';
import { errorResult, textResult, ToolResultSchema } from './tool.ts';
import type { Tool, ToolContext, ToolResult } from './tool.ts';

describe('textResult', () => {
  it('builds a successful, untruncated result by default', () => {
    expect(textResult('done')).toEqual({ content: 'done', truncated: false, isError: false });
  });

  it('carries truncation and structured data when given', () => {
    expect(textResult('partial', { truncated: true, structured: { lines: 3 } })).toEqual({
      content: 'partial',
      truncated: true,
      isError: false,
      structured: { lines: 3 },
    });
  });
});

describe('errorResult', () => {
  it('marks the result as an error without truncation', () => {
    expect(errorResult('no such file')).toEqual({
      content: 'no such file',
      truncated: false,
      isError: true,
    });
  });
});

describe('ToolResultSchema', () => {
  it('accepts string and block content with optional JSON structured data', () => {
    expect(ToolResultSchema.safeParse(textResult('ok')).success).toBe(true);
    expect(
      ToolResultSchema.safeParse({
        content: [{ type: 'text', text: 'ok' }],
        truncated: false,
        isError: false,
        structured: { a: [1] },
      }).success,
    ).toBe(true);
  });

  it('rejects missing flags, bad content and non-JSON structured data', () => {
    expect(ToolResultSchema.safeParse({ content: 'ok', isError: false }).success).toBe(false);
    expect(
      ToolResultSchema.safeParse({ content: 1, truncated: false, isError: false }).success,
    ).toBe(false);
    expect(
      ToolResultSchema.safeParse({
        content: 'ok',
        truncated: false,
        isError: false,
        structured: () => 1,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(
      ToolResultSchema.safeParse({ content: 'ok', truncated: false, isError: false, extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe('Tool', () => {
  const lengthTool: Tool<{ text: string }, { length: number }> = {
    name: 'text_length',
    description: 'Counts characters.',
    inputSchema: z.object({ text: z.string() }),
    risk: 'read',
    async run(input, ctx): Promise<ToolResult<{ length: number }>> {
      const decision = await ctx.gate.check(
        {
          tool: 'text_length',
          risk: 'read',
          action: { kind: 'fs_read', path: '/ws/x', sensitive: false },
          literal: 'read /ws/x',
        },
        ctx.signal,
      );
      if (decision.decision === 'deny') {
        return errorResult(`denied: ${decision.reason}`);
      }
      return textResult(String(input.text.length), { structured: { length: input.text.length } });
    },
  };

  it('can be implemented against the contract and honors a denying gate', async () => {
    const context: ToolContext = { signal: new AbortController().signal, gate: denyAllGate };
    const result = await lengthTool.run({ text: 'abc' }, context);
    expect(result).toEqual({ content: 'denied: policy', truncated: false, isError: true });
  });

  it('validates input with its own schema', () => {
    expect(lengthTool.inputSchema.safeParse({ text: 1 }).success).toBe(false);
    expect(lengthTool.inputSchema.parse({ text: 'ab' })).toEqual({ text: 'ab' });
  });
});
