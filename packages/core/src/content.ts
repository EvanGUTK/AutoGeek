import { z } from 'zod';

/**
 * Model-visible tool output, shared by `ToolResult.content` and the `tool_result` content part
 * so there is exactly one definition.
 *
 * The schema is STRUCTURAL and carries FINITE hard caps only, so nothing unbounded can cross a
 * trust boundary: a decoded image is at most 4 MiB, and one output (text bytes in UTF-8 plus
 * base64 characters) is at most 8 MiB. Tools and the wire projection impose much tighter limits
 * per the agent contract (truncation with explicit markers); these caps are the backstop that
 * validation can always afford to enforce.
 */

/** The only image types every supported vendor accepts. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export const ImageMediaTypeSchema = z.enum(IMAGE_MEDIA_TYPES);
export type ImageMediaType = z.infer<typeof ImageMediaTypeSchema>;

/** Largest decoded image accepted: 4 MiB. */
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** Largest tool output accepted in total (UTF-8 text bytes plus base64 characters): 8 MiB. */
export const TOOL_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

export const TextBlockSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string(),
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Character code to alphabet index, or -1. A lookup table keeps the scan linear and iterative. */
const BASE64_INDEX = ((): Int16Array => {
  const table = new Int16Array(256).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

function base64Index(text: string, position: number): number {
  const code = text.charCodeAt(position);
  return code < 256 ? (BASE64_INDEX[code] ?? -1) : -1;
}

/**
 * Strict standard base64: the exact alphabet, a length that is a multiple of 4, padding only at
 * the end and only as needed, and CANONICAL (the unused low bits of the final character are
 * zero, so one byte sequence has exactly one encoding). Returns the decoded byte length, or
 * undefined when the string is not strict base64. A character scan rather than a regular
 * expression: a repeated regex group overflows the engine's stack on multi-megabyte input.
 */
function strictBase64Length(text: string): number | undefined {
  const length = text.length;
  if (length === 0 || length % 4 !== 0) {
    return undefined;
  }
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  for (let position = 0; position < length - padding; position += 1) {
    if (base64Index(text, position) < 0) {
      return undefined;
    }
  }
  if (padding > 0) {
    const unusedBits = padding === 2 ? 0x0f : 0x03;
    if ((base64Index(text, length - padding - 1) & unusedBits) !== 0) {
      return undefined;
    }
  }
  return (length / 4) * 3 - padding;
}

export const ImageBlockSchema = z.strictObject({
  type: z.literal('image'),
  mediaType: ImageMediaTypeSchema,
  /** Raw base64 only: no `data:` URL prefix, no whitespace, canonical, at most 4 MiB decoded. */
  dataBase64: z
    .string()
    .refine((text) => strictBase64Length(text) !== undefined, {
      message: 'dataBase64 must be strict canonical base64',
    })
    .refine((text) => (strictBase64Length(text) ?? 0) <= IMAGE_MAX_BYTES, {
      message: `an image may be at most ${String(IMAGE_MAX_BYTES)} bytes decoded`,
    }),
});
export type ImageBlock = z.infer<typeof ImageBlockSchema>;

const utf8Bytes = (text: string): number => {
  // A string of N UTF-16 units is at most 3N and at least N bytes: skip encoding when decidable.
  if (text.length > TOOL_OUTPUT_MAX_BYTES) {
    return text.length;
  }
  if (text.length * 3 <= TOOL_OUTPUT_MAX_BYTES) {
    return text.length * 3;
  }
  return new TextEncoder().encode(text).length;
};

/** Serialized size used for the total cap: UTF-8 bytes of text plus base64 characters. */
function outputSize(output: string | (TextBlock | ImageBlock)[]): number {
  if (typeof output === 'string') {
    return utf8Bytes(output);
  }
  let total = 0;
  for (const block of output) {
    total += block.type === 'text' ? utf8Bytes(block.text) : block.dataBase64.length;
    if (total > TOOL_OUTPUT_MAX_BYTES) {
      return total;
    }
  }
  return total;
}

export const ToolOutputSchema = z
  .union([z.string(), z.array(z.discriminatedUnion('type', [TextBlockSchema, ImageBlockSchema]))])
  .refine((output) => outputSize(output) <= TOOL_OUTPUT_MAX_BYTES, {
    message: `a tool output may be at most ${String(TOOL_OUTPUT_MAX_BYTES)} bytes`,
  });
export type ToolOutput = z.infer<typeof ToolOutputSchema>;
