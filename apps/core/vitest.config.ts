import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Many suites make real repos and spawn git and test runners. At the default (one
    // worker per core, less one) those children starve each other and tests that take
    // under a second alone pass 5s. Capped here rather than raising every timeout, which
    // would hide a genuine hang.
    maxWorkers: 4,
  },
});
