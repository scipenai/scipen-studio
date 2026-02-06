/**
 * Legacy Vite Configuration
 * 
 * NOTE: This project uses electron-vite.
 * The main configuration is in electron.vite.config.ts.
 * 
 * This file is kept for:
 * 1. Vitest configuration compatibility
 * 2. Tools that don't understand electron-vite
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer/src'),
      '@components': path.resolve(__dirname, './src/renderer/src/components'),
      '@services': path.resolve(__dirname, './src/renderer/src/services'),
      '@store': path.resolve(__dirname, './src/renderer/src/store'),
      '@utils': path.resolve(__dirname, './src/renderer/src/utils'),
      '@shared': path.resolve(__dirname, './packages/shared/src'),
    },
  },
});
