import { describe, expect, it } from 'vitest';
import { findOutsideReads } from './test-io.ts';

describe('findOutsideReads: test code that can observe files outside its own package', () => {
  it.each([
    ['an fs import', "import { readFile } from 'node:fs/promises';\nvoid readFile;\n"],
    [
      'an fs import without the node: prefix',
      "import { readFileSync } from 'fs';\nvoid readFileSync;\n",
    ],
    ['a namespace fs import', "import * as fs from 'node:fs';\nvoid fs;\n"],
    ['an fs/promises import', "import { readdir } from 'fs/promises';\nvoid readdir;\n"],
    ['a re-export from fs', "export { readFile } from 'node:fs/promises';\n"],
    ['a child_process import', "import { execFile } from 'node:child_process';\nvoid execFile;\n"],
    ['a dynamic fs import', "const fs = await import('node:fs');\nvoid fs;\n"],
    [
      'a dynamic import with a computed specifier',
      "const name = 'node:' + 'fs';\nconst fs = await import(name);\nvoid fs;\n",
    ],
    [
      'a dynamic import of a template string',
      'const fs = await import(`node:${"fs"}`);\nvoid fs;\n',
    ],
    ['require()', "const fs = require('node:fs');\nvoid fs;\n"],
    ['import.meta.dirname', 'export const here = import.meta.dirname;\n'],
    ['import.meta.url', 'export const here = import.meta.url;\n'],
    ['import.meta.filename', 'export const here = import.meta.filename;\n'],
    ['__dirname', 'export const here = __dirname;\n'],
    ['process.cwd()', 'export const here = process.cwd();\n'],
  ])('flags %s', (_name, source) => {
    expect(findOutsideReads(source).length).toBeGreaterThan(0);
  });

  it.each([
    [
      'plain unit test code',
      "import { expect, it } from 'vitest';\nit('x', () => { expect(1).toBe(1); });\n",
    ],
    ['a relative import of package code', "import { add } from './add.ts';\nvoid add;\n"],
    ['path helpers that touch no disk', "import { join } from 'node:path';\nvoid join;\n"],
    ['a comment that mentions fs', '// reads node:fs? no.\nexport const x = 1;\n'],
    ['a string that mentions import.meta.dirname', "export const note = 'import.meta.dirname';\n"],
    [
      'a literal dynamic import of package code',
      "const m = await import('./other.ts');\nvoid m;\n",
    ],
  ])('does not flag %s', (_name, source) => {
    expect(findOutsideReads(source)).toEqual([]);
  });

  it('says what it found', () => {
    expect(
      findOutsideReads("import { readFile } from 'node:fs/promises';\nvoid readFile;\n"),
    ).toEqual([expect.stringContaining('node:fs/promises')]);
  });
});
