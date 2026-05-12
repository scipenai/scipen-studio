/**
 * @file ReconnectManager - 通用指数退避重连管理器
 * @description 封装 scheduleReconnect / reset / cancel 逻辑，供 StudioIMService 和 StudioOTService 复用
 */

export interface ReconnectManagerOptions {
  /** 最大重连次数 */
  maxAttempts: number;
  /** 基础延迟（ms） */
  baseDelayMs: number;
  /** 最大延迟上限（ms） */
  maxDelayMs: number;
  /** 日志标签，用于 logger 输出 */
  label: string;
  /** 实际执行重连的回调 */
  onReconnect: () => Promise<void>;
  /** 日志函数 */
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
}

export class ReconnectManager {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private cancelled = false;

  constructor(private readonly options: ReconnectManagerOptions) {}

  /** 调度一次重连（指数退避 + jitter） */
  schedule(): void {
    if (this.cancelled || this.timer) return;
    if (this.attempts >= this.options.maxAttempts) {
      this.options.logger.warn(
        `[${this.options.label}] Maximum reconnect attempts reached (${this.options.maxAttempts}), stopping reconnects`
      );
      return;
    }

    const baseDelay = Math.min(
      this.options.baseDelayMs * Math.pow(2, this.attempts),
      this.options.maxDelayMs
    );
    const jitter = baseDelay * Math.random() * 0.5;
    const delay = baseDelay + jitter;
    this.attempts++;

    this.options.logger.info(
      `[${this.options.label}] Reconnecting in ${Math.round(delay)}ms (attempt ${this.attempts})`
    );

    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.cancelled) return;
      void this.options.onReconnect();
    }, delay);
  }

  /** 重连成功后重置计数器 */
  reset(): void {
    this.attempts = 0;
  }

  /** 取消待定的重连定时器 */
  cancel(): void {
    this.cancelled = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 重新启用（cancel 后想重新使用时调用） */
  enable(): void {
    this.cancelled = false;
  }

  /** 当前是否有待定的重连定时器 */
  get pending(): boolean {
    return this.timer !== null;
  }

  /** 当前重连尝试次数 */
  get currentAttempts(): number {
    return this.attempts;
  }

  /** 是否已达到最大重连次数 */
  get exhausted(): boolean {
    return this.attempts >= this.options.maxAttempts;
  }
}
