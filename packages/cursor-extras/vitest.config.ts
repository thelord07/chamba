import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromHere = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@chamba/core': fromHere('../core/src/index.ts'),
      '@chamba/adapters': fromHere('../adapters/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
