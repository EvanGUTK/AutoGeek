import { z } from 'zod';

/** The only image types every supported vendor accepts. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export const ImageMediaTypeSchema = z.enum(IMAGE_MEDIA_TYPES);
export type ImageMediaType = z.infer<typeof ImageMediaTypeSchema>;

export const TextBlockSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string(),
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const ImageBlockSchema = z.strictObject({
  type: z.literal('image'),
  mediaType: ImageMediaTypeSchema,
  /** Raw base64 only: no `data:` URL prefix, no whitespace. */
  dataBase64: z.string().regex(BASE64),
});
export type ImageBlock = z.infer<typeof ImageBlockSchema>;

/**
 * What a tool hands back to the model. Shared by `ToolResult.content` and the `tool_result`
 * content part so there is exactly one definition of "model-visible tool output".
 */
export const ToolOutputSchema = z.union([
  z.string(),
  z.array(z.discriminatedUnion('type', [TextBlockSchema, ImageBlockSchema])),
]);
export type ToolOutput = z.infer<typeof ToolOutputSchema>;
