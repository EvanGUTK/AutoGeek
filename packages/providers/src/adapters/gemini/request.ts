import type {
  ContentPart,
  JsonObject,
  Message,
  ModelRequest,
  ProviderMetadata,
  ToolOutput,
} from '@autogeek/core';
import { z } from 'zod';
import { nearestEffort } from '../effort.ts';
import {
  inProgressToolTurn,
  messageText,
  splitSystemPrompt,
  systemInstructionEnvelope,
} from '../shared.ts';
import { thinkingBudget } from './models.ts';
import type { GeminiModelProfile } from './models.ts';

export const GEMINI_PROVIDER_ID = 'google';

/**
 * Model ids go into the URL path (`models/{model}:streamGenerateContent`), so only plain ids are
 * accepted; anything else could address another resource.
 */
export const GEMINI_MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Documented value that skips thought-signature validation for a function call Gemini did not
 * generate (history from another provider or model). Google discourages it but documents it for
 * exactly this case: https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
 * (FAQ, "transferring a conversation from another model"). Verified 2026-10-11; re-verify when
 * the API changes. The conformance suite covers it.
 */
export const DUMMY_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

/**
 * `providerMetadata.data` of Gemini-origin parts: the part's `thoughtSignature`, if it carried
 * one, and whether the function call id was synthesized by us (Gemini 2.5 sends none; it is then
 * omitted on replay and calls match by name and order).
 */
export const GeminiPartDataSchema = z.strictObject({
  thoughtSignature: z.string().min(1).optional(),
  idSynthesized: z.literal(true).optional(),
});

type Part =
  | { readonly text: string; readonly thought?: true; readonly thoughtSignature?: string }
  | { readonly inlineData: { readonly mimeType: string; readonly data: string } }
  | {
      readonly functionCall: {
        readonly id?: string;
        readonly name: string;
        readonly args: JsonObject;
      };
      readonly thoughtSignature?: string;
    }
  | {
      readonly functionResponse: {
        readonly id?: string;
        readonly name: string;
        readonly response: JsonObject;
        readonly parts?: {
          readonly inlineData: {
            readonly mimeType: string;
            readonly data: string;
            readonly displayName: string;
          };
        }[];
      };
    };

export interface GeminiContent {
  readonly role: 'user' | 'model';
  readonly parts: Part[];
}

export interface GeminiBody {
  readonly contents: GeminiContent[];
  readonly systemInstruction?: { readonly parts: { readonly text: string }[] };
  readonly tools?: { readonly functionDeclarations: FunctionDeclaration[] }[];
  readonly toolConfig?: { readonly functionCallingConfig: { readonly mode: 'AUTO' | 'NONE' } };
  readonly generationConfig: {
    readonly maxOutputTokens: number;
    readonly stopSequences?: string[];
    readonly thinkingConfig?: {
      readonly includeThoughts: boolean;
      readonly thinkingLevel?: 'low' | 'medium' | 'high';
      readonly thinkingBudget?: number;
    };
  };
}

interface FunctionDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parametersJsonSchema: JsonObject;
}

/** The API accepts at most five stop sequences. */
const MAX_STOP_SEQUENCES = 5;

/**
 * Maps a `ModelRequest` to a `streamGenerateContent` body
 * (https://ai.google.dev/api/generate-content). The leading system messages become
 * `systemInstruction`; later ones are enveloped user turns (lossy, documented in the contract).
 *
 * Origin matching is on PROVIDER + MODEL: thought signatures are replayed in the exact part that
 * carried them, only to the model that produced them. Gemini validates signatures only in the
 * current turn (after the last user message with regular content), where the first function call
 * of each model step must carry one; a step whose calls came from elsewhere gets the documented
 * dummy signature. With `reasoningReplay: 'drop'`, thought summaries and text signatures are
 * dropped outside the in-progress tool-use turn; function-call signatures are always kept because
 * the API requires them.
 */
export function buildGeminiBody(
  request: ModelRequest,
  profile: GeminiModelProfile | undefined,
): GeminiBody {
  const { system, rest } = splitSystemPrompt(request.messages);
  const systemText = system
    .map(messageText)
    .filter((text) => text !== '')
    .join('\n\n');
  const callNames = new Map<string, { name: string; synthesized: boolean }>();
  const keepToolTurn = inProgressToolTurn(rest);
  const preserve = request.reasoningReplay !== 'drop';
  const currentTurnStart = rest.findLastIndex(
    (message) =>
      message.role === 'user' && message.content.some((part) => part.type !== 'tool_result'),
  );

  const contents: GeminiContent[] = [];
  rest.forEach((message, index) => {
    const content = mapMessage(message, {
      model: request.model,
      callNames,
      replayReasoning: preserve || index === keepToolTurn,
      currentTurn: index > currentTurnStart,
    });
    if (content === undefined) return;
    const previous = contents.at(-1);
    // Only user turns merge: model contents are steps whose signatures must stay separate.
    if (previous?.role === 'user' && content.role === 'user') {
      contents[contents.length - 1] = {
        role: 'user',
        parts: [...previous.parts, ...content.parts],
      };
    } else {
      contents.push(content);
    }
  });

  const tools = request.tools ?? [];
  return {
    contents,
    ...(systemText === '' ? {} : { systemInstruction: { parts: [{ text: systemText }] } }),
    ...(tools.length === 0
      ? {}
      : {
          tools: [
            {
              functionDeclarations: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: withoutSchemaKeyword(tool.inputSchema),
              })),
            },
          ],
        }),
    ...(tools.length === 0 || request.toolChoice === undefined
      ? {}
      : {
          toolConfig: {
            functionCallingConfig: { mode: request.toolChoice === 'none' ? 'NONE' : 'AUTO' },
          },
        }),
    generationConfig: {
      maxOutputTokens: request.maxOutputTokens,
      ...(request.stopSequences === undefined || request.stopSequences.length === 0
        ? {}
        : { stopSequences: request.stopSequences.slice(0, MAX_STOP_SEQUENCES) }),
      ...thinkingConfig(request, profile),
    },
  };
}

function thinkingConfig(
  request: ModelRequest,
  profile: GeminiModelProfile | undefined,
): Pick<GeminiBody['generationConfig'], 'thinkingConfig'> {
  const reasoning = request.reasoning;
  if (reasoning === undefined || profile === undefined) return {};
  const includeThoughts = reasoning.visibility !== 'hidden';
  const effort = reasoning.effort;
  if (effort === undefined) return { thinkingConfig: { includeThoughts } };
  // Never both: thinkingLevel and thinkingBudget together are a 400 (thinking docs).
  if (profile.thinking.kind === 'budget') {
    return {
      thinkingConfig: { includeThoughts, thinkingBudget: thinkingBudget(effort, profile.thinking) },
    };
  }
  const level = nearestEffort(effort, profile.thinking.levels);
  if (level !== 'low' && level !== 'medium' && level !== 'high')
    return { thinkingConfig: { includeThoughts } };
  return { thinkingConfig: { includeThoughts, thinkingLevel: level } };
}

interface MapOptions {
  readonly model: string;
  readonly callNames: Map<string, { name: string; synthesized: boolean }>;
  readonly replayReasoning: boolean;
  readonly currentTurn: boolean;
}

function mapMessage(message: Message, options: MapOptions): GeminiContent | undefined {
  switch (message.role) {
    case 'system': {
      const text = messageText(message);
      return text === ''
        ? undefined
        : { role: 'user', parts: [{ text: systemInstructionEnvelope(text) }] };
    }
    case 'user':
    case 'tool': {
      const parts = message.content.flatMap((part) => userPart(part, options));
      return parts.length === 0 ? undefined : { role: 'user', parts };
    }
    case 'assistant': {
      const parts = modelParts(message.content, options);
      return parts.length === 0 ? undefined : { role: 'model', parts };
    }
  }
}

function userPart(part: ContentPart, options: MapOptions): Part[] {
  switch (part.type) {
    case 'text':
      return part.text === '' ? [] : [{ text: part.text }];
    case 'image':
      return [{ inlineData: { mimeType: part.mediaType, data: part.dataBase64 } }];
    case 'tool_result': {
      const call = options.callNames.get(part.callId);
      const name = call?.name ?? 'unknown_tool';
      const { text, images } = splitOutput(part.output);
      const key = part.isError ? 'error' : 'output';
      return [
        {
          functionResponse: {
            ...(call?.synthesized === true ? {} : { id: part.callId }),
            name,
            response:
              images.length === 0
                ? { [key]: text }
                : { [key]: text, images: images.map((image) => ({ $ref: image.displayName })) },
            ...(images.length === 0 ? {} : { parts: images.map((inlineData) => ({ inlineData })) }),
          },
        },
      ];
    }
    case 'tool_call':
    case 'reasoning':
      return [];
  }
}

/**
 * Text goes in the response object; images become `functionResponse.parts` referenced by
 * `$ref` (multimodal function responses, Gemini 3: https://ai.google.dev/gemini-api/docs/generate-content/function-calling).
 */
function splitOutput(output: ToolOutput): {
  text: string;
  images: { mimeType: string; data: string; displayName: string }[];
} {
  if (typeof output === 'string') return { text: output, images: [] };
  const texts: string[] = [];
  const images: { mimeType: string; data: string; displayName: string }[] = [];
  for (const block of output) {
    if (block.type === 'text') texts.push(block.text);
    else {
      const extension = block.mediaType.slice('image/'.length);
      images.push({
        mimeType: block.mediaType,
        data: block.dataBase64,
        displayName: `image-${String(images.length + 1)}.${extension}`,
      });
    }
  }
  return { text: texts.join('\n'), images };
}

function modelParts(content: readonly ContentPart[], options: MapOptions): Part[] {
  const parts: Part[] = [];
  let firstCall = true;
  for (const part of content) {
    const data = ownData(part, options.model);
    switch (part.type) {
      case 'text': {
        const signature = options.replayReasoning ? data?.thoughtSignature : undefined;
        if (part.text === '' && signature === undefined) break;
        parts.push({
          text: part.text,
          ...(signature === undefined ? {} : { thoughtSignature: signature }),
        });
        break;
      }
      case 'reasoning': {
        // Thought summaries are output only; one is replayed only when it carried a signature.
        const signature = data?.thoughtSignature;
        if (!options.replayReasoning || signature === undefined) break;
        parts.push({ text: part.text, thought: true, thoughtSignature: signature });
        break;
      }
      case 'tool_call': {
        const synthesized = data?.idSynthesized === true;
        options.callNames.set(part.id, { name: part.name, synthesized });
        let signature = data?.thoughtSignature;
        if (signature === undefined && firstCall && options.currentTurn)
          signature = DUMMY_THOUGHT_SIGNATURE;
        firstCall = false;
        parts.push({
          functionCall: {
            ...(synthesized ? {} : { id: part.id }),
            name: part.name,
            args: part.input,
          },
          ...(signature === undefined ? {} : { thoughtSignature: signature }),
        });
        break;
      }
      case 'image':
      case 'tool_result':
        break;
    }
  }
  return parts;
}

/** The Gemini metadata of a part produced by this model, else undefined. */
function ownData(
  part: ContentPart,
  model: string,
): z.infer<typeof GeminiPartDataSchema> | undefined {
  if (part.type !== 'text' && part.type !== 'reasoning' && part.type !== 'tool_call')
    return undefined;
  const metadata: ProviderMetadata | undefined = part.providerMetadata;
  if (metadata?.origin.providerId !== GEMINI_PROVIDER_ID || metadata.origin.modelId !== model)
    return undefined;
  const parsed = GeminiPartDataSchema.safeParse(metadata.data);
  return parsed.success ? parsed.data : undefined;
}

/** `$schema` names a dialect Gemini does not accept as a keyword. */
function withoutSchemaKeyword(schema: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$schema'));
}
