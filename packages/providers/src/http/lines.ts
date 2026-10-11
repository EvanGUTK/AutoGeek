import { err, ok } from '@autogeek/core';
import type { Result } from '@autogeek/core';

export interface LineDecoderError {
  readonly kind: 'line_too_long';
}

export interface LineDecoderOptions {
  /** Maximum line length in UTF-16 code units, checked while the line is still incomplete. */
  readonly maxLineLength: number;
}

export interface LineDecoder {
  /** Decodes a chunk and returns the lines it completed. Fails permanently once a limit is hit. */
  push(chunk: Uint8Array): Result<string[], LineDecoderError>;
  /** Returns the final unterminated line, if any. */
  end(): string[];
}

/**
 * Splits a UTF-8 byte stream into lines on LF, CR or CRLF (the SSE rule; NDJSON uses it too
 * because JSON text never contains a raw CR or LF). Multi-byte characters and CRLF may be split
 * across chunks. A leading byte order mark is stripped; invalid UTF-8 becomes U+FFFD.
 */
export function createLineDecoder(options: LineDecoderOptions): LineDecoder {
  const text = new TextDecoder('utf-8');
  let partial = '';
  // A CR ended the previous chunk, so an LF at the start of the next one belongs to it.
  let skipLeadingLf = false;
  let failed = false;

  function split(input: string): Result<string[], LineDecoderError> {
    const lines: string[] = [];
    let start = 0;
    if (skipLeadingLf && input.startsWith('\n')) start = 1;
    if (input.length > 0) skipLeadingLf = false;
    for (let index = start; index < input.length; index += 1) {
      const char = input[index];
      if (char !== '\n' && char !== '\r') continue;
      const line = partial + input.slice(start, index);
      partial = '';
      if (line.length > options.maxLineLength) return fail();
      lines.push(line);
      if (char === '\r') {
        if (index + 1 === input.length) skipLeadingLf = true;
        else if (input[index + 1] === '\n') index += 1;
      }
      start = index + 1;
    }
    partial += input.slice(start);
    if (partial.length > options.maxLineLength) return fail();
    return ok(lines);
  }

  function fail(): Result<string[], LineDecoderError> {
    failed = true;
    partial = '';
    return err({ kind: 'line_too_long' });
  }

  return {
    push(chunk) {
      if (failed) return err({ kind: 'line_too_long' });
      return split(text.decode(chunk, { stream: true }));
    },
    end() {
      if (failed) return [];
      const result = split(text.decode());
      const lines = result.ok ? result.value : [];
      if (partial.length > 0) lines.push(partial);
      partial = '';
      return lines;
    },
  };
}
