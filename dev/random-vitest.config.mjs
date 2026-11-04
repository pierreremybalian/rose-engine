// Vitest config for the random/preset preview renderer only: PREVIEW=1 npx vitest run --config dev/random-vitest.config.mjs
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['dev/random-preview.test.mjs'],
    environment: 'node',
    testTimeout: 900_000,
  },
});
