import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'server/src/**/*.test.ts',
      'shared/src/**/*.test.ts',
      'pi-runner/src/**/*.test.ts',
      'web/src/**/*.test.{ts,tsx}',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/data/**'],
  },
});
