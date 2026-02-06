/**
 * @file environment.ts - Monaco Worker Environment Config
 * @description Configures Monaco language service workers for improved editor performance
 */

// Vite's ?worker imports don't have traditional exports - this is expected
// eslint-disable-next-line import/default
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
// eslint-disable-next-line import/default
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
// eslint-disable-next-line import/default
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
// eslint-disable-next-line import/default
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
// eslint-disable-next-line import/default
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker?: (workerId: string, label: string) => Worker;
    };
  }
}

/**
 * Initialize Monaco Worker environment
 *
 * Returns the appropriate Worker instance based on language type
 * - JSON: json.worker
 * - CSS/SCSS/LESS: css.worker
 * - HTML/Handlebars/Razor: html.worker
 * - TypeScript/JavaScript: ts.worker
 * - Others: generic editor.worker (including custom languages like LaTeX and Typst)
 */
window.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) => {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};
