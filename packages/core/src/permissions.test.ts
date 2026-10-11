import { describe, expect, it } from 'vitest';
import {
  PermissionDecisionSchema,
  PermissionRequestInputSchema,
  PermissionRequestSchema,
  denyAllGate,
} from './permissions.ts';
import type { PermissionRequestInput } from './permissions.ts';

const base = { tool: 'read_file', risk: 'read' } as const;

const validInputs: readonly PermissionRequestInput[] = [
  {
    ...base,
    action: { kind: 'fs_read', path: '/ws/a.ts', sensitive: false },
    literal: 'read /ws/a.ts',
  },
  {
    tool: 'write_file',
    risk: 'write',
    action: { kind: 'fs_write', path: '/ws/a.ts', sensitive: false, op: 'modify' },
    literal: 'write /ws/a.ts',
  },
  {
    tool: 'write_file',
    risk: 'write',
    action: { kind: 'fs_write', path: '/ws/a.ts', sensitive: false, op: 'rename', to: '/ws/b.ts' },
    literal: 'rename /ws/a.ts -> /ws/b.ts',
  },
  {
    tool: 'run_command',
    risk: 'exec',
    action: { kind: 'exec', argv: ['git', 'status'], cwd: '/ws', class: 'read_only' },
    literal: 'git status',
  },
  {
    tool: 'run_command',
    risk: 'exec',
    action: { kind: 'exec_shell', command: 'ls | wc -l', cwd: '/ws' },
    literal: 'ls | wc -l',
  },
  {
    tool: 'fetch_url',
    risk: 'network',
    action: { kind: 'network', url: 'https://example.com/x' },
    literal: 'GET https://example.com/x',
  },
  {
    tool: 'mcp__srv__tool',
    risk: 'network',
    action: { kind: 'mcp', server: 'srv', tool: 'tool', input: { q: 'x' } },
    literal: 'srv.tool({"q":"x"})',
  },
];

describe('PermissionRequestInputSchema', () => {
  it.each(validInputs.map((input) => [input.action.kind, input] as const))(
    'accepts a valid %s request',
    (_kind, input) => {
      expect(PermissionRequestInputSchema.safeParse(input).success).toBe(true);
    },
  );

  const valid = validInputs[0];
  if (valid === undefined) {
    throw new Error('fixture list is empty');
  }

  it('rejects unknown action kinds and risks', () => {
    expect(
      PermissionRequestInputSchema.safeParse({ ...valid, action: { kind: 'teleport' } }).success,
    ).toBe(false);
    expect(PermissionRequestInputSchema.safeParse({ ...valid, risk: 'admin' }).success).toBe(false);
  });

  it('requires a tool-built literal and a tool name', () => {
    expect(PermissionRequestInputSchema.safeParse({ ...valid, literal: '' }).success).toBe(false);
    expect(PermissionRequestInputSchema.safeParse({ ...valid, tool: '' }).success).toBe(false);
    const withoutLiteral = { tool: valid.tool, risk: valid.risk, action: valid.action };
    expect(PermissionRequestInputSchema.safeParse(withoutLiteral).success).toBe(false);
  });

  it('rejects extra fields so provenance cannot be smuggled in by a tool', () => {
    expect(
      PermissionRequestInputSchema.safeParse({ ...valid, runId: 'r1', callId: 'c1' }).success,
    ).toBe(false);
  });

  it.each(validInputs.map((input) => [input.action.kind, input] as const))(
    'rejects unknown fields on a %s action',
    (_kind, input) => {
      const padded = { ...input, action: { ...input.action, extra: 'smuggled' } };
      expect(PermissionRequestInputSchema.safeParse(padded).success).toBe(false);
    },
  );

  it('requires a non-empty argv for exec', () => {
    const exec = { kind: 'exec', argv: [], cwd: '/ws', class: 'unknown' };
    expect(PermissionRequestInputSchema.safeParse({ ...valid, action: exec }).success).toBe(false);
    const emptyProgram = { ...exec, argv: [''] };
    expect(PermissionRequestInputSchema.safeParse({ ...valid, action: emptyProgram }).success).toBe(
      false,
    );
  });

  it('does not let exec_shell claim a command class: shell commands are always unknown', () => {
    const shell = { kind: 'exec_shell', command: 'ls', cwd: '/ws', class: 'read_only' };
    expect(PermissionRequestInputSchema.safeParse({ ...valid, action: shell }).success).toBe(false);
  });

  it('requires `to` exactly for rename', () => {
    const write = (op: string, to?: string): unknown => ({
      ...valid,
      action: {
        kind: 'fs_write',
        path: '/ws/a',
        sensitive: false,
        op,
        ...(to === undefined ? {} : { to }),
      },
    });
    expect(PermissionRequestInputSchema.safeParse(write('rename')).success).toBe(false);
    expect(PermissionRequestInputSchema.safeParse(write('modify', '/ws/b')).success).toBe(false);
    expect(PermissionRequestInputSchema.safeParse(write('rename', '/ws/b')).success).toBe(true);
    expect(PermissionRequestInputSchema.safeParse(write('delete')).success).toBe(true);
  });

  it('requires an http(s) url for network actions', () => {
    const network = (url: string): unknown => ({ ...valid, action: { kind: 'network', url } });
    expect(PermissionRequestInputSchema.safeParse(network('https://a.test/')).success).toBe(true);
    expect(PermissionRequestInputSchema.safeParse(network('http://localhost:1/')).success).toBe(
      true,
    );
    expect(PermissionRequestInputSchema.safeParse(network('file:///etc/passwd')).success).toBe(
      false,
    );
    expect(PermissionRequestInputSchema.safeParse(network('not a url')).success).toBe(false);
  });

  it('rejects urls with embedded credentials so secrets never reach prompts or audit logs', () => {
    const network = (url: string): unknown => ({ ...valid, action: { kind: 'network', url } });
    expect(PermissionRequestInputSchema.safeParse(network('https://user:pw@a.test/')).success).toBe(
      false,
    );
    expect(PermissionRequestInputSchema.safeParse(network('https://token@a.test/')).success).toBe(
      false,
    );
  });
});

describe('PermissionRequestSchema', () => {
  const input = validInputs[0];
  if (input === undefined) {
    throw new Error('fixture list is empty');
  }

  it('is an input plus provenance stamped by the loop', () => {
    const request = { ...input, runId: 'run-1', callId: 'call-1', mode: 'agent' };
    expect(PermissionRequestSchema.safeParse(request).success).toBe(true);
  });

  it('rejects requests without provenance or with an unknown mode', () => {
    expect(PermissionRequestSchema.safeParse(input).success).toBe(false);
    expect(
      PermissionRequestSchema.safeParse({ ...input, runId: 'r', callId: 'c', mode: 'root' })
        .success,
    ).toBe(false);
  });
});

describe('PermissionDecisionSchema', () => {
  it('accepts allow, and deny with a closed reason', () => {
    expect(PermissionDecisionSchema.safeParse({ decision: 'allow' }).success).toBe(true);
    for (const reason of ['policy', 'user', 'mode', 'untrusted_workspace', 'aborted']) {
      expect(PermissionDecisionSchema.safeParse({ decision: 'deny', reason }).success).toBe(true);
    }
  });

  it('rejects a deny without a reason, an unknown reason, and an allow carrying a reason', () => {
    expect(PermissionDecisionSchema.safeParse({ decision: 'deny' }).success).toBe(false);
    expect(
      PermissionDecisionSchema.safeParse({ decision: 'deny', reason: 'because' }).success,
    ).toBe(false);
    expect(PermissionDecisionSchema.safeParse({ decision: 'allow', reason: 'user' }).success).toBe(
      false,
    );
  });
});

describe('denyAllGate', () => {
  const input = validInputs[0];
  if (input === undefined) {
    throw new Error('fixture list is empty');
  }

  it('denies everything by policy (default-deny)', async () => {
    await expect(denyAllGate.check(input, new AbortController().signal)).resolves.toEqual({
      decision: 'deny',
      reason: 'policy',
    });
  });

  it('reports an aborted signal as aborted', async () => {
    await expect(denyAllGate.check(input, AbortSignal.abort())).resolves.toEqual({
      decision: 'deny',
      reason: 'aborted',
    });
  });
});
