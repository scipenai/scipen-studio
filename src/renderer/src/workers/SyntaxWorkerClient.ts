/**
 * @file SyntaxWorkerClient.ts - Syntax Check Worker Client
 * @description Provides interface to communicate with syntax.worker.ts using request/response pattern
 */

// Simplified logging
const isDev = import.meta.env?.DEV ?? true;
const log = {
  debug: (...args: unknown[]) => isDev && console.debug('[SyntaxWorkerClient]', ...args),
  warn: (...args: unknown[]) => console.warn('[SyntaxWorkerClient]', ...args),
  error: (...args: unknown[]) => console.error('[SyntaxWorkerClient]', ...args),
};

export interface SyntaxMarker {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export function mapSeverityToMonaco(severity: SyntaxMarker['severity'], monaco: any): number {
  switch (severity) {
    case 'error':
      return monaco.MarkerSeverity.Error;
    case 'warning':
      return monaco.MarkerSeverity.Warning;
    case 'info':
      return monaco.MarkerSeverity.Info;
    case 'hint':
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Info;
  }
}

export class SyntaxWorkerClient {
  private worker: Worker | null = null;
  private pendingRequests: Map<
    string,
    {
      resolve: (markers: SyntaxMarker[]) => void;
      reject: (error: Error) => void;
    }
  > = new Map();
  private requestIdCounter = 0;
  private isInitialized = false;

  initialize(): void {
    if (this.isInitialized) {
      return;
    }

    try {
      // Use Vite's Worker import syntax
      this.worker = new Worker(new URL('./syntax.worker.ts', import.meta.url), { type: 'module' });

      this.worker.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.worker.onerror = (error) => {
        log.error('Worker 错误:', error);
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error('Worker 错误'));
          this.pendingRequests.delete(id);
        }
      };

      this.isInitialized = true;
      log.debug('✓ Worker 初始化完成');
    } catch (error) {
      log.error('Worker 初始化失败:', error);
    }
  }

  private handleMessage(response: { type: string; id: string; markers: SyntaxMarker[] }): void {
    if (response.type === 'diagnosticsResult') {
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        pending.resolve(response.markers);
      }
    }
  }

  private generateRequestId(): string {
    return `syntax_${Date.now()}_${this.requestIdCounter++}`;
  }

  /**
   * Run syntax diagnostics
   * @param content File content
   * @param timeout Timeout in milliseconds
   * @returns Array of syntax markers
   */
  async runDiagnostics(content: string, timeout = 5000): Promise<SyntaxMarker[]> {
    if (!this.isInitialized || !this.worker) {
      this.initialize();
      if (!this.worker) {
        log.warn('Worker 不可用，返回空结果');
        return [];
      }
    }

    const id = this.generateRequestId();

    return new Promise((resolve, reject) => {
      // Set timeout
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          log.warn('请求超时');
          resolve([]); // Return empty result on timeout instead of rejecting
        }
      }, timeout);

      this.pendingRequests.set(id, {
        resolve: (markers) => {
          clearTimeout(timeoutId);
          resolve(markers);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });

      this.worker!.postMessage({
        type: 'runDiagnostics',
        id,
        content,
      });
    });
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      this.pendingRequests.clear();
      log.debug('✓ Worker 已终止');
    }
  }

  getIsInitialized(): boolean {
    return this.isInitialized;
  }
}

let clientInstance: SyntaxWorkerClient | null = null;

export function getSyntaxWorkerClient(): SyntaxWorkerClient {
  if (!clientInstance) {
    clientInstance = new SyntaxWorkerClient();
    clientInstance.initialize();
  }
  return clientInstance;
}
