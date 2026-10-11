import { z } from 'zod';
import { JsonObjectSchema } from './json.ts';
import { AgentModeSchema } from './mode.ts';

export const ToolRiskSchema = z.enum(['read', 'write', 'exec', 'network']);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

const FsReadAction = z.strictObject({
  kind: z.literal('fs_read'),
  /** The realpath the tool resolved, never the model-supplied string. */
  path: z.string().min(1),
  /** True for `.env*`, key files, `.git/config` and the like (ARCHITECTURE.md §8.3). */
  sensitive: z.boolean(),
});

export const FS_WRITE_OPS = ['create', 'modify', 'delete', 'rename'] as const;

const FsWriteAction = z
  .strictObject({
    kind: z.literal('fs_write'),
    path: z.string().min(1),
    sensitive: z.boolean(),
    op: z.enum(FS_WRITE_OPS),
    /** Destination realpath; present exactly when `op` is `rename`. */
    to: z.string().min(1).optional(),
  })
  .refine((action) => (action.op === 'rename') === (action.to !== undefined), {
    message: '`to` is required for rename and forbidden for every other op',
    path: ['to'],
  });

export const EXEC_CLASSES = ['read_only', 'mutating', 'network', 'destructive', 'unknown'] as const;

const ExecAction = z.strictObject({
  kind: z.literal('exec'),
  /** Program and arguments, never a shell string. */
  argv: z.tuple([z.string().min(1)], z.string()),
  cwd: z.string().min(1),
  class: z.enum(EXEC_CLASSES),
});

/** A shell string. There is deliberately no `class` field: shell commands are always `unknown`. */
const ExecShellAction = z.strictObject({
  kind: z.literal('exec_shell'),
  command: z.string().min(1),
  cwd: z.string().min(1),
});

/** http(s) only, no embedded credentials. Unlike `z.httpUrl()` this accepts `localhost`. */
function isCredentialFreeHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === ''
  );
}

const NetworkAction = z.strictObject({
  kind: z.literal('network'),
  url: z
    .string()
    .refine(isCredentialFreeHttpUrl, { message: 'expected an http(s) URL without credentials' }),
});

const McpAction = z.strictObject({
  kind: z.literal('mcp'),
  server: z.string().min(1),
  tool: z.string().min(1),
  input: JsonObjectSchema,
});

export const PermissionActionSchema = z.discriminatedUnion('kind', [
  FsReadAction,
  FsWriteAction,
  ExecAction,
  ExecShellAction,
  NetworkAction,
  McpAction,
]);
export type PermissionAction = z.infer<typeof PermissionActionSchema>;

/**
 * What a TOOL asks the gate, once per effect. Only the tool knows the realpath, sensitivity and
 * command class, so it builds the precise action. `literal` is the exact, tool-built text shown
 * in approval prompts; it is never model prose. Tools cannot supply provenance (strict schema).
 */
export const PermissionRequestInputSchema = z.strictObject({
  tool: z.string().min(1),
  risk: ToolRiskSchema,
  action: PermissionActionSchema,
  literal: z.string().min(1),
});
export type PermissionRequestInput = z.infer<typeof PermissionRequestInputSchema>;

/** A request stamped with provenance by the loop's call-scoped gate wrapper. */
export const PermissionRequestSchema = PermissionRequestInputSchema.extend({
  runId: z.string().min(1),
  callId: z.string().min(1),
  mode: AgentModeSchema,
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const PERMISSION_DENY_REASONS = [
  'policy',
  'user',
  'mode',
  'untrusted_workspace',
  'aborted',
] as const;

export const PermissionDecisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('allow') }),
  z.strictObject({ decision: z.literal('deny'), reason: z.enum(PERMISSION_DENY_REASONS) }),
]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export interface PermissionGate {
  /** May await a human. Resolves `deny`/`aborted` if `signal` aborts while waiting. */
  check(request: PermissionRequestInput, signal: AbortSignal): Promise<PermissionDecision>;
}

/** The safe default: deny everything. When in doubt, deny. */
export const denyAllGate: PermissionGate = {
  check(_request, signal) {
    return Promise.resolve<PermissionDecision>({
      decision: 'deny',
      reason: signal.aborted ? 'aborted' : 'policy',
    });
  },
};
