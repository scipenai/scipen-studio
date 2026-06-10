/**
 * @file CSP Configuration - Content Security Policy
 * @description Configures Content-Security-Policy headers for Electron app to restrict resource loading
 * @depends electron.session
 */

import { session } from 'electron';
import { createLogger } from '../services/LoggerService';

const logger = createLogger('CSP');

/**
 * Custom protocol that serves app-bundled WASM engine assets — see
 * {@link file://./../services/WasmAssetProtocol.ts}. The BusyTeX engine
 * touches this scheme three ways, each gated by a different CSP directive:
 *   - `connect-src`: the renderer `fetch()`es `manifest.json` and the
 *     worker `fetch()`es every `texlive-*.js` data-package descriptor.
 *   - `script-src` : the worker `importScripts()` the engine JS, AND
 *     `WebAssembly.instantiate` runs `busytex.wasm` — the latter requires
 *     `'wasm-unsafe-eval'` in production (dev already has `'unsafe-eval'`).
 *   - `worker-src` : belt-and-braces for resources the worker pulls.
 * Omitting any one of these surfaces as an opaque `TypeError: Failed to
 * fetch` (connect) or a silent worker init failure (script/worker).
 */
const WASM_ASSET_SCHEME = 'scipen-wasm:';

/**
 * CSP Directives
 */
export interface CSPDirectives {
  'default-src': string[];
  'script-src': string[];
  'style-src': string[];
  'img-src': string[];
  'font-src': string[];
  'connect-src': string[];
  'media-src': string[];
  'object-src': string[];
  'frame-src': string[];
  'worker-src': string[];
  'base-uri': string[];
  'form-action': string[];
}

/**
 * Development CSP (more permissive)
 */
const DEV_CSP: Partial<CSPDirectives> = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'", WASM_ASSET_SCHEME], // HMR + WASM engine
  'style-src': [
    "'self'",
    "'unsafe-inline'",
    'https://fonts.googleapis.com',
    'https://cdn.jsdelivr.net',
  ], // Google Fonts CSS, KaTeX CDN
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'], // Google Fonts files, KaTeX fonts
  'connect-src': [
    "'self'",
    WASM_ASSET_SCHEME, // BusyTeX manifest + texlive data-package descriptors
    'ws://localhost:*', // WebSocket for HMR
    'http://localhost:*',
    'https://*.openai.com',
    'https://*.anthropic.com',
    'https://*.googleapis.com',
    'https://*.deepseek.com',
    'https://*.aliyuncs.com',
    'https://*.bigmodel.cn',
    'https://*.moonshot.cn',
    'https://*', // Allow all HTTPS for AI providers
  ],
  'media-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'frame-src': ["'self'"],
  'worker-src': ["'self'", 'blob:', WASM_ASSET_SCHEME],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
};

/**
 * Production CSP (more restrictive)
 */
const PROD_CSP: Partial<CSPDirectives> = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'", WASM_ASSET_SCHEME], // WASM engine instantiation + worker importScripts
  'style-src': [
    "'self'",
    "'unsafe-inline'",
    'https://fonts.googleapis.com',
    'https://cdn.jsdelivr.net',
  ], // Google Fonts CSS, KaTeX CDN
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'], // Google Fonts files, KaTeX fonts
  'connect-src': [
    "'self'",
    WASM_ASSET_SCHEME, // BusyTeX manifest + texlive data-package descriptors
    'https://*.openai.com',
    'https://*.anthropic.com',
    'https://*.googleapis.com',
    'https://*.deepseek.com',
    'https://*.aliyuncs.com',
    'https://*.bigmodel.cn',
    'https://*.moonshot.cn',
    'https://*', // AI providers may have various domains
  ],
  'media-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'frame-src': ["'self'"],
  'worker-src': ["'self'", 'blob:', WASM_ASSET_SCHEME],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
};

/**
 * Build CSP header string from directives
 */
function buildCSPString(directives: Partial<CSPDirectives>): string {
  return Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ');
}

/**
 * Setup CSP for the application
 */
export function setupCSP(): void {
  const isDev = process.env.NODE_ENV === 'development' || !!process.env.ELECTRON_RENDERER_URL;
  const csp = isDev ? DEV_CSP : PROD_CSP;
  const cspString = buildCSPString(csp);

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspString],
      },
    });
  });

  logger.info('[Security] CSP configured:', isDev ? 'development' : 'production');
}

/**
 * Add custom connect-src domains (for user-configured AI endpoints)
 */
export function addAllowedConnectSrc(domain: string): void {
  // This would need to be implemented with dynamic CSP updates
  // For now, we use a wildcard in connect-src for AI providers
  logger.info(`[Security] Would add allowed domain: ${domain}`);
}
