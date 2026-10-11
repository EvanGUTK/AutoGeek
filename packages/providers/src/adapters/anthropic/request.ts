import type {
  ContentPart,
  ImageMediaType,
  JsonObject,
  Message,
  ModelRequest,
  ProviderMetadata,
  ToolOutput,
} from '@autogeek/core';
import { z } from 'zod';
import {
  inProgressToolTurn,
  messageText,
  splitSystemPrompt,
  systemInstructionEnvelope,
} from '../shared.ts';
import { nearestEffort } from './models.ts';
import type { AnthropicModelProfile, ReasoningEffort } from './models.ts';

export const ANTHROPIC_PROVIDER_ID = 'anthropic';

/** Most cache breakpoints one request may carry; a fifth is a 400 (prompt-caching docs). */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * `providerMetadata.data` of an Anthropic reasoning part: the thinking block's signature, or a
 * redacted_thinking block's opaque data. Both are replayed byte-exact.
 */
export const AnthropicReasoningDataSchema = z.union([
  z.strictObject({ signature: z.string().min(1) }),
  z.strictObject({ redactedData: z.string().min(1) }),
]);

interface CacheControl {
  readonly type: 'ephemeral';
}

interface TextBlock {
  readonly type: 'text';
  readonly text: string;
  cache_control?: CacheControl;
}

interface ImageBlock {
  readonly type: 'image';
  readonly source: {
    readonly type: 'base64';
    readonly media_type: ImageMediaType;
    readonly data: string;
  };
  cache_control?: CacheControl;
}

interface ThinkingBlock {
  readonly type: 'thinking';
  readonly thinking: string;
  readonly signature: string;
}

interface RedactedThinkingBlock {
  readonly type: 'redacted_thinking';
  readonly data: string;
}

interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
  cache_control?: CacheControl;
}

interface ToolResultBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string | (TextBlock | ImageBlock)[];
  readonly is_error?: true;
  cache_control?: CacheControl;
}

export type AnthropicBlock =
  TextBlock | ImageBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock | ToolResultBlock;

type CacheableBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export interface AnthropicMessage {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: AnthropicBlock[];
}

export interface AnthropicTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonObject;
  readonly eager_input_streaming: true;
}

export interface AnthropicBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly stream: true;
  readonly messages: AnthropicMessage[];
  readonly system?: TextBlock[];
  readonly tools?: AnthropicTool[];
  readonly tool_choice?: { readonly type: 'auto' | 'none' };
  readonly thinking?: { readonly type: 'adaptive'; readonly display: 'summarized' | 'omitted' };
  readonly output_config?: { readonly effort: ReasoningEffort };
  readonly stop_sequences?: string[];
}

/**
 * Maps a `ModelRequest` to a Messages API body (https://platform.claude.com/docs/en/api/messages).
 *
 * Deliberately never sent: `temperature`, `top_p`, `top_k` and forced `tool_choice`
 * (`any`/`tool`). Current models reject them with HTTP 400: sampling parameters are rejected
 * from Opus 4.7 on, and forced tool use on Fable 5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5
 * ("tool_choice: type "tool" and "any" are not supported for this model."). See
 * https://platform.claude.com/docs/en/about-claude/models/migration-guide.md and
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview.md. Verified 2026-10-11.
 *
 * Reasoning replay (origin matching on PROVIDER only): every Anthropic-origin thinking block is
 * replayed byte-exact, whichever Claude model produced it. The API drops blocks the current model
 * cannot read, while removing a block from the middle of history would itself be an edit that
 * invalidates every later block under preserved thinking. Reasoning from other providers is
 * dropped (it has no signature to replay). With `reasoningReplay: 'drop'`, thinking is removed
 * from every turn except the in-progress tool-use turn, where the API requires it; removing from
 * the start is not an edit. Preserved-thinking enforcement is account- and date-gated (accounts
 * created on or after 2026-08-31), so we keep history append-only either way:
 * https://platform.claude.com/docs/en/build-with-claude/preserved-thinking.md and
 * https://platform.claude.com/docs/en/build-with-claude/extended-thinking.md ("Preserving
 * thinking blocks").
 */
export function buildAnthropicBody(
  request: ModelRequest,
  profile: AnthropicModelProfile | undefined,
): AnthropicBody {
  const { system, rest } = splitSystemPrompt(request.messages);
  const breakpoints: CacheableBlock[] = [];

  const systemBlocks: TextBlock[] = [];
  for (const message of system) {
    const text = messageText(message);
    if (text === '') continue;
    const block: TextBlock = { type: 'text', text };
    systemBlocks.push(block);
    if (message.cacheHint === 'ephemeral') breakpoints.push(block);
  }

  const keepToolTurn = inProgressToolTurn(rest);
  const preserve = request.reasoningReplay !== 'drop';
  const wire: AnthropicMessage[] = [];
  rest.forEach((message, index) => {
    const mapped = mapMessage(message, {
      replayReasoning: preserve || index === keepToolTurn,
      nativeSystem: profile?.midConversationSystem === true && nativeSystemAllowed(rest, index),
    });
    if (mapped === undefined) return;
    if (message.cacheHint === 'ephemeral') {
      const target = lastCacheable(mapped.content);
      if (target !== undefined) breakpoints.push(target);
    }
    wire.push(mapped);
  });

  for (const block of breakpoints.slice(-MAX_CACHE_BREAKPOINTS)) {
    block.cache_control = { type: 'ephemeral' };
  }

  const tools = request.tools?.map((tool): AnthropicTool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    // Streams each argument as it is generated instead of after server-side buffering. The
    // input may then be invalid or truncated JSON, which the event writer reports as
    // tool_call_invalid. https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming
    eager_input_streaming: true,
  }));
  const effort =
    request.reasoning?.effort === undefined || profile === undefined
      ? undefined
      : nearestEffort(request.reasoning.effort, profile.efforts);

  return {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    stream: true,
    messages: mergeConsecutive(wire),
    ...(systemBlocks.length === 0 ? {} : { system: systemBlocks }),
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    ...(tools === undefined || tools.length === 0 || request.toolChoice === undefined
      ? {}
      : { tool_choice: { type: request.toolChoice } }),
    ...(request.reasoning !== undefined && profile?.adaptiveThinking === true
      ? {
          thinking: {
            type: 'adaptive',
            // The newest models default to "omitted", so a visible summary must be asked for.
            display: request.reasoning.visibility === 'hidden' ? 'omitted' : 'summarized',
          },
        }
      : {}),
    ...(effort === undefined ? {} : { output_config: { effort } }),
    ...(request.stopSequences === undefined || request.stopSequences.length === 0
      ? {}
      : { stop_sequences: [...request.stopSequences] }),
  };
}

/**
 * A native in-`messages` system message must directly follow a user turn (tool results included)
 * and precede an assistant turn or end the array; consecutive system messages are merged by the
 * API, so the decision looks past them to the nearest non-system neighbours and every message of
 * a run gets the same form. Otherwise the message is enveloped as user text.
 * https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
 */
function nativeSystemAllowed(messages: readonly Message[], index: number): boolean {
  const before = messages.slice(0, index).findLast((message) => message.role !== 'system');
  const after = messages.slice(index + 1).find((message) => message.role !== 'system');
  const followsUser = before?.role === 'user' || before?.role === 'tool';
  return followsUser && (after === undefined || after.role === 'assistant');
}

interface MapOptions {
  readonly replayReasoning: boolean;
  /** This mid-conversation system message may use the native in-`messages` form. */
  readonly nativeSystem: boolean;
}

function mapMessage(message: Message, options: MapOptions): AnthropicMessage | undefined {
  switch (message.role) {
    case 'system': {
      const text = messageText(message);
      if (text === '') return undefined;
      return options.nativeSystem
        ? { role: 'system', content: [{ type: 'text', text }] }
        : { role: 'user', content: [{ type: 'text', text: systemInstructionEnvelope(text) }] };
    }
    case 'user':
    case 'tool': {
      const content = message.content.flatMap(userBlock);
      return content.length === 0 ? undefined : { role: 'user', content };
    }
    case 'assistant': {
      const content = message.content.flatMap((part) =>
        assistantBlock(part, options.replayReasoning),
      );
      return content.length === 0 ? undefined : { role: 'assistant', content };
    }
  }
}

function userBlock(part: ContentPart): AnthropicBlock[] {
  switch (part.type) {
    case 'text':
      return part.text === '' ? [] : [{ type: 'text', text: part.text }];
    case 'image':
      return [imageBlock(part.mediaType, part.dataBase64)];
    case 'tool_result':
      return [
        {
          type: 'tool_result',
          tool_use_id: toolUseId(part.callId),
          content: toolResultContent(part.output),
          ...(part.isError ? { is_error: true as const } : {}),
        },
      ];
    case 'tool_call':
    case 'reasoning':
      return [];
  }
}

function assistantBlock(part: ContentPart, replayReasoning: boolean): AnthropicBlock[] {
  switch (part.type) {
    case 'text':
      return part.text === '' ? [] : [{ type: 'text', text: part.text }];
    case 'tool_call':
      return [{ type: 'tool_use', id: toolUseId(part.id), name: part.name, input: part.input }];
    case 'reasoning':
      return replayReasoning ? reasoningBlock(part.text, part.providerMetadata) : [];
    case 'image':
    case 'tool_result':
      return [];
  }
}

function reasoningBlock(text: string, metadata: ProviderMetadata | undefined): AnthropicBlock[] {
  if (metadata?.origin.providerId !== ANTHROPIC_PROVIDER_ID) return [];
  const data = AnthropicReasoningDataSchema.safeParse(metadata.data);
  if (!data.success) return [];
  if ('signature' in data.data) {
    return [{ type: 'thinking', thinking: text, signature: data.data.signature }];
  }
  return [{ type: 'redacted_thinking', data: data.data.redactedData }];
}

function imageBlock(mediaType: ImageMediaType, data: string): ImageBlock {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

function toolResultContent(output: ToolOutput): ToolResultBlock['content'] {
  if (typeof output === 'string') return output;
  return output.flatMap((block): (TextBlock | ImageBlock)[] => {
    if (block.type === 'text') return block.text === '' ? [] : [{ type: 'text', text: block.text }];
    return [imageBlock(block.mediaType, block.dataBase64)];
  });
}

/**
 * Anthropic tool ids must match `^[a-zA-Z0-9_-]+$`. Ids from other vendors are mapped
 * deterministically, so a call and its result always agree.
 */
export function toolUseId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe === '' ? 'call' : safe;
}

function lastCacheable(blocks: readonly AnthropicBlock[]): CacheableBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block === undefined) continue;
    if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
    return block;
  }
  return undefined;
}

/**
 * Joins consecutive same-role messages (e.g. tool results followed by a user note or an
 * enveloped system instruction). In a user message every `tool_result` must come before any
 * other block, or the API rejects the request.
 */
function mergeConsecutive(messages: readonly AnthropicMessage[]): AnthropicMessage[] {
  const merged: AnthropicMessage[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous?.role === message.role && message.role !== 'system') {
      merged[merged.length - 1] = {
        role: previous.role,
        content: [...previous.content, ...message.content],
      };
    } else {
      merged.push(message);
    }
  }
  return merged.map((message) =>
    message.role === 'user'
      ? {
          role: 'user',
          content: [
            ...message.content.filter((block) => block.type === 'tool_result'),
            ...message.content.filter((block) => block.type !== 'tool_result'),
          ],
        }
      : message,
  );
}
