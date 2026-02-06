/**
 * @file statusDisplay.ts - Status display utility
 * @description Provides unified status display, color management, and timestamp functionality
 * @depends None
 */
export class StatusDisplay {
  static readonly Colors = {
    RED: '\x1b[0;31m',
    GREEN: '\x1b[0;32m',
    YELLOW: '\x1b[1;33m',
    BLUE: '\x1b[0;34m',
    CYAN: '\x1b[0;36m',
    NC: '\x1b[0m'
  } as const;

  static getTimestamp(): string {
    return new Date().toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  static printStatus(status: string, task: string): void {
    const timestamp = this.getTimestamp();
    console.log(`${this.Colors.BLUE}[${timestamp}]${this.Colors.NC} ${status}: ${task}`);
  }

  static printSuccess(task: string): void {
    this.printStatus(`${this.Colors.GREEN}✔ 完成${this.Colors.NC}`, task);
  }

  static printError(task: string, error?: string): void {
    const errorMsg = error ? ` (${error})` : '';
    this.printStatus(`${this.Colors.RED}✖ 失败${this.Colors.NC}`, `${task}${errorMsg}`);
  }

  static printStart(task: string): void {
    this.printStatus(`${this.Colors.YELLOW}▶ 开始${this.Colors.NC}`, task);
  }

  static printLaunch(task: string): void {
    this.printStatus(`${this.Colors.CYAN}◉ 启动${this.Colors.NC}`, `${task}`);
  }

  static printProgress(task: string): void {
    this.printStatus(`${this.Colors.YELLOW}⋯ 进行中${this.Colors.NC}`, task);
  }

  static printWarning(task: string): void {
    this.printStatus(`${this.Colors.YELLOW}⚠ 警告${this.Colors.NC}`, task);
  }

  static printHeader(title: string): void {
    console.log();
    console.log(`${this.Colors.BLUE}${'═'.repeat(50)}${this.Colors.NC}`);
    console.log(`${this.Colors.BLUE}    ${title}${this.Colors.NC}`);
    console.log(`${this.Colors.BLUE}${'═'.repeat(50)}${this.Colors.NC}`);
    console.log();
  }

  static printPhase(phase: string): void {
    console.log();
    console.log(`${this.Colors.CYAN}${phase}${this.Colors.NC}`);
    console.log(`${this.Colors.CYAN}${'─'.repeat(40)}${this.Colors.NC}`);
  }

  static printFileInfo(label: string, filename: string): void {
    console.log(`${this.Colors.BLUE}${label}:${this.Colors.NC} ${filename}`);
  }

  static printTaskSummary(results: Array<{ name: string; success: boolean; error?: string; duration?: number }>): void {
    console.log();
    this.printHeader('Task Execution Summary');

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    console.log(`${this.Colors.GREEN}Success: ${successful.length}${this.Colors.NC}`);
    console.log(`${this.Colors.RED}Failed: ${failed.length}${this.Colors.NC}`);
    console.log();

    for (const result of results) {
      const durationStr = result.duration ? ` (${(result.duration / 1000).toFixed(1)}s)` : '';
      if (result.success) {
        this.printSuccess(`${result.name}${durationStr}`);
      } else {
        this.printError(result.name, result.error);
      }
    }
  }
}

