import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/services/**', 'src/routes/**', 'src/utils/**'],
    },
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
