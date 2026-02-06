/**
 * @file OverleafCompiler - Remote Overleaf compilation service
 * @description Based on Overleaf-Workshop implementation
 * @depends socket.io-client, LogParserClient, SecureStorageService
 *
 * Features:
 * - Cookie/password login authentication
 * - Remote compilation (incremental compile support)
 * - SyncTeX bidirectional synchronization
 * - Project file management
 * - Compilation log parsing
 * - Socket.IO document content retrieval
 */

import { createRequire } from 'module';
import { lookup as lookupMimeType } from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { SimpleDelayer } from '../../../shared/utils';
import { type ParseResult, getLogParserClient } from '../workers/LogParserClient';
import { setOverleafCookies } from './SecureStorageService';

// Using Overleaf's forked legacy socket.io-client (0.9.17)
// Since it's a CommonJS module, need to use createRequire to import
const require = createRequire(import.meta.url);
const socketio = require('socket.io-client');

export interface OverleafIdentity {
  csrfToken: string;
  cookies: string;
  userId?: string;
}

export interface ParsedLogEntry {
  line: number | null;
  file: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  content: string;
  raw: string;
}

export interface OverleafCompileResult {
  success: boolean;
  status: 'success' | 'failure' | 'error' | 'compiling' | 'timedout' | 'terminated';
  pdfUrl?: string;
  logUrl?: string;
  logContent?: string; // Raw log content
  buildId?: string;
  errors?: string[];
  warnings?: string[];
  outputFiles?: Array<{
    path: string;
    url: string;
    type: string;
    build: string;
  }>;
  parsedErrors?: ParsedLogEntry[];
  parsedWarnings?: ParsedLogEntry[];
  parsedInfo?: ParsedLogEntry[];
}

// ============ LaTeX Log Parser (Worker-based) ============
// Log parsing is offloaded to a worker thread to prevent UI freezes.
// See: src/main/workers/logParser.worker.ts

/** Falls back to empty result if worker fails */
async function parseLatexLogAsync(text: string): Promise<ParseResult> {
  try {
    const client = getLogParserClient();
    return await client.parse(text);
  } catch (error) {
    console.error('[OverleafCompiler] Log parser worker failed:', error);
    // Return empty result on failure
    return { errors: [], warnings: [], info: [] };
  }
}

// ====== Overleaf API Response Types ======

interface OverleafProjectsResponse {
  projects?: OverleafProjectItem[];
}

interface OverleafProjectItem {
  _id?: string;
  id?: string;
  name: string;
  lastUpdated?: string;
}

interface OverleafCompileResponse {
  status: 'success' | 'failure' | 'error' | 'compiling' | 'timedout' | 'terminated';
  outputFiles?: OverleafOutputFile[];
  compileGroup?: string;
}

interface OverleafOutputFile {
  path: string;
  url: string;
  type: string;
  build: string;
}

interface JoinProjectResponse {
  project?: ProjectDetails;
  privilegeLevel?: string;
  protocolVersion?: number;
}

interface SocketErrorResponse {
  message?: string;
  code?: string;
}

/** Legacy Socket.IO 0.9.x interface */
interface LegacySocketIO {
  on(event: string, callback: (...args: unknown[]) => void): void;
  off?(event: string, callback: (...args: unknown[]) => void): void;
  removeListener?(event: string, callback: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  disconnect(): void;
  socket?: {
    connected: boolean;
    id?: string;
  };
  // Runtime extended async emit method
  emitAsync?: (event: string, ...args: unknown[]) => Promise<unknown[]>;
}

export interface OverleafConfig {
  serverUrl: string;
  email?: string;
  password?: string;
  cookies?: string;
  projectId?: string;
}

export interface SyncCodeResult {
  pdf: Array<{
    page: number;
    h: number;
    v: number;
    width: number;
    height: number;
  }>;
}

export interface SyncPdfResult {
  code: Array<{
    file: string;
    line: number;
    column: number;
  }>;
}

export interface OverleafProject {
  id: string;
  name: string;
  lastUpdated: string;
  owner?: {
    id: string;
    email: string;
    firstName?: string;
    lastName?: string;
  };
  accessLevel?: 'owner' | 'readAndWrite' | 'readOnly';
  compiler?: string;
  rootDocId?: string;
}

export interface FileEntity {
  _id: string;
  name: string;
  type: 'doc' | 'file' | 'folder';
  linkedFileData?: {
    provider: string;
    source_project_id?: string;
    source_entity_path?: string;
  };
}

export interface FolderEntity extends FileEntity {
  type: 'folder';
  docs: FileEntity[];
  fileRefs: FileEntity[];
  folders: FolderEntity[];
}

export interface ProjectDetails {
  _id: string;
  name: string;
  rootDoc_id: string;
  rootFolder: FolderEntity[];
  compiler: string;
  spellCheckLanguage: string;
  members: Array<{
    _id: string;
    email: string;
    privileges: string;
  }>;
  owner: {
    _id: string;
    email: string;
    first_name?: string;
    last_name?: string;
  };
}

interface SocketConnection {
  socket: LegacySocketIO;
  projectId: string;
  connected: boolean;
  project?: ProjectDetails;
}

interface DocCache {
  content: string;
  version: number;
  timestamp: number;
}

interface PendingUpdate {
  docId: string;
  content: string;
  delayer: SimpleDelayer<{ success: boolean }>;
  promise: Promise<{ success: boolean }>;
}

const CACHE_CONFIG = {
  DOC_CACHE_TTL: 5 * 60 * 1000, // Document cache TTL: 5 minutes
  PROJECT_CACHE_TTL: 10 * 60 * 1000, // Project details cache TTL: 10 minutes
  UPDATE_DEBOUNCE_MS: 500, // Update debounce: 500ms
  MAX_BATCH_SIZE: 10, // Max batch update count
};

export class OverleafCompiler {
  private config: OverleafConfig;
  private identity: OverleafIdentity | null = null;
  private lastBuildId: string | null = null;
  private editorId: string;
  private socketConnection: SocketConnection | null = null;
  private docCache: Map<string, DocCache> = new Map();
  private projectDetailsCache: Map<string, { details: ProjectDetails; timestamp: number }> =
    new Map();

  // Debounced update queue
  private pendingUpdates: Map<string, PendingUpdate> = new Map();

  constructor(config: OverleafConfig) {
    this.config = config;
    // Generate unique editor ID for SyncTeX
    this.editorId = uuidv4();
  }

  // ==================== 🔒 P2: HTTP Timeout and Retry Utilities ====================

  private async fetchWithRetry(
    url: string,
    options: RequestInit = {},
    config: {
      timeout?: number;
      maxRetries?: number;
      retryDelay?: number;
      retryOn?: number[];
    } = {}
  ): Promise<Response> {
    const {
      timeout = 30000, // Default 30 second timeout
      maxRetries = 2,
      retryDelay = 1000,
      retryOn = [502, 503, 504], // Only retry on gateway errors
    } = config;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // If retryable error code, continue retry
        if (retryOn.includes(response.status) && attempt < maxRetries) {
          console.warn(
            `[OverleafCompiler] HTTP ${response.status}, retry ${attempt + 1}/${maxRetries}...`
          );
          await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
          continue;
        }

        return response;
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new Error(`Request timeout (${timeout}ms): ${url}`);
        } else {
          lastError = error instanceof Error ? error : new Error(String(error));
        }

        if (attempt < maxRetries) {
          console.warn(
            `[OverleafCompiler] Request failed, retry ${attempt + 1}/${maxRetries}...`,
            lastError.message
          );
          await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
        }
      }
    }

    throw lastError || new Error(`Request failed: ${url}`);
  }

  // ==================== Socket.IO Connection Management ====================

  /** Call after file operations to force fresh data on next fetch */
  invalidateProjectCache(projectId: string): void {
    // Clear project details cache
    this.projectDetailsCache.delete(projectId);

    // Disconnect Socket.IO, force fresh data on next connection
    if (this.socketConnection?.projectId === projectId) {
      if (this.socketConnection.socket) {
        this.socketConnection.socket.disconnect();
      }
      this.socketConnection = null;
    }
  }

  private async updateCookiesForSocket(): Promise<void> {
    if (!this.identity) return;

    try {
      const response = await fetch(`${this.config.serverUrl}/socket.io/socket.io.js`, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Connection: 'keep-alive',
          Cookie: this.identity.cookies,
        },
      });

      const setCookie = response.headers.get('set-cookie');
      if (setCookie) {
        const newCookie = setCookie.split(';')[0];
        if (newCookie) {
          this.identity.cookies = `${this.identity.cookies}; ${newCookie}`;
        }
      }
    } catch (error) {
      console.error('[OverleafCompiler] Failed to update cookies:', error);
    }
  }

  /** Uses V2 protocol (projectId in URL) with legacy socket.io 0.9.17 */
  private async connectAndJoinProject(projectId: string): Promise<SocketConnection | null> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    // If already connected to same project, return directly
    if (this.socketConnection?.connected && this.socketConnection.projectId === projectId) {
      return this.socketConnection;
    }

    // Disconnect old connection
    if (this.socketConnection?.socket) {
      this.socketConnection.socket.disconnect();
      this.socketConnection = null;
    }

    // Connect using V2 protocol
    return this.connectV2(projectId);
  }

  private async connectV2(projectId: string): Promise<SocketConnection | null> {
    if (!this.identity) return null;

    try {
      const serverUrl = new URL(this.config.serverUrl);

      // Update cookies first
      await this.updateCookiesForSocket();

      // V2 protocol: include projectId in URL
      const query = `?projectId=${projectId}&t=${Date.now()}`;

      // 🔒 P2 stability enhancement: add retry mechanism
      const maxRetries = 3;
      const retryDelay = 1000; // 1 second

      const connectWithRetry = async (
        attempt: number
      ): Promise<{ socket: LegacySocketIO; project: ProjectDetails }> => {
        const socket = socketio.connect(serverUrl.origin + query, {
          reconnect: false, // Use manual retry instead of auto-reconnect
          'force new connection': true,
          extraHeaders: {
            Origin: serverUrl.origin,
            Cookie: this.identity!.cookies,
          },
        });

        try {
          // Wait for connection and joinProjectResponse
          const project = await new Promise<ProjectDetails>((resolve, reject) => {
            const timeout = setTimeout(() => {
              socket.disconnect();
              reject(new Error('V2 connection timeout'));
            }, 15000);

            socket.on('connect', () => {
              // Socket.IO V2 connected
            });

            socket.on('joinProjectResponse', (res: JoinProjectResponse) => {
              clearTimeout(timeout);
              const project = res.project as ProjectDetails;
              resolve(project);
            });

            socket.on('connectionRejected', (err: SocketErrorResponse) => {
              clearTimeout(timeout);
              console.error('[OverleafCompiler] V2 connection rejected:', err?.message);
              reject(new Error(err?.message || 'Connection rejected'));
            });

            socket.on('connect_failed', () => {
              clearTimeout(timeout);
              reject(new Error('Socket.IO V2 connection failed'));
            });

            socket.on('error', (err: SocketErrorResponse) => {
              clearTimeout(timeout);
              reject(new Error(err?.message || 'Socket.IO V2 error'));
            });
          });

          return { socket, project };
        } catch (error) {
          socket.disconnect();
          if (attempt < maxRetries) {
            console.warn(
              `[OverleafCompiler] Socket connection failed, retry ${attempt}/${maxRetries}...`
            );
            await new Promise((r) => setTimeout(r, retryDelay * attempt));
            return connectWithRetry(attempt + 1);
          }
          throw error;
        }
      };

      const { socket, project } = await connectWithRetry(1);

      const emitAsync = this.createEmitAsync(socket);

      this.socketConnection = {
        socket,
        projectId,
        connected: true,
        project,
      };

      this.projectDetailsCache.set(projectId, {
        details: project,
        timestamp: Date.now(),
      });

      // Dynamically add emitAsync method to socket
      (socket as LegacySocketIO).emitAsync = emitAsync;
      return this.socketConnection;
    } catch (error) {
      console.error('[OverleafCompiler] V2 connection failed:', error);
      return null;
    }
  }

  private createEmitAsync(
    socket: LegacySocketIO
  ): (event: string, ...args: unknown[]) => Promise<unknown[]> {
    return (event: string, ...args: unknown[]): Promise<unknown[]> => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`${event} timeout`));
        }, 10000);

        socket.emit(event, ...args, (err: SocketErrorResponse | null, ...data: unknown[]) => {
          clearTimeout(timeout);
          if (err) {
            reject(new Error(err.message || 'Socket.IO emit error'));
          } else {
            resolve(data);
          }
        });
      });
    };
  }

  /**
   * Get document content via Socket.IO
   * Reference: Overleaf-Workshop/src/api/socketio.ts#L320
   */
  async getDocViaSocket(projectId: string, docId: string): Promise<string | null> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    try {
      const connection = await this.connectAndJoinProject(projectId);
      if (!connection) {
        return null;
      }

      // Use saved emitAsync function
      const emitAsync = (connection.socket as LegacySocketIO).emitAsync;
      if (!emitAsync) {
        return null;
      }

      // Join document
      const [docLinesAscii, version] = await emitAsync('joinDoc', docId, { encodeRanges: true });

      // Decode content (Overleaf uses ASCII encoding)
      // Reference: Overleaf-Workshop/src/api/socketio.ts#L324
      const docLines = (docLinesAscii as string[]).map((line: string) =>
        Buffer.from(line, 'ascii').toString('utf-8')
      );
      const content = docLines.join('\n');

      // Cache document content
      this.docCache.set(`${projectId}:${docId}`, {
        content,
        version: version as number,
        timestamp: Date.now(),
      });

      return content;
    } catch (error) {
      console.error('[OverleafCompiler] getDocViaSocket error:', error);
      return null;
    }
  }

  disconnectSocket(): void {
    if (this.socketConnection?.socket) {
      this.socketConnection.socket.disconnect();
      this.socketConnection = null;
      // Socket.IO disconnected
    }
  }

  private async getCsrfToken(): Promise<OverleafIdentity> {
    const url = `${this.config.serverUrl}/login`;
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
    });

    const body = await response.text();
    const match = body.match(/<input.*name="_csrf".*value="([^"]*)">/);

    if (!match) {
      throw new Error('Failed to get CSRF Token');
    }

    const csrfToken = match[1];
    const setCookie = response.headers.get('set-cookie');
    const cookies = setCookie?.split(';')[0] || '';

    return { csrfToken, cookies };
  }

  /**
   * Login with email and password
   */
  async login(): Promise<{ success: boolean; message: string; userId?: string }> {
    if (this.config.cookies) {
      // Login with existing cookies
      return this.loginWithCookies(this.config.cookies);
    }

    if (!this.config.email || !this.config.password) {
      return { success: false, message: 'Please provide email/password or Cookies' };
    }

    try {
      const identity = await this.getCsrfToken();

      const response = await fetch(`${this.config.serverUrl}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Cookie: identity.cookies,
          'X-Csrf-Token': identity.csrfToken,
        },
        body: JSON.stringify({
          _csrf: identity.csrfToken,
          email: this.config.email,
          password: this.config.password,
        }),
      });

      if (response.status === 302) {
        const location = response.headers.get('location');
        if (location?.includes('/project')) {
          const newCookies = response.headers.get('set-cookie')?.split(';')[0] || '';
          return this.loginWithCookies(newCookies);
        }
      }

      interface LoginErrorResponse {
        message?: { message?: string; text?: string } | string;
      }
      const result = (await response.json()) as LoginErrorResponse;
      const msg =
        typeof result.message === 'object'
          ? result.message?.message || result.message?.text
          : result.message;
      return {
        success: false,
        message: msg || 'Login failed',
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Login failed',
      };
    }
  }

  /** Stores cookies securely via safeStorage on success */
  private async loginWithCookies(
    cookies: string
  ): Promise<{ success: boolean; message: string; userId?: string }> {
    try {
      const response = await fetch(`${this.config.serverUrl}/project`, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Cookie: cookies,
        },
      });

      const body = await response.text();
      const userIdMatch = body.match(/<meta\s+name="ol-user_id"\s+content="([^"]*)">/);
      const csrfTokenMatch = body.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]*)">/);

      if (userIdMatch && csrfTokenMatch) {
        this.identity = {
          csrfToken: csrfTokenMatch[1],
          cookies: cookies,
        };

        // 🔒 P0: Securely store cookies (using safeStorage encryption)
        setOverleafCookies(cookies);

        return {
          success: true,
          message: 'Login successful',
          userId: userIdMatch[1],
        };
      }

      return { success: false, message: 'Cookies invalid or expired' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to verify Cookies',
      };
    }
  }

  /**
   * Get project list
   */
  async getProjects(): Promise<Array<{ id: string; name: string; lastUpdated: string }>> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    const response = await fetch(`${this.config.serverUrl}/user/projects`, {
      method: 'GET',
      headers: {
        Cookie: this.identity.cookies,
      },
    });

    const data = (await response.json()) as OverleafProjectsResponse;
    return (data.projects || []).map((p: OverleafProjectItem) => ({
      id: p._id || p.id || '',
      name: p.name,
      lastUpdated: p.lastUpdated || '',
    }));
  }

  async compile(
    projectId?: string,
    options?: {
      compiler?: 'pdflatex' | 'xelatex' | 'lualatex' | 'latex';
      draft?: boolean;
      stopOnFirstError?: boolean;
      rootDocId?: string;
    }
  ): Promise<OverleafCompileResult> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    const pid = projectId || this.config.projectId;
    if (!pid) {
      throw new Error('Please specify project ID');
    }

    try {
      // 🔒 P2: Use fetch with timeout and retry
      const response = await this.fetchWithRetry(
        `${this.config.serverUrl}/project/${pid}/compile?auto_compile=true`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: this.identity.cookies,
            'X-Csrf-Token': this.identity.csrfToken,
          },
          body: JSON.stringify({
            _csrf: this.identity.csrfToken,
            check: 'silent',
            draft: options?.draft || false,
            incrementalCompilesEnabled: true,
            rootDoc_id: options?.rootDocId || null,
            stopOnFirstError: options?.stopOnFirstError || false,
          }),
        },
        { timeout: 120000, maxRetries: 2 } // Compilation may take time, set 2 minute timeout
      );

      const result = (await response.json()) as OverleafCompileResponse;

      const outputFiles = result.outputFiles || [];
      const pdfFile = outputFiles.find((f: OverleafOutputFile) => f.path === 'output.pdf');
      const logFile = outputFiles.find((f: OverleafOutputFile) => f.path === 'output.log');

      // Save buildId for SyncTeX
      if (pdfFile?.build) {
        this.lastBuildId = pdfFile.build;
      }

      // Download and parse compilation log
      let logContent: string | undefined;
      let parsedErrors: ParsedLogEntry[] | undefined;
      let parsedWarnings: ParsedLogEntry[] | undefined;
      let parsedInfo: ParsedLogEntry[] | undefined;

      if (logFile) {
        try {
          const logUrl = `${this.config.serverUrl}${logFile.url}`;
          const logResponse = await fetch(logUrl, {
            headers: {
              Cookie: this.identity.cookies,
            },
          });
          if (logResponse.ok) {
            logContent = await logResponse.text();
            // Parse log in worker thread to avoid blocking UI
            const parsed = await parseLatexLogAsync(logContent);
            parsedErrors = parsed.errors;
            parsedWarnings = parsed.warnings;
            parsedInfo = parsed.info;
          }
        } catch (e) {
          console.error('[OverleafCompiler] Failed to fetch/parse log:', e);
        }
      }

      if (result.status === 'success') {
        return {
          success: true,
          status: 'success',
          buildId: pdfFile?.build,
          pdfUrl: pdfFile ? `${this.config.serverUrl}${pdfFile.url}` : undefined,
          logUrl: logFile ? `${this.config.serverUrl}${logFile.url}` : undefined,
          logContent,
          parsedErrors,
          parsedWarnings,
          parsedInfo,
          outputFiles: outputFiles.map((f: OverleafOutputFile) => ({
            path: f.path,
            url: `${this.config.serverUrl}${f.url}`,
            type: f.type,
            build: f.build,
          })),
        };
      } else {
        return {
          success: false,
          status: result.status || 'error',
          errors: [`Compilation failed: ${result.status}`],
          logContent,
          parsedErrors,
          parsedWarnings,
          parsedInfo,
        };
      }
    } catch (error) {
      return {
        success: false,
        status: 'error',
        errors: [error instanceof Error ? error.message : 'Compilation request failed'],
      };
    }
  }

  async stopCompile(projectId?: string): Promise<boolean> {
    if (!this.identity) {
      return false;
    }

    const pid = projectId || this.config.projectId;
    if (!pid) {
      return false;
    }

    try {
      await fetch(`${this.config.serverUrl}/project/${pid}/compile/stop`, {
        method: 'POST',
        headers: {
          Cookie: this.identity.cookies,
          'X-Csrf-Token': this.identity.csrfToken,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  async downloadPdf(url: string): Promise<ArrayBuffer | null> {
    if (!this.identity) {
      return null;
    }

    try {
      const response = await fetch(url, {
        headers: {
          Cookie: this.identity.cookies,
        },
      });

      if (response.ok) {
        return await response.arrayBuffer();
      }
      return null;
    } catch {
      return null;
    }
  }

  async downloadLog(url: string): Promise<string | null> {
    if (!this.identity) {
      return null;
    }

    try {
      const response = await fetch(url, {
        headers: {
          Cookie: this.identity.cookies,
        },
      });

      if (response.ok) {
        return await response.text();
      }
      return null;
    } catch {
      return null;
    }
  }

  async updateProjectSettings(
    projectId: string,
    settings: { compiler?: string; rootDocId?: string; spellCheckLanguage?: string }
  ): Promise<boolean> {
    if (!this.identity) {
      return false;
    }

    try {
      const response = await fetch(`${this.config.serverUrl}/project/${projectId}/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Connection: 'keep-alive',
          Cookie: this.identity.cookies,
        },
        body: JSON.stringify({
          _csrf: this.identity.csrfToken,
          ...settings,
        }),
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const response = await fetch(`${this.config.serverUrl}/login`, {
        method: 'GET',
        redirect: 'manual',
      });

      if (response.ok || response.status === 302) {
        return { success: true, message: `Successfully connected to ${this.config.serverUrl}` };
      }

      return { success: false, message: `Server returned status code: ${response.status}` };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  isLoggedIn(): boolean {
    return this.identity !== null;
  }

  getCookies(): string | null {
    return this.identity?.cookies || null;
  }

  getServerUrl(): string {
    return this.config.serverUrl;
  }

  getLastBuildId(): string | null {
    return this.lastBuildId;
  }

  // ==================== SyncTeX Features ====================

  /** Forward sync: source code position -> PDF position */
  async syncCode(
    projectId: string,
    file: string,
    line: number,
    column: number,
    buildId?: string
  ): Promise<Array<{ page: number; h: number; v: number; width: number; height: number }> | null> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    const bid = buildId || this.lastBuildId;
    if (!bid) {
      throw new Error('No compile result available, please compile project first');
    }

    try {
      const baseUrl = this.config.serverUrl.replace(/\/$/, '');
      // Note: file parameter doesn't need encodeURIComponent encoding
      // Overleaf server expects raw path format (e.g., main.tex or chapters/intro.tex)
      const url = `${baseUrl}/project/${projectId}/sync/code?file=${file}&line=${line}&column=${column}&editorId=${this.editorId}&buildId=${bid}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Cookie: this.identity.cookies,
        },
      });

      if (!response.ok) {
        // Occasional 500 errors may be caused by concurrent requests or server rate limiting, use warn level
        console.warn('[OverleafCompiler] SyncTeX forward sync failed:', response.status);
        return null;
      }

      // Overleaf API returns { pdf: [...] } structure, extract pdf array to return
      const result = (await response.json()) as SyncCodeResult;
      return result.pdf || null;
    } catch (error) {
      console.error('[OverleafCompiler] SyncTeX forward sync error:', error);
      return null;
    }
  }

  /** Inverse sync: PDF position -> source code position */
  async syncPdf(
    projectId: string,
    page: number,
    h: number,
    v: number,
    buildId?: string
  ): Promise<{ file: string; line: number; column: number } | null> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    const bid = buildId || this.lastBuildId;
    if (!bid) {
      throw new Error('No compile result available, please compile project first');
    }

    try {
      const baseUrl = this.config.serverUrl.replace(/\/$/, '');
      const url = `${baseUrl}/project/${projectId}/sync/pdf?page=${page}&h=${h.toFixed(2)}&v=${v.toFixed(2)}&editorId=${this.editorId}&buildId=${bid}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Cookie: this.identity.cookies,
        },
      });

      if (!response.ok) {
        console.warn('[OverleafCompiler] SyncTeX backward sync failed:', response.status);
        return null;
      }

      // Overleaf API returns { code: [...] } structure, extract first result to return
      const result = (await response.json()) as SyncPdfResult;
      if (result.code && result.code.length > 0) {
        return result.code[0];
      }
      return null;
    } catch (error) {
      console.error('[OverleafCompiler] SyncTeX backward sync error:', error);
      return null;
    }
  }

  // ==================== Project File Management ====================

  /** Tries HTML parsing first (has _id), then /entities API fallback */
  async getProjectDetails(projectId: string): Promise<ProjectDetails | null> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    try {
      // First try parsing from project page HTML (contains complete _id info)
      const response = await fetch(`${this.config.serverUrl}/project/${projectId}`, {
        method: 'GET',
        headers: {
          Cookie: this.identity.cookies,
          Accept: 'text/html',
        },
      });

      if (!response.ok) {
        console.error('[OverleafCompiler] Get project page failed:', response.status);
        return null;
      }

      const html = await response.text();
      let projectData: ProjectDetails | null = null;

      // Method 1: Extract rootFolder from meta tag (contains _id)
      // Format: <meta name="ol-rootFolder" data-type="json" content="[...]">
      const rootFolderMatch = html.match(
        /<meta\s+name="ol-rootFolder"\s+data-type="json"\s+content="([^"]*)"/i
      );
      if (rootFolderMatch) {
        try {
          const decoded = this.decodeHtmlEntities(rootFolderMatch[1]);
          const rootFolder = JSON.parse(decoded);

          // Get other project info
          const rootDocIdMatch = html.match(/<meta\s+name="ol-rootDoc_id"\s+content="([^"]*)"/i);

          projectData = {
            _id: projectId,
            name: this.extractMetaContent(html, 'ol-projectName') || 'Remote Project',
            rootDoc_id: rootDocIdMatch ? rootDocIdMatch[1] : '',
            rootFolder: rootFolder,
            compiler: this.extractMetaContent(html, 'ol-compiler') || 'pdflatex',
            spellCheckLanguage: this.extractMetaContent(html, 'ol-spellCheckLanguage') || 'en',
            members: [],
            owner: { _id: '', email: '' },
          };
        } catch (e) {
          console.error('[OverleafCompiler] Failed to parse rootFolder meta:', e);
        }
      }

      // Method 2: Extract complete project data from ol-project meta tag
      if (!projectData) {
        const projectMetaPatterns = [
          /<meta\s+name="ol-project"\s+data-type="json"\s+content="([^"]*)"/i,
          /<meta\s+name="ol-project"\s+content="([^"]*)"/i,
        ];

        for (const pattern of projectMetaPatterns) {
          const match = html.match(pattern);
          if (match) {
            try {
              const decoded = this.decodeHtmlEntities(match[1]);
              projectData = JSON.parse(decoded) as ProjectDetails;
              break;
            } catch (e) {
              console.error('[OverleafCompiler] Failed to parse ol-project meta:', e);
            }
          }
        }
      }

      // Method 3: Extract from window variable
      if (!projectData) {
        const windowPatterns = [
          /window\.project\s*=\s*(\{[\s\S]*?\});\s*(?:window\.|var\s|const\s|let\s|<\/script>)/,
          /window\._ide\s*=\s*\{[^}]*project\s*:\s*(\{[\s\S]*?\})/,
        ];

        for (const pattern of windowPatterns) {
          const match = html.match(pattern);
          if (match) {
            try {
              projectData = JSON.parse(match[1]) as ProjectDetails;
              break;
            } catch (e) {
              console.error('[OverleafCompiler] Failed to parse window var:', e);
            }
          }
        }
      }

      // Method 4: If above all fail, try Socket.IO connection (contains complete _id)
      if (!projectData) {
        try {
          const connection = await this.connectAndJoinProject(projectId);
          if (connection?.project) {
            projectData = connection.project;
          }
        } catch (e) {
          console.error('[OverleafCompiler] Socket.IO connection failed:', e);
        }
      }

      // Method 5: If Socket.IO also fails, try /entities API (note: no _id, rename etc. will fail)
      if (!projectData) {
        const entitiesResponse = await fetch(
          `${this.config.serverUrl}/project/${projectId}/entities`,
          {
            method: 'GET',
            headers: {
              Cookie: this.identity.cookies,
              Accept: 'application/json',
            },
          }
        );

        if (entitiesResponse.ok) {
          interface EntitiesResponse {
            entities?: unknown[];
            project?: { name?: string };
            name?: string;
          }
          const entitiesData = (await entitiesResponse.json()) as EntitiesResponse;

          if (entitiesData.entities && Array.isArray(entitiesData.entities)) {
            const rootFolder = this.entitiesToFolderTree(entitiesData.entities);
            const projectInfo = entitiesData.project as
              | {
                  name?: string;
                  rootDoc_id?: string;
                  compiler?: string;
                  spellCheckLanguage?: string;
                }
              | undefined;
            projectData = {
              _id: projectId,
              name: projectInfo?.name || entitiesData.name || 'Remote Project',
              rootDoc_id: projectInfo?.rootDoc_id || '',
              rootFolder: [rootFolder],
              compiler: projectInfo?.compiler || 'pdflatex',
              spellCheckLanguage: projectInfo?.spellCheckLanguage || 'en',
              members: [],
              owner: { _id: '', email: '' },
            };
          }
        }
      }

      if (projectData) {
        // Cache project details
        this.projectDetailsCache.set(projectId, {
          details: projectData,
          timestamp: Date.now(),
        });
      }

      return projectData;
    } catch (error) {
      console.error('[OverleafCompiler] Get project details error:', error);
      return null;
    }
  }

  private extractMetaContent(html: string, name: string): string | null {
    const pattern = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i');
    const match = html.match(pattern);
    return match ? this.decodeHtmlEntities(match[1]) : null;
  }

  private entitiesToFolderTree(entities: unknown[]): FolderEntity {
    const root: FolderEntity = {
      _id: 'root',
      name: '',
      type: 'folder',
      docs: [],
      fileRefs: [],
      folders: [],
    };

    // Map for fast folder lookup
    const folderMap = new Map<string, FolderEntity>();
    folderMap.set('', root);

    // First create all folders
    interface EntityLike {
      _id?: string;
      id?: string;
      path?: string;
      type?: string;
      name?: string;
    }
    const typedEntities = entities as EntityLike[];
    const sortedEntities = [...typedEntities].sort((a, b) =>
      (a.path || '').localeCompare(b.path || '')
    );

    for (const entity of sortedEntities) {
      // Get entity ID (may be _id or id)
      const entityId = entity._id || entity.id || '';
      const entityPath = entity.path || '';
      const entityType = entity.type || '';

      if (!entityPath) continue;

      const pathParts = entityPath.split('/').filter((p: string) => p);
      if (pathParts.length === 0) continue;

      // Ensure all parent folders exist
      let currentPath = '';
      for (let i = 0; i < pathParts.length - 1; i++) {
        const parentPath = currentPath;
        currentPath = currentPath ? `${currentPath}/${pathParts[i]}` : pathParts[i];

        if (!folderMap.has(currentPath)) {
          const newFolder: FolderEntity = {
            _id: `folder_${currentPath}`,
            name: pathParts[i],
            type: 'folder',
            docs: [],
            fileRefs: [],
            folders: [],
          };
          folderMap.set(currentPath, newFolder);

          const parent = folderMap.get(parentPath);
          if (parent) {
            parent.folders.push(newFolder);
          }
        }
      }

      // Add file or folder
      const fileName = pathParts[pathParts.length - 1];
      const parentPath = pathParts.slice(0, -1).join('/');
      const parent = folderMap.get(parentPath) || root;

      if (entityType === 'folder') {
        if (!folderMap.has(entityPath)) {
          const folder: FolderEntity = {
            _id: entityId || `folder_${entityPath}`,
            name: fileName,
            type: 'folder',
            docs: [],
            fileRefs: [],
            folders: [],
          };
          folderMap.set(entityPath, folder);
          parent.folders.push(folder);
        }
      } else if (entityType === 'doc') {
        parent.docs.push({
          _id: entityId,
          name: fileName,
          type: 'doc',
        });
      } else if (entityType === 'file') {
        parent.fileRefs.push({
          _id: entityId,
          name: fileName,
          type: 'file',
        });
      }
    }

    return root;
  }

  private decodeHtmlEntities(str: string): string {
    return str
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/')
      .replace(/&apos;/g, "'");
  }

  async getDocContent(projectId: string, docId: string): Promise<string | null> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    // If docId is empty, return null
    if (!docId) {
      console.error('[OverleafCompiler] getDocContent: docId is empty');
      return null;
    }

    try {
      const response = await fetch(`${this.config.serverUrl}/project/${projectId}/doc/${docId}`, {
        method: 'GET',
        headers: {
          Cookie: this.identity.cookies,
        },
      });

      if (!response.ok) {
        console.error(`[OverleafCompiler] getDocContent failed: ${response.status}`);
        return null;
      }

      const data = (await response.json()) as { lines: string[] };
      return data.lines.join('\n');
    } catch (error) {
      console.error('[OverleafCompiler] Get doc content error:', error);
      return null;
    }
  }

  /** Gets doc via Socket.IO: project details -> find _id -> joinDoc */
  async getDocByPathWithId(
    projectId: string,
    filePath: string
  ): Promise<{ content: string; docId: string } | null> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    // Normalize path: remove leading /
    const normalizedPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;

    try {
      // Get project details via Socket.IO connection
      const connection = await this.connectAndJoinProject(projectId);

      if (connection?.project) {
        // Find file _id in project file tree
        const docId = this.findDocIdInFolder(connection.project.rootFolder[0], normalizedPath);

        if (docId) {
          // Get document content via Socket.IO
          const content = await this.getDocViaSocket(projectId, docId);
          if (content !== null) {
            return { content, docId };
          }
        }
      }

      // Try to find from cached project details
      const cachedDocId = await this.findDocIdByPath(projectId, normalizedPath);
      if (cachedDocId) {
        const content = await this.getDocViaSocket(projectId, cachedDocId);
        if (content !== null) {
          return { content, docId: cachedDocId };
        }
      }

      return null;
    } catch (error) {
      console.error('[OverleafCompiler] Get doc by path with id error:', error);
      return null;
    }
  }

  /**
   * Get document content by file path (compatible with old interface)
   */
  async getDocByPath(projectId: string, filePath: string): Promise<string | null> {
    const result = await this.getDocByPathWithId(projectId, filePath);
    return result?.content || null;
  }

  async getProjectDetailsViaSocket(projectId: string): Promise<ProjectDetails | null> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    try {
      const connection = await this.connectAndJoinProject(projectId);
      return connection?.project || null;
    } catch (error) {
      console.error('[OverleafCompiler] getProjectDetailsViaSocket error:', error);
      return null;
    }
  }

  /**
   * Find file _id from cached project details
   */
  private async findDocIdByPath(projectId: string, filePath: string): Promise<string | null> {
    const cached = this.projectDetailsCache.get(projectId);
    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
      // 5 minute cache
      return this.findDocIdInFolder(cached.details.rootFolder[0], filePath);
    }
    return null;
  }

  private findDocIdInFolder(
    folder: FolderEntity,
    targetPath: string,
    currentPath = ''
  ): string | null {
    // Check documents in current folder
    for (const doc of folder.docs || []) {
      const docPath = currentPath ? `${currentPath}/${doc.name}` : doc.name;
      if (docPath === targetPath || doc.name === targetPath) {
        return doc._id;
      }
    }

    // Check file references in current folder
    for (const fileRef of folder.fileRefs || []) {
      const filePath = currentPath ? `${currentPath}/${fileRef.name}` : fileRef.name;
      if (filePath === targetPath || fileRef.name === targetPath) {
        return fileRef._id;
      }
    }

    // Recursively check subfolders
    for (const subFolder of folder.folders || []) {
      const subPath = currentPath ? `${currentPath}/${subFolder.name}` : subFolder.name;
      const result = this.findDocIdInFolder(subFolder, targetPath, subPath);
      if (result) {
        return result;
      }
    }

    return null;
  }

  updateDoc(projectId: string, docId: string, newContent: string): Promise<{ success: boolean }> {
    return this.updateDocContent(projectId, docId, newContent);
  }

  /** Merges rapid calls; rolls back optimistic update on failure */
  updateDocDebounced(
    projectId: string,
    docId: string,
    newContent: string
  ): Promise<{ success: boolean }> {
    const cacheKey = `${projectId}:${docId}`;

    // Save old value for rollback
    const cached = this.docCache.get(cacheKey);
    const oldContent = cached?.content;
    const oldVersion = cached?.version;

    // Immediately update local cache (optimistic update)
    if (cached) {
      this.docCache.set(cacheKey, {
        ...cached,
        content: newContent,
        timestamp: Date.now(),
      });
    }

    // Get or create delayer for this document
    let pending = this.pendingUpdates.get(cacheKey);
    if (!pending) {
      const delayer = new SimpleDelayer<{ success: boolean }>(CACHE_CONFIG.UPDATE_DEBOUNCE_MS);
      pending = {
        docId,
        content: newContent,
        delayer,
        promise: Promise.resolve({ success: true }), // Placeholder, will be replaced
      };
      this.pendingUpdates.set(cacheKey, pending);
    }

    // Update pending content
    pending.content = newContent;

    // Trigger debounced update, return Promise
    pending.promise = pending.delayer.trigger(async () => {
      this.pendingUpdates.delete(cacheKey);
      const result = await this.updateDocContent(projectId, docId, newContent);

      // 🔒 P2: Rollback optimistic update on failure
      if (!result.success && oldContent !== undefined) {
        console.warn('[OverleafCompiler] Update failed, rolling back optimistic update');
        this.docCache.set(cacheKey, {
          content: oldContent,
          version: oldVersion ?? 0,
          timestamp: Date.now(),
        });
      }

      return result;
    });

    return pending.promise;
  }

  /** Call before window close or project switch */
  async flushUpdates(projectId?: string): Promise<void> {
    const updates = Array.from(this.pendingUpdates.entries());
    const flushPromises: Promise<{ success: boolean }>[] = [];

    for (const [key, pending] of updates) {
      if (projectId && !key.startsWith(projectId)) {
        continue;
      }

      // Cancel delayer and execute immediately
      pending.delayer.cancel();
      this.pendingUpdates.delete(key);

      const [pid, docId] = key.split(':');
      flushPromises.push(this.updateDocContent(pid, docId, pending.content));
    }

    // Wait for all updates to complete
    await Promise.all(flushPromises);
  }

  getDocCached(projectId: string, docId: string): { content: string; version: number } | null {
    const cacheKey = `${projectId}:${docId}`;
    const cached = this.docCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_CONFIG.DOC_CACHE_TTL) {
      return { content: cached.content, version: cached.version };
    }

    return null;
  }

  clearCache(projectId?: string, docId?: string): void {
    if (projectId && docId) {
      this.docCache.delete(`${projectId}:${docId}`);
    } else if (projectId) {
      for (const key of this.docCache.keys()) {
        if (key.startsWith(projectId)) {
          this.docCache.delete(key);
        }
      }
    } else {
      this.docCache.clear();
    }
  }

  /** Uses Socket.IO OT protocol */
  async updateDocContent(
    projectId: string,
    docId: string,
    newContent: string
  ): Promise<{ success: boolean }> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    try {
      const connection = await this.connectAndJoinProject(projectId);
      if (!connection) {
        return { success: false };
      }

      const emitAsync = (connection.socket as LegacySocketIO).emitAsync;
      if (!emitAsync) {
        return { success: false };
      }

      const cached = this.docCache.get(`${projectId}:${docId}`);
      let currentVersion = cached?.version || 0;
      let currentContent = cached?.content || '';

      if (!cached) {
        const [docLinesAscii, version] = await emitAsync('joinDoc', docId, { encodeRanges: true });
        currentVersion = version as number;
        currentContent = (docLinesAscii as string[])
          .map((line: string) => Buffer.from(line, 'ascii').toString('utf-8'))
          .join('\n');
      }

      const ops = this.computeOtOps(currentContent, newContent);

      if (ops.length === 0) {
        return { success: true };
      }

      const update = {
        doc: docId,
        op: ops,
        v: currentVersion,
        meta: {
          source: connection.socket?.socket?.id || 'scipen-studio',
          ts: Date.now(),
        },
      };

      await emitAsync('applyOtUpdate', docId, update);

      this.docCache.set(`${projectId}:${docId}`, {
        content: newContent,
        version: currentVersion + 1,
        timestamp: Date.now(),
      });

      return { success: true };
    } catch {
      return { success: false };
    }
  }

  private computeOtOps(
    oldContent: string,
    newContent: string
  ): Array<{ p: number; i?: string; d?: string }> {
    // If content is the same, no operation needed
    if (oldContent === newContent) {
      return [];
    }

    // Find common prefix
    let prefixLen = 0;
    while (
      prefixLen < oldContent.length &&
      prefixLen < newContent.length &&
      oldContent[prefixLen] === newContent[prefixLen]
    ) {
      prefixLen++;
    }

    // Find common suffix
    let oldSuffixStart = oldContent.length;
    let newSuffixStart = newContent.length;
    while (
      oldSuffixStart > prefixLen &&
      newSuffixStart > prefixLen &&
      oldContent[oldSuffixStart - 1] === newContent[newSuffixStart - 1]
    ) {
      oldSuffixStart--;
      newSuffixStart--;
    }

    const ops: Array<{ p: number; i?: string; d?: string }> = [];

    // Delete old content (if any)
    const deleteStr = oldContent.substring(prefixLen, oldSuffixStart);
    if (deleteStr.length > 0) {
      ops.push({ p: prefixLen, d: deleteStr });
    }

    // Insert new content (if any)
    const insertStr = newContent.substring(prefixLen, newSuffixStart);
    if (insertStr.length > 0) {
      ops.push({ p: prefixLen, i: insertStr });
    }

    return ops;
  }

  async downloadFile(projectId: string, fileId: string): Promise<ArrayBuffer | null> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    try {
      const response = await fetch(`${this.config.serverUrl}/project/${projectId}/file/${fileId}`, {
        method: 'GET',
        headers: {
          Cookie: this.identity.cookies,
        },
      });

      if (!response.ok) {
        return null;
      }

      return await response.arrayBuffer();
    } catch (error) {
      console.error('[OverleafCompiler] Download file error:', error);
      return null;
    }
  }

  async uploadFile(
    projectId: string,
    folderId: string,
    fileName: string,
    fileContent: Buffer | ArrayBuffer
  ): Promise<{ success: boolean; fileId?: string; error?: string }> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    try {
      // Create FormData (consistent with Overleaf-Workshop)
      const formData = new FormData();
      const blob = new Blob([
        fileContent instanceof ArrayBuffer ? fileContent : Uint8Array.from(fileContent),
      ]);
      const mimeType = lookupMimeType(fileName) || 'application/octet-stream';
      formData.append('targetFolderId', folderId);
      formData.append('name', fileName);
      formData.append('type', mimeType);
      formData.append('qqfile', blob, fileName);

      const response = await fetch(
        `${this.config.serverUrl}/project/${projectId}/upload?folder_id=${folderId}`,
        {
          method: 'POST',
          headers: {
            Cookie: this.identity.cookies,
            'X-Csrf-Token': this.identity.csrfToken,
          },
          body: formData,
        }
      );

      const responseText = await response.text();
      if (!response.ok) {
        return { success: false, error: responseText };
      }

      const result = (responseText ? JSON.parse(responseText) : {}) as {
        success: boolean;
        entity_id?: string;
        error?: string;
      };
      return {
        success: result.success,
        fileId: result.entity_id,
        error: result.error,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Upload failed',
      };
    }
  }

  async createDoc(
    projectId: string,
    parentFolderId: string,
    name: string
  ): Promise<{ success: boolean; docId?: string; error?: string }> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    try {
      const baseUrl = this.config.serverUrl.replace(/\/$/, '');
      const url = `${baseUrl}/project/${projectId}/doc`;

      const response = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Connection: 'keep-alive',
          Cookie: this.identity.cookies,
          'X-Csrf-Token': this.identity.csrfToken,
        },
        body: JSON.stringify({
          _csrf: this.identity.csrfToken,
          name,
          parent_folder_id: parentFolderId,
        }),
      });

      if (response.status !== 200 && response.status !== 204) {
        const errorText = await response.text();
        return {
          success: false,
          error: `Failed to create document (${response.status}): ${errorText.substring(0, 100)}`,
        };
      }

      const result = (await response.json()) as { _id: string };
      this.invalidateProjectCache(projectId);

      return { success: true, docId: result._id };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create document',
      };
    }
  }

  async createFolder(
    projectId: string,
    parentFolderId: string,
    name: string
  ): Promise<{ success: boolean; folderId?: string; error?: string }> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    try {
      const baseUrl = this.config.serverUrl.replace(/\/$/, '');
      const url = `${baseUrl}/project/${projectId}/folder`;

      const response = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Connection: 'keep-alive',
          Cookie: this.identity.cookies,
          'X-Csrf-Token': this.identity.csrfToken,
        },
        body: JSON.stringify({
          _csrf: this.identity.csrfToken,
          name,
          parent_folder_id: parentFolderId,
        }),
      });

      if (response.status !== 200 && response.status !== 204) {
        const errorText = await response.text();
        return {
          success: false,
          error: `Failed to create folder (${response.status}): ${errorText.substring(0, 100)}`,
        };
      }

      const result = (await response.json()) as { _id: string };
      this.invalidateProjectCache(projectId);

      return { success: true, folderId: result._id };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create folder',
      };
    }
  }

  async deleteEntity(
    projectId: string,
    entityType: 'doc' | 'file' | 'folder',
    entityId: string
  ): Promise<boolean> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    try {
      const baseUrl = this.config.serverUrl.replace(/\/$/, '');
      const url = `${baseUrl}/project/${projectId}/${entityType}/${entityId}`;

      const response = await fetch(url, {
        method: 'DELETE',
        redirect: 'manual',
        headers: {
          Connection: 'keep-alive',
          Cookie: this.identity.cookies,
          'X-Csrf-Token': this.identity.csrfToken,
        },
      });

      if (response.status !== 200 && response.status !== 204) {
        return false;
      }

      this.invalidateProjectCache(projectId);
      return true;
    } catch {
      return false;
    }
  }

  async renameEntity(
    projectId: string,
    entityType: 'doc' | 'file' | 'folder',
    entityId: string,
    newName: string
  ): Promise<boolean> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    try {
      const baseUrl = this.config.serverUrl.replace(/\/$/, '');
      const url = `${baseUrl}/project/${projectId}/${entityType}/${entityId}/rename`;

      const response = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Connection: 'keep-alive',
          Cookie: this.identity.cookies,
          'X-Csrf-Token': this.identity.csrfToken,
        },
        body: JSON.stringify({
          _csrf: this.identity.csrfToken,
          name: newName,
        }),
      });

      if (response.status !== 200 && response.status !== 204) {
        return false;
      }

      this.invalidateProjectCache(projectId);
      return true;
    } catch {
      return false;
    }
  }

  async moveEntity(
    projectId: string,
    entityType: 'doc' | 'file' | 'folder',
    entityId: string,
    targetFolderId: string
  ): Promise<boolean> {
    if (!this.identity) {
      throw new Error('Please login first');
    }

    try {
      const baseUrl = this.config.serverUrl.replace(/\/$/, '');
      const url = `${baseUrl}/project/${projectId}/${entityType}/${entityId}/move`;

      const response = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Connection: 'keep-alive',
          Cookie: this.identity.cookies,
          'X-Csrf-Token': this.identity.csrfToken,
        },
        body: JSON.stringify({
          _csrf: this.identity.csrfToken,
          folder_id: targetFolderId,
        }),
      });

      if (response.status !== 200 && response.status !== 204) {
        return false;
      }

      this.invalidateProjectCache(projectId);
      return true;
    } catch {
      return false;
    }
  }

  // ====== Socket Event Subscription (for Local Replica bidirectional sync) ======

  /** Returns unsubscribe function */
  subscribeToProjectEvents(
    projectId: string,
    handlers: import('./interfaces/IOverleafService').OverleafSocketEventHandlers
  ): (() => void) | null {
    if (!this.socketConnection?.socket || this.socketConnection.projectId !== projectId) {
      console.warn('[OverleafCompiler] Cannot subscribe to events: Socket connection unavailable');
      return null;
    }

    const socket = this.socketConnection.socket;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];

    // Document content change (OT update)
    if (handlers.onDocChanged) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (update: any) => {
        handlers.onDocChanged!(update.doc, { op: update.op, v: update.v });
      };
      socket.on('otUpdateApplied', handler);
      listeners.push({ event: 'otUpdateApplied', handler });
    }

    // New document
    if (handlers.onDocCreated) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (parentFolderId: any, doc: any) => {
        handlers.onDocCreated!(parentFolderId, doc);
      };
      socket.on('reciveNewDoc', handler);
      listeners.push({ event: 'reciveNewDoc', handler });
    }

    // New file
    if (handlers.onFileCreated) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (parentFolderId: any, file: any) => {
        handlers.onFileCreated!(parentFolderId, file);
      };
      socket.on('reciveNewFile', handler);
      listeners.push({ event: 'reciveNewFile', handler });
    }

    // New folder
    if (handlers.onFolderCreated) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (parentFolderId: any, folder: any) => {
        handlers.onFolderCreated!(parentFolderId, folder);
      };
      socket.on('reciveNewFolder', handler);
      listeners.push({ event: 'reciveNewFolder', handler });
    }

    // Entity renamed
    if (handlers.onEntityRenamed) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (entityId: any, newName: any) => {
        handlers.onEntityRenamed!(entityId, newName);
      };
      socket.on('reciveEntityRename', handler);
      listeners.push({ event: 'reciveEntityRename', handler });
    }

    // Entity moved
    if (handlers.onEntityMoved) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (entityId: any, newFolderId: any) => {
        handlers.onEntityMoved!(entityId, newFolderId);
      };
      socket.on('reciveEntityMove', handler);
      listeners.push({ event: 'reciveEntityMove', handler });
    }

    // Entity deleted
    if (handlers.onEntityRemoved) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (entityId: any) => {
        handlers.onEntityRemoved!(entityId);
      };
      socket.on('removeEntity', handler);
      listeners.push({ event: 'removeEntity', handler });
    }

    console.log(`[OverleafCompiler] Subscribed to ${listeners.length} Socket events`);

    // Return unsubscribe function
    return () => {
      for (const { event, handler } of listeners) {
        // Compatible with legacy Socket.IO event removal
        if (socket.off) {
          socket.off(event, handler);
        } else if (socket.removeListener) {
          socket.removeListener(event, handler);
        }
      }
      console.log('[OverleafCompiler] Socket event subscription cancelled');
    };
  }

  isProjectConnected(projectId: string): boolean {
    return (
      this.socketConnection?.connected === true && this.socketConnection?.projectId === projectId
    );
  }
}
