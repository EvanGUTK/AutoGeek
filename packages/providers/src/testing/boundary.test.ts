import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');
// Static, side-effect, re-export and dynamic imports whose specifier passes through `testing/`.
const TESTING_IMPORT = /\b(?:from|import)\s*\(?\s*['"][^'"]*\btesting\//;

async function productFiles(): Promise<string[]> {
  const entries = await readdir(SRC, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith('.ts'))
    .filter((entry) => !/\.(test|spec)\.ts$/.test(entry))
    .filter((entry) => !entry.split(/[\\/]/).includes('testing'));
}

describe('src/testing boundary', () => {
  // tsconfig.json excludes src/testing, but tsc still follows imports into excluded files, so
  // the exclusion alone would not stop product code from shipping the fake server.
  it('is never imported by product source', async () => {
    const offenders: string[] = [];
    for (const file of await productFiles()) {
      const text = await readFile(join(SRC, file), 'utf8');
      if (TESTING_IMPORT.test(text)) offenders.push(relative(SRC, join(SRC, file)));
    }
    expect(offenders).toEqual([]);
  });

  it('detects such an import (canary for the pattern)', () => {
    expect(
      TESTING_IMPORT.test("import { startFakeServer } from '../testing/http-server.ts';"),
    ).toBe(true);
    expect(TESTING_IMPORT.test("export * from './testing/x.ts'")).toBe(true);
    expect(TESTING_IMPORT.test("import '../testing/x.ts';")).toBe(true);
    expect(TESTING_IMPORT.test("await import('../testing/x.ts')")).toBe(true);
    expect(TESTING_IMPORT.test("import { x } from './http/transport.ts';")).toBe(false);
  });

  it('scans the product files it should', async () => {
    expect(await productFiles()).toContain(join('http', 'lines.ts'));
  });
});
