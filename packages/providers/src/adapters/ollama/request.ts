import type { ContentPart, JsonObject, Message, ModelRequest } from '@autogeek/core';
import { nearestEffort } from '../effort.ts';
import {
  inProgressToolTurn,
  messageText,
  splitSystemPrompt,
  systemInstructionEnvelope,
} from '../shared.ts';

export const OLLAMA_PROVIDER_ID = 'ollama';

/** What `/api/show` told us about a model; absent when it could not be read. */
export interface OllamaModelFacts {
  /** The context size we run the model with (`options.num_ctx`). */
  readonly numCtx?: number;
  readonly thinking: 'none' | 'boolean' | 'levels';
}

export type OllamaMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string; readonly images?: string[] }
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly thinking?: string;
      readonly tool_calls?: {
        readonly function: { readonly name: string; readonly arguments: JsonObject };
      }[];
    }
  | { readonly role: 'tool'; readonly tool_name: string; readonly content: string };

export interface OllamaBody {
  readonly model: string;
  readonly stream: true;
  readonly messages: OllamaMessage[];
  readonly tools?: {
    readonly type: 'function';
    readonly function: {
      readonly name: string;
      readonly description: string;
      readonly parameters: JsonObject;
    };
  }[];
  readonly think?: boolean | 'low' | 'medium' | 'high';
  readonly options: {
    readonly num_predict: number;
    readonly num_ctx?: number;
    readonly stop?: string[];
  };
}

/**
 * Maps a `ModelRequest` to Ollama's native `POST /api/chat` body
 * (https://github.com/ollama/ollama/blob/main/docs/api.md). The native API is used because only it
 * can set `options.num_ctx`: Ollama's default context is small and silently truncates long agent
 * prompts (docs/context-length). `toolChoice: 'none'` omits the tools (no tool_choice exists).
 * Mid-conversation system messages are enveloped user turns. Thinking text is replayed in the
 * assistant message's `thinking` field to the model that produced it; it carries no signature.
 */
export function buildOllamaBody(
  request: ModelRequest,
  facts: OllamaModelFacts | undefined,
): OllamaBody {
  const { system, rest } = splitSystemPrompt(request.messages);
  const systemText = system
    .map(messageText)
    .filter((text) => text !== '')
    .join('\n\n');
  const keepToolTurn = inProgressToolTurn(rest);
  const preserve = request.reasoningReplay !== 'drop';
  const callNames = new Map<string, string>();
  const messages: OllamaMessage[] =
    systemText === '' ? [] : [{ role: 'system', content: systemText }];
  rest.forEach((message, index) => {
    messages.push(
      ...mapMessage(message, {
        model: request.model,
        callNames,
        replayThinking: preserve || index === keepToolTurn,
      }),
    );
  });

  const tools = request.toolChoice === 'none' ? [] : (request.tools ?? []);
  return {
    model: request.model,
    stream: true,
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
    ...think(request, facts),
    options: {
      num_predict: request.maxOutputTokens,
      ...(facts?.numCtx === undefined ? {} : { num_ctx: facts.numCtx }),
      ...(request.stopSequences === undefined || request.stopSequences.length === 0
        ? {}
        : { stop: [...request.stopSequences] }),
    },
  };
}

function think(
  request: ModelRequest,
  facts: OllamaModelFacts | undefined,
): Pick<OllamaBody, 'think'> {
  const reasoning = request.reasoning;
  if (reasoning === undefined || facts === undefined || facts.thinking === 'none') return {};
  if (facts.thinking === 'boolean' || reasoning.effort === undefined) return { think: true };
  const level = nearestEffort(reasoning.effort, ['low', 'medium', 'high']);
  return level === 'low' || level === 'medium' || level === 'high'
    ? { think: level }
    : { think: true };
}

interface MapOptions {
  readonly model: string;
  readonly callNames: Map<string, string>;
  readonly replayThinking: boolean;
}

function mapMessage(message: Message, options: MapOptions): OllamaMessage[] {
  switch (message.role) {
    case 'system': {
      const text = messageText(message);
      return text === '' ? [] : [{ role: 'user', content: systemInstructionEnvelope(text) }];
    }
    case 'user': {
      const results = toolMessages(message.content, options);
      const text = messageText(message);
      const images = message.content.flatMap((part) =>
        part.type === 'image' ? [part.dataBase64] : [],
      );
      if (text === '' && images.length === 0) return results;
      return [
        ...results,
        { role: 'user', content: text, ...(images.length === 0 ? {} : { images }) },
      ];
    }
    case 'tool':
      return toolMessages(message.content, options);
    case 'assistant':
      return assistantMessage(message.content, options);
  }
}

function toolMessages(content: readonly ContentPart[], options: MapOptions): OllamaMessage[] {
  const messages: OllamaMessage[] = [];
  for (const part of content) {
    if (part.type !== 'tool_result') continue;
    const output = part.output;
    const text =
      typeof output === 'string'
        ? output
        : output.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    const images =
      typeof output === 'string'
        ? []
        : output.flatMap((block) => (block.type === 'image' ? [block.dataBase64] : []));
    messages.push({
      role: 'tool',
      tool_name: options.callNames.get(part.callId) ?? 'unknown_tool',
      content: text,
    });
    // Tool messages carry no images; they follow as a user message.
    if (images.length > 0) messages.push({ role: 'user', content: '', images });
  }
  return messages;
}

function assistantMessage(content: readonly ContentPart[], options: MapOptions): OllamaMessage[] {
  const text = content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
  const thinking = options.replayThinking
    ? content
        .flatMap((part) =>
          part.type === 'reasoning' &&
          part.providerMetadata?.origin.providerId === OLLAMA_PROVIDER_ID &&
          part.providerMetadata.origin.modelId === options.model
            ? [part.text]
            : [],
        )
        .join('')
    : '';
  const calls = content.flatMap((part) => {
    if (part.type !== 'tool_call') return [];
    options.callNames.set(part.id, part.name);
    return [{ function: { name: part.name, arguments: part.input } }];
  });
  if (text === '' && calls.length === 0 && thinking === '') return [];
  return [
    {
      role: 'assistant',
      content: text,
      ...(thinking === '' ? {} : { thinking }),
      ...(calls.length === 0 ? {} : { tool_calls: calls }),
    },
  ];
}
