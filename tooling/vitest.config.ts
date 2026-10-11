import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Type-aware linting spins up a TypeScript project per test run; give it room.
    testTimeout: 60_000,
    allowOnly: false,
  },
});
