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
    // React 组件测试需要的配置
    css: true,
    deps: {
      optimizer: {
        web: {
          include: ['@testing-library/react', '@testing-library/jest-dom'],
        },
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
