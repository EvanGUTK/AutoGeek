import { z } from 'zod';
import { ImageBlockSchema, ToolOutputSchema } from '../content.ts';
import { JsonObjectSchema, JsonValueSchema } from '../json.ts';

/**
 * Opaque per-adapter data (thinking signatures, redacted reasoning, encrypted reasoning items,
 * Gemini thought signatures, message item ids, ...). Only the adapter whose `origin.providerId`
 * matches may read `data`; every other component stores and replays it untouched.
 *
 * ORIGIN MATCHING IS ADAPTER-DEFINED: each adapter documents whether it matches on provider or on
 * provider+model, per its vendor's replay rules (Anthropic keeps every Anthropic-origin block
 * across a Claude to Claude model switch, because the API ignores unreadable ones and removing
 * blocks from the middle of history would be an edit; Gemini and OpenAI may match
 * provider+model). Parts whose origin the adapter rejects are dropped (for reasoning, the whole
 * part), and that choice must never turn into a mid-history edit the vendor treats as invalidating.
 *
 * The data must be JSON because checkpoints persist it.
 */
export const ProviderMetadataSchema = z.strictObject({
  origin: z.strictObject({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
  }),
  data: JsonValueSchema,
});
export type ProviderMetadata = z.infer<typeof ProviderMetadataSchema>;

const TextPart = z.strictObject({
  type: z.literal('text'),
  text: z.string(),
  providerMetadata: ProviderMetadataSchema.optional(),
});

const ToolCallPart = z.strictObject({
  type: z.literal('tool_call'),
  id: z.string().min(1),
  name: z.string().min(1),
  /** Always a JSON object: every vendor requires one, and invalid calls are replayed as `{}`. */
  input: JsonObjectSchema,
  providerMetadata: ProviderMetadataSchema.optional(),
});

const ToolResultPart = z.strictObject({
  type: z.literal('tool_result'),
  callId: z.string().min(1),
  output: ToolOutputSchema,
  isError: z.boolean(),
});

/** Redacted or omitted reasoning is an empty `text` plus metadata; the UI shows "reasoning hidden". */
const ReasoningPart = z.strictObject({
  type: z.literal('reasoning'),
  text: z.string(),
  providerMetadata: ProviderMetadataSchema.optional(),
});

export const ContentPartSchema = z.discriminatedUnion('type', [
  TextPart,
  ImageBlockSchema,
  ToolCallPart,
  ToolResultPart,
  ReasoningPart,
]);
export type ContentPart = z.infer<typeof ContentPartSchema>;

export const ROLES = ['system', 'user', 'assistant', 'tool'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/**
 * Role semantics (adapter behavior):
 * - The leading run of `system` messages forms the system prompt. A `system` message after the
 *   first non-system message is a mid-conversation operator instruction: Anthropic in-`messages`
 *   system (on supporting models), an OpenAI `developer` message, or, for Gemini and the generic
 *   OpenAI-compatible adapter, a user turn wrapped in a fixed `<system-instruction>` envelope
 *   (lossy; documented).
 * - `tool` messages contain only `tool_result` parts. Adapters map them to the vendor form
 *   (Anthropic user turn, OpenAI `function_call_output` items, Gemini `functionResponse` parts).
 * - `cacheHint` marks a prompt-cache breakpoint after this message; adapters without caching
 *   ignore it.
 */
export const MessageSchema = z
  .strictObject({
    role: RoleSchema,
    content: z.array(ContentPartSchema),
    cacheHint: z.literal('ephemeral').optional(),
  })
  .refine(
    (message) => message.role !== 'tool' || message.content.every((p) => p.type === 'tool_result'),
    {
      message: 'a tool message may contain only tool_result parts',
      path: ['content'],
    },
  );
export type Message = z.infer<typeof MessageSchema>;
