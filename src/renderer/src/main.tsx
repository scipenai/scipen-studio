/**
 * @file main.tsx - Renderer process entry
 * @description Main entry point for the React application, responsible for initializing services such as Monaco, KaTeX, and file cache
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
// Monaco Editor Worker environment configuration - must be initialized before Monaco loads
import './components/editor/monaco/environment';
// KaTeX styles - used for rendering LaTeX math formulas
import 'katex/dist/katex.min.css';
// Initialize file cache service
import { fileCache } from './services';
fileCache.initialize();

// Polyfill for URL.parse (Required by some PDF.js versions in older environments)
if (typeof URL.parse !== 'function') {
  (URL as unknown as { parse: (url: string, base?: string) => URL }).parse = (
    url: string,
    base?: string
  ) => new URL(url, base);
}

// Why: Main process IPC handlers are registered after window creation
// Need to wait a short time to ensure handlers are available
// This is a trade-off: avoid complex ready signal mechanism
const STARTUP_DELAY_MS = 100;

setTimeout(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}, STARTUP_DELAY_MS);

console.log('[App] SciPen Studio started');
