import { createEslintConfig } from './tooling/src/eslint-config.ts';

export default createEslintConfig({ tsconfigRootDir: import.meta.dirname });
