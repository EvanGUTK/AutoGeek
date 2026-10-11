import { createEslintConfig } from './tooling/src/eslint-config.ts';

export default createEslintConfig({
  tsconfigRootDir: import.meta.dirname,
  // Product and test tsconfigs of every workspace package.
  projects: ['./tooling/tsconfig*.json', './packages/*/tsconfig*.json', './apps/*/tsconfig*.json'],
});
