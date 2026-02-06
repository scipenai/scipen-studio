/**
 * @file LocalFileProtocol - Secure local file protocol handler
 * @description Serves local files via Electron custom protocol to avoid IPC overhead
 * @depends electron protocol/net, fs/promises
 */

import * as path from 'path';
import { net, protocol } from 'electron';
import * as fs from 'fs/promises';
import { createLogger } from './LoggerService';

const logger = createLogger('LocalFileProtocol');

// ====== Security Policy ======

// Allowlist of file extensions to limit local file exposure.
const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.eps',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
]);

// Protocol name.
export const LOCAL_FILE_PROTOCOL = 'scipen-file';

// Registration guard to avoid double registration.
let isRegistered = false;

// Allowlist of directories (default deny).
const allowedDirectories: Set<string> = new Set();

// ====== Public API ======

/**
 * Adds a directory to the allowlist.
 * @sideeffect Updates allowlist and logs access policy change
 */
export function addAllowedDirectory(dirPath: string): void {
  const normalized = path.normalize(dirPath).toLowerCase();
  allowedDirectories.add(normalized);
  logger.info(`[LocalFileProtocol] Allowed directory added: ${normalized}`);
}

/**
 * Clears all allowlisted directories.
 * @sideeffect Removes allowlist and logs access policy change
 */
export function clearAllowedDirectories(): void {
  allowedDirectories.clear();
  logger.info('[LocalFileProtocol] Cleared all allowed directories');
}

/**
 * Checks whether a path is inside the allowlist.
 *
 * @security Default-deny: only allow explicitly whitelisted directories.
 * This prevents renderer access to arbitrary local files before a project opens.
 */
function isPathAllowed(filePath: string): boolean {
  // Default deny until at least one allowlist entry is configured.
  if (allowedDirectories.size === 0) {
    logger.warn('[LocalFileProtocol] Access denied: allowlist is empty');
    return false;
  }

  const normalized = path.normalize(filePath).toLowerCase();

  for (const allowedDir of allowedDirectories) {
    if (normalized.startsWith(allowedDir)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether file extension is allowed.
 */
function isExtensionAllowed(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

/**
 * Resolves MIME type based on file extension.
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();

  const mimeTypes: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.eps': 'application/postscript',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Registers the custom local file protocol.
 * @sideeffect Binds protocol handlers; call after app.whenReady()
 * @note protocol.registerSchemesAsPrivileged must be called before app.whenReady()
 */
export function registerLocalFileProtocol(): void {
  if (isRegistered) {
    logger.info('[LocalFileProtocol] Protocol already registered, skipping');
    return;
  }

  try {
    // Use protocol.handle (Electron 25+) to support modern fetch handling.
    protocol.handle(LOCAL_FILE_PROTOCOL, async (request) => {
      try {
        // Parse URL to get file path.
        const url = new URL(request.url);
        let filePath = decodeURIComponent(url.pathname);

        // Windows paths may include a leading slash from URL parsing.
        if (process.platform === 'win32' && filePath.startsWith('/')) {
          filePath = filePath.substring(1);
        }

        logger.info(`[LocalFileProtocol] File request: ${filePath}`);

        // Enforce extension allowlist.
        if (!isExtensionAllowed(filePath)) {
          console.warn(`[LocalFileProtocol] Access denied: disallowed file type ${filePath}`);
          return new Response('Forbidden: File type not allowed', { status: 403 });
        }

        // Enforce directory allowlist.
        if (!isPathAllowed(filePath)) {
          console.warn(`[LocalFileProtocol] Access denied: path not in allowlist ${filePath}`);
          return new Response('Forbidden: Path not allowed', { status: 403 });
        }

        // Stat async to avoid blocking the main process.
        let stats;
        try {
          stats = await fs.stat(filePath);
        } catch {
          console.warn(`[LocalFileProtocol] File not found: ${filePath}`);
          return new Response('Not Found', { status: 404 });
        }

        if (!stats.isFile()) {
          return new Response('Not a file', { status: 400 });
        }

        // Use net.fetch to support range requests.
        const fileUrl = `file://${process.platform === 'win32' ? '/' : ''}${filePath.replace(/\\/g, '/')}`;
        const response = await net.fetch(fileUrl, {
          headers: request.headers,
        });

        // Set correct Content-Type for renderer usage.
        const mimeType = getMimeType(filePath);
        const headers = new Headers(response.headers);
        headers.set('Content-Type', mimeType);
        headers.set('Cache-Control', 'public, max-age=31536000'); // 1 year cache

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        console.error('[LocalFileProtocol] Failed to handle request:', error);
        return new Response('Internal Server Error', { status: 500 });
      }
    });

    isRegistered = true;
    logger.info(`[LocalFileProtocol] Custom protocol registered: ${LOCAL_FILE_PROTOCOL}://`);
  } catch (error) {
    console.error('[LocalFileProtocol] Protocol registration failed:', error);
  }
}

/**
 * Builds a custom protocol URL for a local file.
 */
export function getLocalFileUrl(filePath: string): string {
  // Normalize path to keep separators consistent.
  const normalized = path.normalize(filePath);
  // Encode path while preserving slashes.
  const encoded = encodeURIComponent(normalized).replace(/%2F/g, '/').replace(/%5C/g, '/');
  return `${LOCAL_FILE_PROTOCOL}:///${encoded}`;
}

/**
 * Registers protocol scheme as privileged before app ready.
 * @sideeffect Grants secure scheme privileges for custom protocol
 */
export function registerProtocolSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_FILE_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true, // Enable streaming responses.
      },
    },
  ]);
  logger.info(`[LocalFileProtocol] Protocol scheme privileged: ${LOCAL_FILE_PROTOCOL}://`);
}
