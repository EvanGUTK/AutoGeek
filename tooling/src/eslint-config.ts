import eslint from '@eslint/js';
import type { Linter } from 'eslint';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export interface EslintConfigOptions {
  /** Directory that contains the tsconfig.json files type-aware rules resolve against. */
  readonly tsconfigRootDir: string;
}

// Matched on the rightmost property of ANY member chain, not on the callee name, so aliased
// imports, extended tests and chained modifiers (`it.concurrent.skip`) cannot dodge it. Runtime
// skips are also caught after the fact by the FailOnSkippedReporter in the shared Vitest config.
const DISABLED_TEST_MODIFIERS = '/^(skip|only|todo|skipIf|runIf|fails)$/';

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
          projectService: true,
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
        'no-restricted-syntax': [
          'error',
          {
            // Any assertion whose operand is itself an assertion (`as unknown as T`,
            // `as never as T`, `<T>(<unknown>x)`, ...) is a way around the type system.
            selector:
              ':matches(TSAsExpression, TSTypeAssertion) > :matches(TSAsExpression, TSTypeAssertion).expression',
            message:
              'Chained type assertions defeat the type system. Validate with zod or narrow properly.',
          },
          {
            selector: `MemberExpression[computed=false][property.name=${DISABLED_TEST_MODIFIERS}]`,
            message:
              'Skipped, focused, or todo tests are not allowed. Write the test or delete it.',
          },
          {
            selector: `MemberExpression[computed=true][property.value=${DISABLED_TEST_MODIFIERS}]`,
            message:
              'Skipped, focused, or todo tests are not allowed. Write the test or delete it.',
          },
        ],
      },
    },
    {
      files: ['**/*.{js,mjs,cjs}'],
      extends: [tseslint.configs.disableTypeChecked],
    },
  );
}
