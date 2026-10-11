import { createVitestConfig } from './src/vitest/config.ts';

export default createVitestConfig({
  // Type-aware linting and CLI runs spin up TypeScript projects and child processes.
  testTimeout: 60_000,
});
