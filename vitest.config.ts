import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // These run inside VS Code (npm run test:integration in packages/vscode).
    exclude: ['**/node_modules/**', 'packages/vscode/test/integration/**'],
  },
});
