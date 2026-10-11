import { describe, expect, it } from 'vitest';
import {
  IMAGE_MAX_BYTES,
  IMAGE_MEDIA_TYPES,
  ImageBlockSchema,
  TextBlockSchema,
  TOOL_OUTPUT_MAX_BYTES,
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

describe('strict base64 (review K5)', () => {
  const image = (dataBase64: string): unknown => ({
    type: 'image',
    mediaType: 'image/png',
    dataBase64,
  });
  const accepted = (dataBase64: string): boolean =>
    ImageBlockSchema.safeParse(image(dataBase64)).success;

  it.each(['AAAA', 'AA==', 'AAA=', 'iVBORw0KGgo=', 'QQ==', 'QUE=', 'AAAAAAAA', 'a+/9'])(
    'accepts canonical base64 %j',
    (data) => {
      expect(accepted(data)).toBe(true);
    },
  );

  it.each([
    ['a length that is not a multiple of 4', 'AAA'],
    ['a single character', 'A'],
    ['padding without enough data', 'A==='],
    ['too much padding', 'AAAA='],
    ['misplaced padding', 'AA=A'],
    ['padding in the middle', 'AA==AAAA'],
    ['a non-canonical final character with ==', 'QR=='],
    ['a non-canonical final character with =', 'QUF='],
    ['a final character whose low 4 bits are not zero (with ==)', 'QE=='],
    ['the URL-safe alphabet', 'a-_9'],
    ['whitespace', 'AAAA AAAA'],
    ['a trailing newline', 'AAAA\n'],
    ['a data: URL prefix', 'data:image/png;base64,AAAA'],
    ['an empty string', ''],
  ])('rejects %s', (_name, data) => {
    expect(accepted(data)).toBe(false);
  });
});

describe('finite hard caps on tool output (review K5)', () => {
  /** Valid base64 whose decoded size is exactly `bytes`. */
  function base64Of(bytes: number): string {
    const fullGroups = Math.floor(bytes / 3);
    const remainder = bytes % 3;
    return 'AAAA'.repeat(fullGroups) + (remainder === 1 ? 'AA==' : remainder === 2 ? 'AAA=' : '');
  }
  const image = (bytes: number): unknown => ({
    type: 'image',
    mediaType: 'image/png',
    dataBase64: base64Of(bytes),
  });

  it('states the limits: 4 MiB per decoded image, 8 MiB per output', () => {
    expect(IMAGE_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(TOOL_OUTPUT_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it('accepts an image of exactly the decoded cap and rejects one byte more', () => {
    expect(ImageBlockSchema.safeParse(image(IMAGE_MAX_BYTES)).success).toBe(true);
    expect(ImageBlockSchema.safeParse(image(IMAGE_MAX_BYTES + 1)).success).toBe(false);
    expect(ImageBlockSchema.safeParse(image(IMAGE_MAX_BYTES + 2)).success).toBe(false);
  });

  it('accepts a string output of exactly the cap in UTF-8 bytes and rejects one byte more', () => {
    expect(ToolOutputSchema.safeParse('a'.repeat(TOOL_OUTPUT_MAX_BYTES)).success).toBe(true);
    expect(ToolOutputSchema.safeParse('a'.repeat(TOOL_OUTPUT_MAX_BYTES + 1)).success).toBe(false);
  });

  it('counts multi-byte characters by their UTF-8 size', () => {
    const half = TOOL_OUTPUT_MAX_BYTES / 2;
    expect(ToolOutputSchema.safeParse('é'.repeat(half)).success).toBe(true);
    expect(ToolOutputSchema.safeParse('é'.repeat(half + 1)).success).toBe(false);
  });

  it('bounds the total of a block array, text and image data together', () => {
    const text = (bytes: number): unknown => ({ type: 'text', text: 'a'.repeat(bytes) });
    // image(3) serializes as 4 base64 characters, so this totals exactly the cap.
    const fits = [text(TOOL_OUTPUT_MAX_BYTES - 4), image(3)];
    expect(ToolOutputSchema.safeParse(fits).success).toBe(true);
    const tooBig = [text(TOOL_OUTPUT_MAX_BYTES - 3), image(3)];
    expect(ToolOutputSchema.safeParse(tooBig).success).toBe(false);
  });

  it('counts multi-byte text inside a block array by UTF-8 size', () => {
    const half = TOOL_OUTPUT_MAX_BYTES / 2;
    expect(ToolOutputSchema.safeParse([{ type: 'text', text: 'é'.repeat(half) }]).success).toBe(
      true,
    );
    expect(ToolOutputSchema.safeParse([{ type: 'text', text: 'é'.repeat(half + 1) }]).success).toBe(
      false,
    );
  });

  describe('valid multi-block output is never falsely rejected (review D2)', () => {
    const MiB = 1024 * 1024;
    const text = (bytes: number): unknown => ({ type: 'text', text: 'a'.repeat(bytes) });

    it('accepts two 2 MiB ASCII blocks (4 MiB actual)', () => {
      expect(ToolOutputSchema.safeParse([text(2 * MiB), text(2 * MiB)]).success).toBe(true);
    });

    it('accepts four 2 MiB blocks totalling exactly the cap and rejects one byte more', () => {
      const four = [text(2 * MiB), text(2 * MiB), text(2 * MiB), text(2 * MiB)];
      expect(ToolOutputSchema.safeParse(four).success).toBe(true);
      expect(ToolOutputSchema.safeParse([...four, text(1)]).success).toBe(false);
    });

    it('accepts many small blocks just under the cap and rejects them just over', () => {
      const chunk = 1024;
      const count = TOOL_OUTPUT_MAX_BYTES / chunk;
      const under = Array.from({ length: count }, () => text(chunk));
      expect(ToolOutputSchema.safeParse(under).success).toBe(true);
      expect(ToolOutputSchema.safeParse([...under, text(1)]).success).toBe(false);
    });

    it('accepts text plus an image whose combined size is just under the cap', () => {
      // image(3) is 4 base64 characters; 8 MiB - 4 bytes of text fills the cap exactly.
      expect(ToolOutputSchema.safeParse([text(TOOL_OUTPUT_MAX_BYTES - 4), image(3)]).success).toBe(
        true,
      );
      expect(ToolOutputSchema.safeParse([text(TOOL_OUTPUT_MAX_BYTES - 3), image(3)]).success).toBe(
        false,
      );
    });

    it('measures multi-byte text exactly across blocks', () => {
      const twoByte = (units: number): unknown => ({ type: 'text', text: 'é'.repeat(units) });
      expect(ToolOutputSchema.safeParse([twoByte(2 * MiB), twoByte(2 * MiB)]).success).toBe(true);
      expect(
        ToolOutputSchema.safeParse([twoByte(2 * MiB), twoByte(2 * MiB), text(1)]).success,
      ).toBe(false);
    });
  });

  it('rejects many images whose combined size exceeds the output cap', () => {
    const blocks = Array.from({ length: 3 }, () => image(IMAGE_MAX_BYTES));
    expect(ToolOutputSchema.safeParse(blocks).success).toBe(false);
  });
});
