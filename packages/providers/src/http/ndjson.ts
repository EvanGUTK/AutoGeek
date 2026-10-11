import { err, ok } from '@autogeek/core';
import type { Result } from '@autogeek/core';
import { createLineDecoder } from './lines.ts';

export interface NdjsonDecoderError {
  readonly kind: 'line_too_long' | 'invalid_json';
}

export interface NdjsonDecoderOptions {
  /** Maximum line length in UTF-16 code units. */
  readonly maxLineLength: number;
}

export interface NdjsonDecoder {
  /** Parses the lines a chunk completed. Values are unvalidated: the caller parses them with zod. */
  push(chunk: Uint8Array): Result<unknown[], NdjsonDecoderError>;
  /** Parses a final line that had no trailing newline. */
  end(): Result<unknown[], NdjsonDecoderError>;
}

/** Newline-delimited JSON (Ollama's native streaming format). Blank lines are skipped. */
export function createNdjsonDecoder(options: NdjsonDecoderOptions): NdjsonDecoder {
  const lines = createLineDecoder({ maxLineLength: options.maxLineLength });
  let failed: NdjsonDecoderError | undefined;

  function parseLines(input: readonly string[]): Result<unknown[], NdjsonDecoderError> {
    const values: unknown[] = [];
    for (const line of input) {
      if (line.trim() === '') continue;
      const parsed = parseJson(line);
      if (!parsed.ok) {
        failed = parsed.error;
        return parsed;
      }
      values.push(parsed.value);
    }
    return ok(values);
  }

  return {
    push(chunk) {
      if (failed !== undefined) return err(failed);
      const decoded = lines.push(chunk);
      if (!decoded.ok) {
        failed = decoded.error;
        return err(failed);
      }
      return parseLines(decoded.value);
    },
    end() {
      if (failed !== undefined) return err(failed);
      return parseLines(lines.end());
    },
  };
}

function parseJson(text: string): Result<unknown, NdjsonDecoderError> {
  try {
    const value: unknown = JSON.parse(text);
    return ok(value);
  } catch (error) {
    if (error instanceof SyntaxError) return err({ kind: 'invalid_json' });
    throw error;
  }
}
