import { z } from 'zod';
import { JsonObjectSchema } from '../json.ts';
import { MessageSchema } from './message.ts';

/** Strictest name rule common to the supported vendors. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export const ToolSpecSchema = z.strictObject({
  name: z.string().regex(TOOL_NAME),
  description: z.string().min(1),
  /** JSON Schema (draft 2020-12 subset); the agent produces it with `z.toJSONSchema`. */
  inputSchema: JsonObjectSchema,
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * What the agent asks a provider for. Left out on purpose:
 *
 * No temperature/top_p and no forced toolChoice ('any'/'tool'): current Anthropic models reject
 * them with HTTP 400. Sampling params were removed on Opus 4.7+/Opus 5.x/Fable 5.x/Sonnet 5;
 * forced tool_choice is rejected on Claude Opus 5.5, Sonnet 5.5, Fable 5.1 ("tool_choice: type
 * "tool" and "any" are not supported for this model."). Re-verify when models change:
 * https://platform.claude.com/docs/en/about-claude/models/migration-guide.md and
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview.md (tool_choice).
 * Verified 2026-10-11. If they are needed later they are added behind a capability flag.
 *
 * History is append-only (loop invariant): preserved, signed reasoning is valid only if the
 * prefix before it (system, tools, earlier messages) is unchanged, so earlier messages are never
 * rewritten in place and mid-conversation operator instructions are appended `system` messages.
 */
export const ModelRequestSchema = z
  .strictObject({
    /** Vendor model id. */
    model: z.string().min(1),
    /** At least one non-system message. */
    messages: z.array(MessageSchema),
    tools: z.array(ToolSpecSchema).optional(),
    toolChoice: z.enum(['auto', 'none']).optional(),
    /** Required: the agent picks it from `ModelInfo`. */
    maxOutputTokens: z.number().int().positive(),
    reasoning: z
      .strictObject({
        /** The adapter maps this to the nearest level the model supports. */
        effort: z.enum(REASONING_EFFORTS).optional(),
        /** Default 'summary' (Anthropic display, OpenAI summary, Gemini includeThoughts). */
        visibility: z.enum(['summary', 'hidden']).optional(),
      })
      .optional(),
    stopSequences: z.array(z.string().min(1)).optional(),
    /**
     * 'preserve' (default): adapters replay reasoning parts byte-exact, dropping foreign-origin
     * ones. 'drop': recovery path, adapters omit reasoning parts from replayed history except
     * where the vendor requires the current in-progress tool-use turn's reasoning (the adapter's
     * responsibility). The loop sets 'drop' only to recover from an `invalid_request` caused by
     * edited history.
     */
    reasoningReplay: z.enum(['preserve', 'drop']).optional(),
  })
  .refine((request) => request.messages.some((message) => message.role !== 'system'), {
    message: 'messages must contain at least one non-system message',
    path: ['messages'],
  })
  .refine(
    (request) => {
      const names = (request.tools ?? []).map((tool) => tool.name);
      return new Set(names).size === names.length;
    },
    { message: 'tool names must be unique', path: ['tools'] },
  );
export type ModelRequest = z.infer<typeof ModelRequestSchema>;
