/**
 * @file MarkdownAssetResolver.ts - Markdown asset and link resolver
 * @description Resolves relative and project-root asset paths into preview-safe URLs or local file targets.
 */

import { api } from '../api';
import type { MarkdownRenderDiagnostic } from '../types';

export interface MarkdownAssetResolveContext {
  filePath: string | null;
  projectPath: string | null;
}

export interface MarkdownAssetResolveResult {
  kind: 'external' | 'anchor' | 'local-file' | 'unresolved';
  value: string;
  url?: string;
  diagnostics?: MarkdownRenderDiagnostic[];
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'file:']);

export class MarkdownAssetResolver {
  private readonly existsCache = new Map<string, boolean>();

  async resolve(
    pathLike: string,
    context: MarkdownAssetResolveContext
  ): Promise<MarkdownAssetResolveResult> {
    if (!pathLike) {
      return { kind: 'unresolved', value: pathLike };
    }

    if (pathLike.startsWith('#')) {
      return { kind: 'anchor', value: pathLike, url: pathLike };
    }

    const protocolMatch = pathLike.match(/^([a-zA-Z][a-zA-Z+.-]*:)/);
    if (protocolMatch) {
      const protocol = protocolMatch[1].toLowerCase();
      if (!ALLOWED_PROTOCOLS.has(protocol)) {
        return {
          kind: 'unresolved',
          value: pathLike,
          diagnostics: [
            { type: 'blocked-protocol', message: `Blocked protocol: ${protocol}`, value: pathLike },
          ],
        };
      }

      if (protocol === 'file:') {
        try {
          const url = new URL(pathLike);
          const localPath = decodeURIComponent(url.pathname).replace(/^\//, '');
          return this.resolveLocalPath(localPath, pathLike);
        } catch {
          return { kind: 'unresolved', value: pathLike };
        }
      }

      return { kind: 'external', value: pathLike, url: pathLike };
    }

    const [rawPath, hash = ''] = pathLike.split('#');
    const absolutePath = this.resolveAbsolutePath(rawPath, context);
    if (!absolutePath) {
      return { kind: 'unresolved', value: pathLike };
    }

    const resolved = await this.resolveLocalPath(absolutePath, pathLike);
    if (resolved.kind === 'local-file' && hash) {
      resolved.value = `${resolved.value}#${hash}`;
    }
    return resolved;
  }

  private resolveAbsolutePath(
    pathLike: string,
    context: MarkdownAssetResolveContext
  ): string | null {
    const normalized = pathLike.replace(/\\/g, '/');
    if (!normalized) return context.filePath;

    if (normalized.startsWith('/')) {
      if (!context.projectPath) return null;
      return `${context.projectPath.replace(/\\/g, '/').replace(/\/$/, '')}/${normalized.replace(/^\//, '')}`;
    }

    const filePath = context.filePath?.replace(/\\/g, '/');
    if (!filePath) return null;
    const baseDir = filePath.includes('/')
      ? filePath.slice(0, filePath.lastIndexOf('/'))
      : filePath;
    return this.normalizeSegments(`${baseDir}/${normalized}`);
  }

  private normalizeSegments(pathLike: string): string {
    const isWindowsDrive = /^[A-Za-z]:\//.test(pathLike);
    const parts = pathLike.split('/');
    const stack: string[] = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (stack.length > 0 && stack[stack.length - 1] !== '..') {
          stack.pop();
        }
        continue;
      }
      stack.push(part);
    }
    return isWindowsDrive ? `${stack.shift()}/${stack.join('/')}` : `/${stack.join('/')}`;
  }

  private async resolveLocalPath(
    localPath: string,
    original: string
  ): Promise<MarkdownAssetResolveResult> {
    const normalized = localPath.replace(/\\/g, '/');
    const exists = await this.exists(normalized);
    if (!exists) {
      return {
        kind: 'unresolved',
        value: original,
        diagnostics: [{ type: 'asset-not-found', message: 'Asset not found', value: normalized }],
      };
    }

    return {
      kind: 'local-file',
      value: normalized,
      url: api.file.getLocalFileUrl(normalized),
    };
  }

  private async exists(pathLike: string): Promise<boolean> {
    if (this.existsCache.has(pathLike)) {
      return this.existsCache.get(pathLike)!;
    }
    const exists = await api.file.exists(pathLike);
    this.existsCache.set(pathLike, exists);
    return exists;
  }
}
