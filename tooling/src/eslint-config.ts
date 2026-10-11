import eslint from '@eslint/js';
import type { Linter } from 'eslint';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export interface EslintConfigOptions {
  /** Directory that the `projects` globs are relative to. */
  readonly tsconfigRootDir: string;
  /**
   * tsconfig files (globs) that type-aware rules resolve against. Every linted TypeScript file
   * must belong to one of them. Packages have a product tsconfig.json that EXCLUDES tests and a
   * tsconfig.test.json that includes them, so the nearest-tsconfig lookup of `projectService`
   * is not enough. Defaults to the root tsconfig.json.
   */
  readonly projects?: readonly string[];
}

// Any assertion whose operand is itself an assertion (`as unknown as T`, `as never as T`,
// `<T>(<unknown>x)`, ...) is a way around the type system.
const CHAINED_ASSERTION = {
  selector:
    ':matches(TSAsExpression, TSTypeAssertion) > :matches(TSAsExpression, TSTypeAssertion).expression',
  message: 'Chained type assertions defeat the type system. Validate with zod or narrow properly.',
};

// Matched on the rightmost property of ANY member chain, not on the callee name, so aliased
// imports, extended tests and chained modifiers (`it.concurrent.skip`) cannot dodge it. Only
// applied to test files: product code legitimately has `cursor.skip(2)` or a `filter.only`.
// Runtime skips are also caught after the fact by the FailOnSkippedReporter in the shared
// Vitest config, which is the authoritative gate; this rule is the early signal.
const DISABLED_TEST_MODIFIERS = '/^(skip|only|todo|skipIf|runIf|fails)$/';
const SKIPPED_TEST_MESSAGE =
  'Skipped, focused, or todo tests are not allowed. Write the test or delete it.';
const SKIPPED_TEST_SELECTORS = [
  {
    selector: `MemberExpression[computed=false][property.name=${DISABLED_TEST_MODIFIERS}]`,
    message: SKIPPED_TEST_MESSAGE,
  },
  {
    selector: `MemberExpression[computed=true][property.value=${DISABLED_TEST_MODIFIERS}]`,
    message: SKIPPED_TEST_MESSAGE,
  },
];

const TEST_FILES = ['**/*.{test,spec}.{ts,tsx,mts,cts}', '**/vitest.setup.{ts,mts}'];

/**
 * The repo-wide lint policy. Everything here is an error: `pnpm lint` runs with
 * `--max-warnings 0`, and inline configuration is disabled so no file can opt out.
 */
export function createEslintConfig(options: EslintConfigOptions): Linter.Config[] {
  return defineConfig(
    {
      ignores: [
        '**/node_modules/**',
        '**/dist/**',
        '**/out/**',
        '**/.turbo/**',
        '**/coverage/**',
        '.agents/**',
      ],
    },
    {
      linterOptions: {
        noInlineConfig: true,
        reportUnusedDisableDirectives: 'error',
      },
    },
    eslint.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          project: [...(options.projects ?? ['./tsconfig.json'])],
          tsconfigRootDir: options.tsconfigRootDir,
        },
      },
      rules: {
        'no-empty': ['error', { allowEmptyCatch: false }],
        eqeqeq: ['error', 'always'],
        '@typescript-eslint/consistent-type-imports': 'error',
        // strictTypeChecked still allows @ts-expect-error with a 10+ character description.
        // AGENT-PROTOCOL §1 bans it outright.
        '@typescript-eslint/ban-ts-comment': [
          'error',
          { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false },
        ],
        '@typescript-eslint/switch-exhaustiveness-check': [
          'error',
          { considerDefaultExhaustiveForUnions: false },
        ],
        'no-restricted-syntax': ['error', CHAINED_ASSERTION],
        // Not part of strictTypeChecked. Catches `JSON.parse(raw) as Config` and `cast<T>(x: unknown)`.
        '@typescript-eslint/no-unsafe-type-assertion': 'error',
      },
    },
    {
      // Flat config replaces rule options wholesale, so repeat the chained-assertion selector.
      files: TEST_FILES,
      rules: {
        'no-restricted-syntax': ['error', CHAINED_ASSERTION, ...SKIPPED_TEST_SELECTORS],
      },
    },
    {
      files: ['**/*.{js,mjs,cjs}'],
      extends: [tseslint.configs.disableTypeChecked],
    },
  );
}
