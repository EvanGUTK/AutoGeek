import type { ZodType } from 'zod';
import { z } from 'zod';
import { ToolOutputSchema } from './content.ts';
import type { ToolOutput } from './content.ts';
import { JsonValueSchema } from './json.ts';
import type { PermissionGate, ToolRisk } from './permissions.ts';

/** What the loop hands every tool call: cancellation and a call-scoped permission gate. */
export interface ToolContext {
  readonly signal: AbortSignal;
  /** Call once per effect, before performing it. Treat anything but `allow` as a refusal. */
  readonly gate: PermissionGate;
}

/**
 * The model-facing result is measurable and truncatable; `structured` is for the UI and agent
 * events only and is never sent to the model.
 */
export interface ToolResult<O = unknown> {
  readonly content: ToolOutput;
  readonly truncated: boolean;
  readonly isError: boolean;
  readonly structured?: O;
}

/** Transport form of a result (events, IPC): `structured` must be JSON. */
export const ToolResultSchema = z.strictObject({
  content: ToolOutputSchema,
  truncated: z.boolean(),
  isError: z.boolean(),
  structured: JsonValueSchema.optional(),
});

export interface Tool<I, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<I>;
  readonly risk: ToolRisk;
  run(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

export interface TextResultOptions<O> {
  readonly truncated?: boolean;
  readonly structured?: O;
}

export function textResult<O = never>(
  text: string,
  options: TextResultOptions<O> = {},
): ToolResult<O> {
  const base = { content: text, truncated: options.truncated ?? false, isError: false };
  return options.structured === undefined ? base : { ...base, structured: options.structured };
}

/** A failure the model should see and may recover from (not a thrown programmer error). */
export function errorResult(message: string): ToolResult<never> {
  return { content: message, truncated: false, isError: true };
}
