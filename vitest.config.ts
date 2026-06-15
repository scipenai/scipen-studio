import { defineConfig } from 'vitest/config';
import path from 'path';
import react from '@vitejs/plugin-react-swc';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    exclude: ['node_modules', 'out', 'dist', 'release', 'tests/e2e/**'],
    setupFiles: ['./tests/renderer/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'out/**',
        'dist/**',
        'tests/**',
        '**/*.d.ts',
        '**/*.config.*',
      ],
    },
    testTimeout: 10000,
    // CI Windows runners (cold IO + slow module resolution) routinely
    // push beforeAll/beforeEach `await import(...)` past vitest's default
    // 10s hookTimeout — observed for AIService / ConfigManager tests that
    // re-import on every case via `vi.resetModules()`. 30s is comfortable
    // for the slowest CI hooks while still bounding genuinely stuck ones.
    hookTimeout: 30000,
    // React 组件测试需要的配置
    css: true,
    deps: {
      optimizer: {
        web: {
          include: ['@testing-library/react', '@testing-library/jest-dom'],
        },
      },
    },
    // node:sqlite is a Node 22.5+ built-in; vitest's bundler can't resolve
    // it on its own. Pass the experimental flag (Node 22 needs it, Node 24
    // ignores it) and mark it server-external so vite leaves the import
    // alone.
    server: {
      deps: {
        external: [/^node:sqlite$/],
      },
    },
    poolOptions: {
      forks: {
        execArgv: ['--experimental-sqlite'],
      },
      threads: {
        execArgv: ['--experimental-sqlite'],
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer/src'),
      '@components': path.resolve(__dirname, './src/renderer/src/components'),
      '@services': path.resolve(__dirname, './src/renderer/src/services'),
      '@store': path.resolve(__dirname, './src/renderer/src/store'),
      '@utils': path.resolve(__dirname, './src/renderer/src/utils'),
      '@main': path.resolve(__dirname, './src/main'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
});
