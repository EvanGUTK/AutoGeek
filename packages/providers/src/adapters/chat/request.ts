import { JsonObjectSchema } from '@autogeek/core';
import type {
  ContentPart,
  JsonObject,
  Message,
  ModelRequest,
  ProviderMetadata,
} from '@autogeek/core';
import { z } from 'zod';
import {
  inProgressToolTurn,
  messageText,
  splitSystemPrompt,
  systemInstructionEnvelope,
} from '../shared.ts';

/** How a server takes a reasoning request; servers that take none get nothing. */
export type ReasoningDialect = 'openrouter' | 'reasoning_effort' | 'none';

export interface ChatRequestOptions {
  readonly providerId: string;
  readonly reasoning: ReasoningDialect;
  /** Replays OpenRouter `reasoning_details` for the same model. */
  readonly replayReasoningDetails: boolean;
}

/**
 * `providerMetadata.data` of a reasoning part from a server that returns `reasoning_details`
 * (OpenRouter): the merged detail objects, replayed unmodified on the assistant message.
 */
export const ReasoningDetailsDataSchema = z.strictObject({
  reasoningDetails: z.array(JsonObjectSchema),
});

type TextOrImage =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

export type ChatMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string | TextOrImage[] }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly tool_calls?: {
        readonly id: string;
        readonly type: 'function';
        readonly function: { readonly name: string; readonly arguments: string };
      }[];
      readonly reasoning_details?: JsonObject[];
    }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

export interface ChatBody {
  readonly model: string;
  readonly stream: true;
  readonly stream_options: { readonly include_usage: true };
  readonly max_tokens: number;
  readonly messages: ChatMessage[];
  readonly tools?: {
    readonly type: 'function';
    readonly function: {
      readonly name: string;
      readonly description: string;
      readonly parameters: JsonObject;
    };
  }[];
  readonly tool_choice?: 'auto' | 'none';
  readonly stop?: string[];
  readonly reasoning?: { readonly effort?: string; readonly exclude?: true };
  readonly reasoning_effort?: string;
}

/**
 * Maps a `ModelRequest` to an OpenAI Chat Completions body for the compatible family (OpenRouter,
 * LM Studio, llama.cpp, generic servers): the widest common subset (`max_tokens`, string content
 * where possible). Mid-conversation system messages become enveloped user turns (lossy; servers
 * differ on where `system` may appear). Images in tool results cannot go in a `tool` message, so
 * they follow in one user message after the results. Reasoning is replayed only as OpenRouter
 * `reasoning_details` to the model that produced it (provider + model matching); other servers
 * have no replay field. `cacheHint` is not mapped.
 */
export function buildChatBody(request: ModelRequest, options: ChatRequestOptions): ChatBody {
  const { system, rest } = splitSystemPrompt(request.messages);
  const systemText = system
    .map(messageText)
    .filter((text) => text !== '')
    .join('\n\n');
  const keepToolTurn = inProgressToolTurn(rest);
  const preserve = request.reasoningReplay !== 'drop';
  const messages: ChatMessage[] =
    systemText === '' ? [] : [{ role: 'system', content: systemText }];
  rest.forEach((message, index) => {
    messages.push(
      ...mapMessage(message, {
        ...options,
        model: request.model,
        replayReasoning: options.replayReasoningDetails && (preserve || index === keepToolTurn),
      }),
    );
  });

  const tools = request.tools ?? [];
  return {
    model: request.model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: request.maxOutputTokens,
    messages,
    ...(tools.length === 0
      ? {}
      : {
          tools: tools.map((tool) => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }),
    ...(tools.length === 0 || request.toolChoice === undefined
      ? {}
      : { tool_choice: request.toolChoice }),
    ...(request.stopSequences === undefined || request.stopSequences.length === 0
      ? {}
      : { stop: [...request.stopSequences] }),
    ...reasoningParams(request, options.reasoning),
  };
}

function reasoningParams(
  request: ModelRequest,
  dialect: ReasoningDialect,
): Pick<ChatBody, 'reasoning' | 'reasoning_effort'> {
  const reasoning = request.reasoning;
  if (reasoning === undefined) return {};
  switch (dialect) {
    case 'openrouter':
      // https://openrouter.ai/docs/guides/best-practices/reasoning-tokens: effort is normalized
      // across upstreams; exclude hides the reasoning text but the model still reasons.
      return {
        reasoning: {
          ...(reasoning.effort === undefined ? {} : { effort: reasoning.effort }),
          ...(reasoning.visibility === 'hidden' ? { exclude: true as const } : {}),
        },
      };
    case 'reasoning_effort':
      return reasoning.effort === undefined ? {} : { reasoning_effort: reasoning.effort };
    case 'none':
      return {};
  }
}

interface MapOptions extends ChatRequestOptions {
  readonly model: string;
  readonly replayReasoning: boolean;
}

function mapMessage(message: Message, options: MapOptions): ChatMessage[] {
  switch (message.role) {
    case 'system': {
      const text = messageText(message);
      return text === '' ? [] : [{ role: 'user', content: systemInstructionEnvelope(text) }];
    }
    case 'user': {
      const content = message.content.flatMap(userContent);
      const results = toolMessages(message.content);
      return [
        ...results,
        ...(content.length === 0 ? [] : [{ role: 'user' as const, content: compact(content) }]),
      ];
    }
    case 'tool':
      return toolMessages(message.content);
    case 'assistant':
      return assistantMessage(message.content, options);
  }
}

function userContent(part: ContentPart): TextOrImage[] {
  switch (part.type) {
    case 'text':
      return part.text === '' ? [] : [{ type: 'text', text: part.text }];
    case 'image':
      return [
        {
          type: 'image_url',
          image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` },
        },
      ];
    case 'tool_call':
    case 'tool_result':
    case 'reasoning':
      return [];
  }
}

/** Plain text content as a string, the form every compatible server accepts. */
function compact(content: TextOrImage[]): string | TextOrImage[] {
  return content.every((block) => block.type === 'text')
    ? content.map((block) => block.text).join('\n\n')
    : content;
}

function toolMessages(content: readonly ContentPart[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const images: TextOrImage[] = [];
  for (const part of content) {
    if (part.type !== 'tool_result') continue;
    if (typeof part.output === 'string') {
      messages.push({ role: 'tool', tool_call_id: part.callId, content: part.output });
      continue;
    }
    const texts = part.output.flatMap((block) => (block.type === 'text' ? [block.text] : []));
    const pictures = part.output.filter((block) => block.type === 'image');
    const note =
      pictures.length === 0
        ? []
        : [`[${String(pictures.length)} image(s) follow in the next message]`];
    messages.push({
      role: 'tool',
      tool_call_id: part.callId,
      content: [...texts, ...note].join('\n'),
    });
    for (const picture of pictures) {
      images.push({
        type: 'image_url',
        image_url: { url: `data:${picture.mediaType};base64,${picture.dataBase64}` },
      });
    }
  }
  return images.length === 0 ? messages : [...messages, { role: 'user', content: images }];
}

function assistantMessage(content: readonly ContentPart[], options: MapOptions): ChatMessage[] {
  const text = content
    .flatMap((part) => (part.type === 'text' && part.text !== '' ? [part.text] : []))
    .join('');
  const calls = content.flatMap((part) =>
    part.type === 'tool_call'
      ? [
          {
            id: part.id,
            type: 'function' as const,
            function: { name: part.name, arguments: JSON.stringify(part.input) },
          },
        ]
      : [],
  );
  const details = options.replayReasoning
    ? content.flatMap((part) =>
        part.type === 'reasoning' ? ownDetails(part.providerMetadata, options) : [],
      )
    : [];
  if (text === '' && calls.length === 0) return [];
  return [
    {
      role: 'assistant',
      content: text === '' ? null : text,
      ...(calls.length === 0 ? {} : { tool_calls: calls }),
      ...(details.length === 0 ? {} : { reasoning_details: details }),
    },
  ];
}

function ownDetails(metadata: ProviderMetadata | undefined, options: MapOptions): JsonObject[] {
  if (
    metadata?.origin.providerId !== options.providerId ||
    metadata.origin.modelId !== options.model
  )
    return [];
  const parsed = ReasoningDetailsDataSchema.safeParse(metadata.data);
  return parsed.success ? parsed.data.reasoningDetails : [];
}
