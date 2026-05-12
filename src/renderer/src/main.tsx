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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

console.info('[App] SciPen Studio started');
