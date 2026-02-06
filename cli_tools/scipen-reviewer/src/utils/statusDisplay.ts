/**
 * @file statusDisplay.ts - Status display utility
 * @description Provides unified status display, color management, and timestamp functionality
 * @depends None
 */
export class StatusDisplay {
  // Color definitions
  static readonly Colors = {
    RED: '\x1b[0;31m',
    GREEN: '\x1b[0;32m',
    YELLOW: '\x1b[1;33m',
    BLUE: '\x1b[0;34m',
    CYAN: '\x1b[0;36m',
    NC: '\x1b[0m' // No Color
  } as const;

  /**
   * Get current timestamp (Chinese format)
   */
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

  /**
   * Print status information with timestamp
   */
  static printStatus(status: string, task: string): void {
    const timestamp = this.getTimestamp();
    console.log(`${this.Colors.BLUE}[${timestamp}]${this.Colors.NC} ${status}: ${task}`);
  }

  /**
   * Print success status
   */
  static printSuccess(task: string): void {
    this.printStatus(`${this.Colors.GREEN}✔ Complete${this.Colors.NC}`, task);
  }

  /**
   * Print error status
   */
  static printError(task: string, error?: string): void {
    const errorMsg = error ? ` (${error})` : '';
    this.printStatus(`${this.Colors.RED}✖ Failed${this.Colors.NC}`, `${task}${errorMsg}`);
  }

  /**
   * Print start execution status
   */
  static printStart(task: string): void {
    this.printStatus(`${this.Colors.YELLOW}▶ Start${this.Colors.NC}`, task);
  }

  /**
   * Print launch status
   */
  static printLaunch(task: string): void {
    this.printStatus(`${this.Colors.CYAN}◉ Launch${this.Colors.NC}`, `${task}`);
  }

  /**
   * Print in-progress status
   */
  static printProgress(task: string): void {
    this.printStatus(`${this.Colors.YELLOW}⋯ In Progress${this.Colors.NC}`, task);
  }

  /**
   * Print warning status
   */
  static printWarning(task: string): void {
    this.printStatus(`${this.Colors.YELLOW}⚠ Warning${this.Colors.NC}`, task);
  }

  /**
   * Print header separator line
   */
  static printHeader(title: string): void {
    console.log();
    console.log(`${this.Colors.BLUE}${'═'.repeat(50)}${this.Colors.NC}`);
    console.log(`${this.Colors.BLUE}    ${title}${this.Colors.NC}`);
    console.log(`${this.Colors.BLUE}${'═'.repeat(50)}${this.Colors.NC}`);
    console.log();
  }

  /**
   * Print phase title
   */
  static printPhase(phase: string): void {
    console.log();
    console.log(`${this.Colors.CYAN}${phase}${this.Colors.NC}`);
    console.log(`${this.Colors.CYAN}${'─'.repeat(40)}${this.Colors.NC}`);
  }

  /**
   * Print file information
   */
  static printFileInfo(label: string, filename: string): void {
    console.log(`${this.Colors.BLUE}${label}:${this.Colors.NC} ${filename}`);
  }

  /**
   * Print task summary
   */
  static printTaskSummary(results: Array<{ name: string; success: boolean; error?: string }>): void {
    console.log();
    this.printHeader('Task Execution Summary');

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    console.log(`${this.Colors.GREEN}Success: ${successful.length}${this.Colors.NC}`);
    console.log(`${this.Colors.RED}Failed: ${failed.length}${this.Colors.NC}`);
    console.log();

    for (const result of results) {
      if (result.success) {
        this.printSuccess(result.name);
      } else {
        this.printError(result.name, result.error);
      }
    }
  }
}
