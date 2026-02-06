/**
 * Playwright E2E 测试配置
 *
 * 用于 Electron 应用的端到端测试
 * @see https://playwright.dev/docs/test-configuration
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  
  /* 最大测试超时时间 */
  timeout: 60 * 1000,
  
  /* 期望超时时间 */
  expect: {
    timeout: 10000,
  },
  
  /* 在 CI 中禁止 .only */
  forbidOnly: !!process.env.CI,
  
  /* 失败重试次数 */
  retries: process.env.CI ? 2 : 0,
  
  /* CI 中并行运行数量 */
  workers: process.env.CI ? 1 : undefined,
  
  /* 报告器 */
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list'],
  ],
  
  /* 共享设置 */
  use: {
    /* 动作超时 */
    actionTimeout: 10000,
    
    /* 收集失败测试的 trace */
    trace: 'on-first-retry',
    
    /* 截图 */
    screenshot: 'only-on-failure',
    
    /* 视频 */
    video: 'retain-on-failure',
  },
  
  /* 项目配置 - Electron 测试不使用浏览器项目 */
  projects: [
    {
      name: 'electron',
      testMatch: /.*\.e2e\.ts/,
    },
  ],
  
  /* 输出目录 */
  outputDir: 'test-results/',
});

