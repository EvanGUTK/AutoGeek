import type {
  ContentPart,
  JsonObject,
  Message,
  ModelRequest,
  ProviderMetadata,
  ToolOutput,
} from '@autogeek/core';
import { JsonObjectSchema } from '@autogeek/core';
import { z } from 'zod';
import { inProgressToolTurn, messageText, splitSystemPrompt } from '../shared.ts';
import { nearestEffort } from '../effort.ts';
import type { OpenAIModelProfile } from './models.ts';

export const OPENAI_PROVIDER_ID = 'openai';

/**
 * `providerMetadata.data` of OpenAI-origin parts:
 * - reasoning: the output item exactly as received (`id`, `summary`, `encrypted_content`, ...),
 *   replayed unmodified as the docs require for stateless mode;
 * - text and tool calls: the output item id (`msg_...`, `fc_...`).
 */
export const OpenAIReasoningDataSchema = z.strictObject({ item: JsonObjectSchema });
export const OpenAIItemIdSchema = z.strictObject({ itemId: z.string().min(1) });

type InputContent =
  | { readonly type: 'input_text'; readonly text: string }
  | { readonly type: 'input_image'; readonly image_url: string; readonly detail: 'auto' };

export type OpenAIInputItem =
  | { readonly role: 'user' | 'developer'; readonly content: InputContent[] }
  | {
      readonly type: 'message';
      readonly role: 'assistant';
      readonly id?: string;
      readonly content: {
        readonly type: 'output_text';
        readonly text: string;
        readonly annotations: [];
      }[];
    }
  | {
      readonly type: 'function_call';
      readonly id?: string;
      readonly call_id: string;
      readonly name: string;
      readonly arguments: string;
    }
  | {
      readonly type: 'function_call_output';
      readonly call_id: string;
      readonly output: string | InputContent[];
    }
  | JsonObject;

export interface OpenAITool {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  readonly strict: false;
}

export interface OpenAIBody {
  readonly model: string;
  readonly stream: true;
  readonly store: false;
  readonly include: ['reasoning.encrypted_content'];
  readonly max_output_tokens: number;
  readonly input: OpenAIInputItem[];
  readonly instructions?: string;
  readonly tools?: OpenAITool[];
  readonly tool_choice?: 'auto' | 'none';
  readonly reasoning?: { readonly effort?: string; readonly summary?: 'auto' };
}

/**
 * Maps a `ModelRequest` to a stateless Responses API body
 * (https://developers.openai.com/api/docs/guides/migrate-to-responses.md).
 *
 * Stateless: `store: false` plus `include: ["reasoning.encrypted_content"]` (accepted for
 * compatibility; reasoning items carry `encrypted_content` in stateless mode by default), and
 * history replays prior output items unmodified
 * (https://developers.openai.com/api/docs/guides/reasoning.md, "Preserve reasoning without stored
 * responses").
 *
 * Reasoning replay matches on PROVIDER + MODEL: an encrypted reasoning item is replayed only to the
 * model that produced it. Whether other models accept foreign encrypted items is INFERRED, not
 * documented, and covered by an opt-in smoke test; OpenAI does not treat a removed reasoning item
 * as an edit of the remaining history. With `reasoningReplay: 'drop'` only the in-progress
 * tool-use turn's reasoning is replayed, which the function-calling guide requires.
 *
 * Not mapped: `stopSequences` (the Responses API has no stop parameter) and `cacheHint` (OpenAI
 * caches prefixes automatically). Tool schemas are sent with `strict: false` because agent schemas
 * need not satisfy strict mode's all-required, no-additional-properties rules.
 */
export function buildOpenAIBody(
  request: ModelRequest,
  profile: OpenAIModelProfile | undefined,
): OpenAIBody {
  const { system, rest } = splitSystemPrompt(request.messages);
  const instructions = system
    .map(messageText)
    .filter((text) => text !== '')
    .join('\n\n');
  const keepToolTurn = inProgressToolTurn(rest);
  const preserve = request.reasoningReplay !== 'drop';
  const input = rest.flatMap((message, index) =>
    mapMessage(message, {
      model: request.model,
      replayReasoning: preserve || index === keepToolTurn,
    }),
  );
  const tools = request.tools?.map((tool): OpenAITool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
  const reasoning = request.reasoning;
  const effort =
    reasoning?.effort === undefined || profile === undefined
      ? undefined
      : nearestEffort(reasoning.effort, profile.efforts);
  const sendReasoning = reasoning !== undefined && profile?.reasoning === true;

  return {
    model: request.model,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: request.maxOutputTokens,
    input,
    ...(instructions === '' ? {} : { instructions }),
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    ...(tools === undefined || tools.length === 0 || request.toolChoice === undefined
      ? {}
      : { tool_choice: request.toolChoice }),
    ...(sendReasoning
      ? {
          reasoning: {
            ...(effort === undefined ? {} : { effort }),
            ...(reasoning.visibility === 'hidden' ? {} : { summary: 'auto' as const }),
          },
        }
      : {}),
  };
}

interface MapOptions {
  readonly model: string;
  readonly replayReasoning: boolean;
}

function mapMessage(message: Message, options: MapOptions): OpenAIInputItem[] {
  switch (message.role) {
    case 'system': {
      // A mid-conversation operator instruction is a developer message.
      const text = messageText(message);
      return text === '' ? [] : [{ role: 'developer', content: [{ type: 'input_text', text }] }];
    }
    case 'user': {
      const content = message.content.flatMap(userContent);
      const results = message.content.flatMap(functionCallOutput);
      return [...results, ...(content.length === 0 ? [] : [{ role: 'user' as const, content }])];
    }
    case 'tool':
      return message.content.flatMap(functionCallOutput);
    case 'assistant':
      return message.content.flatMap((part) => assistantItem(part, options));
  }
}

function userContent(part: ContentPart): InputContent[] {
  switch (part.type) {
    case 'text':
      return part.text === '' ? [] : [{ type: 'input_text', text: part.text }];
    case 'image':
      return [
        {
          type: 'input_image',
          image_url: `data:${part.mediaType};base64,${part.dataBase64}`,
          detail: 'auto',
        },
      ];
    case 'tool_result':
    case 'tool_call':
    case 'reasoning':
      return [];
  }
}

function functionCallOutput(part: ContentPart): OpenAIInputItem[] {
  if (part.type !== 'tool_result') return [];
  return [{ type: 'function_call_output', call_id: part.callId, output: toolOutput(part.output) }];
}

function toolOutput(output: ToolOutput): string | InputContent[] {
  if (typeof output === 'string') return output;
  return output.map((block): InputContent =>
    block.type === 'text'
      ? { type: 'input_text', text: block.text }
      : {
          type: 'input_image',
          image_url: `data:${block.mediaType};base64,${block.dataBase64}`,
          detail: 'auto',
        },
  );
}

function assistantItem(part: ContentPart, options: MapOptions): OpenAIInputItem[] {
  switch (part.type) {
    case 'text': {
      if (part.text === '') return [];
      const id = ownItemId(part.providerMetadata, options.model);
      return [
        {
          type: 'message',
          role: 'assistant',
          ...(id === undefined ? {} : { id }),
          content: [{ type: 'output_text', text: part.text, annotations: [] }],
        },
      ];
    }
    case 'tool_call': {
      const id = ownItemId(part.providerMetadata, options.model);
      return [
        {
          type: 'function_call',
          ...(id === undefined ? {} : { id }),
          call_id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.input),
        },
      ];
    }
    case 'reasoning': {
      if (!options.replayReasoning || !sameOrigin(part.providerMetadata, options.model)) return [];
      const data = OpenAIReasoningDataSchema.safeParse(part.providerMetadata?.data);
      return data.success ? [data.data.item] : [];
    }
    case 'image':
    case 'tool_result':
      return [];
  }
}

function sameOrigin(metadata: ProviderMetadata | undefined, model: string): boolean {
  return metadata?.origin.providerId === OPENAI_PROVIDER_ID && metadata.origin.modelId === model;
}

/** The output item id, only when this model produced it; foreign ids would reference nothing. */
function ownItemId(metadata: ProviderMetadata | undefined, model: string): string | undefined {
  if (!sameOrigin(metadata, model)) return undefined;
  const data = OpenAIItemIdSchema.safeParse(metadata?.data);
  return data.success ? data.data.itemId : undefined;
}
