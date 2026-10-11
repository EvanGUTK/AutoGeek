import { describe, expect, it } from 'vitest';
import {
  IMAGE_MEDIA_TYPES,
  ImageBlockSchema,
  TextBlockSchema,
  ToolOutputSchema,
} from './content.ts';

describe('TextBlockSchema', () => {
  it('accepts text blocks, including empty text', () => {
    expect(TextBlockSchema.safeParse({ type: 'text', text: 'hi' }).success).toBe(true);
    expect(TextBlockSchema.safeParse({ type: 'text', text: '' }).success).toBe(true);
  });

  it('rejects extra fields and non-string text', () => {
    expect(TextBlockSchema.safeParse({ type: 'text', text: 'hi', extra: 1 }).success).toBe(false);
    expect(TextBlockSchema.safeParse({ type: 'text', text: 1 }).success).toBe(false);
  });
});

describe('ImageBlockSchema', () => {
  it.each(IMAGE_MEDIA_TYPES)('accepts %s', (mediaType) => {
    expect(
      ImageBlockSchema.safeParse({ type: 'image', mediaType, dataBase64: 'AAAA' }).success,
    ).toBe(true);
  });

  it('lists exactly the four media types every vendor accepts', () => {
    expect([...IMAGE_MEDIA_TYPES]).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  });

  it.each(['image/svg+xml', 'image/bmp', 'text/plain', ''])(
    'rejects media type %j',
    (mediaType) => {
      expect(
        ImageBlockSchema.safeParse({ type: 'image', mediaType, dataBase64: 'AAAA' }).success,
      ).toBe(false);
    },
  );

  it('requires base64 data without a data: URL prefix or whitespace', () => {
    const parse = (dataBase64: string): boolean =>
      ImageBlockSchema.safeParse({ type: 'image', mediaType: 'image/png', dataBase64 }).success;
    expect(parse('iVBORw0KGgo=')).toBe(true);
    expect(parse('data:image/png;base64,iVBORw0KGgo=')).toBe(false);
    expect(parse('iVBO Rw0K')).toBe(false);
    expect(parse('')).toBe(false);
  });
});

describe('ToolOutputSchema', () => {
  it('accepts a plain string', () => {
    expect(ToolOutputSchema.safeParse('ok').success).toBe(true);
  });

  it('accepts an array of text and image blocks', () => {
    const output = [
      { type: 'text', text: 'see image' },
      { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' },
    ];
    expect(ToolOutputSchema.safeParse(output).success).toBe(true);
  });

  it('rejects arbitrary values so unknown cannot slip through the seam', () => {
    expect(ToolOutputSchema.safeParse({ any: 'thing' }).success).toBe(false);
    expect(ToolOutputSchema.safeParse(42).success).toBe(false);
    expect(ToolOutputSchema.safeParse(null).success).toBe(false);
    expect(ToolOutputSchema.safeParse([{ type: 'tool_call' }]).success).toBe(false);
  });
});
