import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEslintConfig } from './eslint-config.ts';

const SAMPLE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2023',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    noEmit: true,
    types: [],
  },
  include: ['*.ts'],
});

let sandbox: string;
let eslint: ESLint;
let counter = 0;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'autogeek-eslint-policy-'));
  await writeFile(join(sandbox, 'tsconfig.json'), SAMPLE_TSCONFIG);
  eslint = new ESLint({
    cwd: sandbox,
    overrideConfigFile: true,
    overrideConfig: createEslintConfig({ tsconfigRootDir: sandbox }),
  });
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

/** Lints `source` as a real file in the sandbox project and returns "ruleId: message" strings. */
async function lint(source: string): Promise<string[]> {
  counter += 1;
  const filePath = join(sandbox, `sample${String(counter)}.ts`);
  await writeFile(filePath, source);
  const [result] = await eslint.lintFiles([filePath]);
  if (result === undefined) {
    throw new Error('ESLint returned no result for the sample file');
  }
  return result.messages.map((m) => `${m.ruleId ?? 'parse'}: ${m.message}`);
}

describe('eslint policy', () => {
  it('accepts well-typed code with no messages', async () => {
    const messages = await lint(
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    );
    expect(messages).toEqual([]);
  });

  it('rejects explicit any', async () => {
    const messages = await lint('export const value: any = JSON.parse("1");\n');
    expect(messages.join('\n')).toContain('@typescript-eslint/no-explicit-any');
  });

  it('rejects @ts-ignore', async () => {
    const messages = await lint('// @ts-ignore\nexport const n: number = "x";\n');
    expect(messages.join('\n')).toContain('@typescript-eslint/ban-ts-comment');
  });

  it('rejects @ts-expect-error', async () => {
    const messages = await lint('// @ts-expect-error because\nexport const n: number = "x";\n');
    expect(messages.join('\n')).toContain('@typescript-eslint/ban-ts-comment');
  });

  it('rejects inline eslint-disable comments', async () => {
    const messages = await lint(
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any -- nope\nexport const value: any = 1;\n',
    );
    const text = messages.join('\n');
    expect(text).toContain('noInlineConfig');
    expect(text).toContain('@typescript-eslint/no-explicit-any');
  });

  it('rejects double assertions through unknown', async () => {
    const messages = await lint('export const n = "x" as unknown as number;\n');
    expect(messages.join('\n')).toContain('no-restricted-syntax');
  });

  it.each(['it.skip', 'it.only', 'it.todo', 'test.skip', 'describe.skip', 'describe.only'])(
    'rejects %s',
    async (call) => {
      const messages = await lint(
        `declare const it: { skip: (n: string) => void };\ndeclare const test: typeof it;\ndeclare const describe: typeof it;\n${call}('x');\n`,
      );
      expect(messages.join('\n')).toContain('no-restricted-syntax');
    },
  );

  it('rejects value imports that are only used as types', async () => {
    const messages = await lint(
      "import { ESLint } from 'eslint';\nexport function f(e: ESLint): ESLint {\n  return e;\n}\n",
    );
    expect(messages.join('\n')).toContain('@typescript-eslint/consistent-type-imports');
  });

  it('rejects empty catch blocks', async () => {
    const messages = await lint(
      'export function f(): void {\n  try {\n    JSON.parse("{");\n  } catch {}\n}\n',
    );
    expect(messages.join('\n')).toContain('no-empty');
  });

  it('rejects floating promises', async () => {
    const messages = await lint('export function f(): void {\n  Promise.resolve(1);\n}\n');
    expect(messages.join('\n')).toContain('@typescript-eslint/no-floating-promises');
  });

  it('rejects non-exhaustive switches over unions', async () => {
    const messages = await lint(
      "export function f(v: 'a' | 'b'): number {\n  switch (v) {\n    case 'a':\n      return 1;\n  }\n  return 0;\n}\n",
    );
    expect(messages.join('\n')).toContain('@typescript-eslint/switch-exhaustiveness-check');
  });
});
