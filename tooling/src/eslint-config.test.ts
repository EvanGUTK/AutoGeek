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
async function lint(source: string, suffix = '.ts'): Promise<string[]> {
  counter += 1;
  const filePath = join(sandbox, `sample${String(counter)}${suffix}`);
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

  it('rejects @ts-expect-error even with a long explanatory description', async () => {
    const messages = await lint(
      '// @ts-expect-error: the upstream library typings are wrong here, see issue 1234\nexport const n: number = "x";\n',
    );
    expect(messages.join('\n')).toContain('@typescript-eslint/ban-ts-comment');
  });

  it('rejects @ts-nocheck', async () => {
    const messages = await lint(
      '// @ts-nocheck: generated file with a very long reason\nexport const n = 1;\n',
    );
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

  it.each([
    ['unknown', 'export const n = "x" as unknown as number;\n'],
    ['never', 'export const n = "x" as never as number;\n'],
    ['parenthesized', 'export const n = ("x" as unknown) as number;\n'],
    ['angle brackets', 'export const n = <number>(<unknown>"x");\n'],
    ['mixed', 'export const n = <number>("x" as unknown);\n'],
  ])('rejects double assertions (%s)', async (_name, source) => {
    const messages = await lint(source);
    expect(messages.join('\n')).toContain('no-restricted-syntax');
  });

  it('still allows a single assertion and as const', async () => {
    const messages = await lint(
      'export const tuple = [1, 2] as const;\nexport const n = (JSON.parse("1") as { a: number }).a;\n',
    );
    expect(messages.filter((m) => m.startsWith('no-restricted-syntax'))).toEqual([]);
  });

  it.each(['it.skip', 'it.only', 'it.todo', 'test.skip', 'describe.skip', 'describe.only'])(
    'rejects %s',
    async (call) => {
      const messages = await lint(
        `declare const it: { skip: (n: string) => void };\ndeclare const test: typeof it;\ndeclare const describe: typeof it;\n${call}('x');\n`,
        '.test.ts',
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

  it.each([
    ['a chained modifier', "it.concurrent.skip('x');"],
    ['a chained only', "describe.concurrent.only('x');"],
    ['an aliased import', "spec.skip('x');"],
    ['an extended test', "test.extend({}).skip('x');"],
    ['a derived test', "mine.skipIf(true)('x');"],
    ['runIf', "it.runIf(false)('x');"],
    ['a runtime ctx.skip()', 'ctx.skip();'],
    ['a computed property', "it['skip']('x');"],
  ])('rejects skipping through %s', async (_name, call) => {
    const messages = await lint(
      `declare const it: { concurrent: { skip: (n: string) => void }; runIf: (c: boolean) => (n: string) => void; skip: (n: string) => void };\n` +
        `declare const describe: { concurrent: { only: (n: string) => void } };\n` +
        `declare const spec: { skip: (n: string) => void };\n` +
        `declare const test: { extend: (o: object) => { skip: (n: string) => void } };\n` +
        `declare const mine: { skipIf: (c: boolean) => (n: string) => void };\n` +
        `declare const ctx: { skip: () => void };\n${call}\n`,
      '.test.ts',
    );
    expect(messages.join('\n')).toContain('no-restricted-syntax');
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
