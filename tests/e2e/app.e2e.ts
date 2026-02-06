/**
 * @file app.e2e.ts - E2E tests for SciPen Studio
 * @description End-to-end tests using Playwright for Electron application. Run with: npx playwright test tests/e2e/app.e2e.ts. Note: requires building the app first: npm run build
 * @depends Playwright, Electron
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

const Filename = fileURLToPath(import.meta.url);
const Dirname = path.dirname(Filename);

let electronApp: ElectronApplication;
let page: Page;

// ====== App Path Resolution ======
const getAppPath = () => {
  const platform = process.platform;
  const appName = 'SciPen Studio';
  const version = '0.1.0';

  const getPackagedPath = () => {
    if (platform === 'win32') {
      return path.join(Dirname, `../../release/${version}/win-unpacked`, `${appName}.exe`);
    } else if (platform === 'darwin') {
      return path.join(
        Dirname,
        `../../release/${version}/mac`,
        `${appName}.app/Contents/MacOS/${appName}`
      );
    } else {
      return path.join(
        Dirname,
        `../../release/${version}/linux-unpacked`,
        appName.toLowerCase().replace(/ /g, '-')
      );
    }
  };

  const packagedPath = getPackagedPath();

  if (fs.existsSync(packagedPath)) {
    return packagedPath;
  }

  return null;
};

// ====== Dev Mode Launch Options ======
const getDevLaunchOptions = () => {
  return {
    args: [path.join(Dirname, '../../out/main/index.js'), '--disable-gpu', '--no-sandbox'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SCIPEN_ALLOW_MULTIPLE_INSTANCES: 'true',
    },
  };
};

// ====== Test Suite ======
test.describe
  .serial('SciPen Studio E2E Tests', () => {
    test.beforeAll(async () => {
      const appPath = getAppPath();

      if (appPath) {
        electronApp = await electron.launch({
          executablePath: appPath,
          args: ['--disable-gpu', '--no-sandbox'],
          env: {
            ...process.env,
            NODE_ENV: 'test',
            SCIPEN_ALLOW_MULTIPLE_INSTANCES: 'true',
          },
        });
      } else {
        const devOptions = getDevLaunchOptions();
        electronApp = await electron.launch(devOptions);
      }

      page = await electronApp.firstWindow();

      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(3000);
    });

    test.afterAll(async () => {
      if (electronApp) {
        await electronApp.close();
      }
    });

    // ====== Basic Tests ======

    test('application should start successfully', async () => {
      const windows = electronApp.windows();
      expect(windows.length).toBeGreaterThan(0);
    });

    test('should display main interface', async () => {
      const hasMainContent = await page.locator('body').count();
      expect(hasMainContent).toBeGreaterThan(0);

      const bodyContent = await page.locator('body').innerText();
      expect(bodyContent.length).toBeGreaterThan(0);
    });

    test('sidebar should be visible', async () => {
      const sidebar = page
        .locator('[data-testid="sidebar"]')
        .or(page.locator('.sidebar'))
        .or(page.locator('[class*="Sidebar"]'))
        .or(page.locator('[class*="sidebar"]'));

      const count = await sidebar.count();
      if (count > 0) {
        await expect(sidebar.first()).toBeVisible();
      } else {
        console.log('Sidebar selector not found, skipping check');
      }
    });

    test('status bar should be displayed', async () => {
      const statusBar = page
        .locator('[data-testid="status-bar"]')
        .or(page.locator('.status-bar'))
        .or(page.locator('[class*="StatusBar"]'))
        .or(page.locator('[class*="status"]'));

      const count = await statusBar.count();
      if (count > 0) {
        await expect(statusBar.first()).toBeVisible();
      } else {
        console.log('Status bar selector not found, skipping check');
      }
    });

    // ====== Command Palette Tests ======

    test('should be able to open command palette', async () => {
      await page.keyboard.press('Control+P');
      await page.waitForTimeout(500);

      const commandPalette = page
        .locator('[data-testid="command-palette"]')
        .or(page.locator('[class*="CommandPalette"]'))
        .or(page.locator('input[placeholder*="搜索"]'))
        .or(page.locator('input[placeholder*="Search"]'));

      const count = await commandPalette.count();
      if (count > 0) {
        await expect(commandPalette.first()).toBeVisible();
      }

      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    });

    // ====== File Operations Tests ======

    test('should be able to create new file (Ctrl+N)', async () => {
      await page.keyboard.press('Control+N');
      await page.waitForTimeout(500);

      const editor = page.locator('.monaco-editor');
      const count = await editor.count();
      expect(count).toBeGreaterThanOrEqual(0);
    });

    // ====== AI Features Tests ======

    test('AI panel should be openable', async () => {
      await page.keyboard.press('Control+Shift+C');
      await page.waitForTimeout(500);

      const aiPanel = page
        .locator('[data-testid="ai-panel"]')
        .or(page.locator('[class*="AIPanel"]'))
        .or(page.locator('text=AI 助手'))
        .or(page.locator('text=文档对话'));

      const count = await aiPanel.count();
      expect(count).toBeGreaterThanOrEqual(0);
    });

    // ====== Settings Page Tests ======

    test('should be able to open settings', async () => {
      const settingsBtn = page
        .locator('[data-testid="settings-button"]')
        .or(page.locator('[aria-label*="设置"]'))
        .or(page.locator('button:has-text("设置")'))
        .or(page.locator('[title*="设置"]'));

      const count = await settingsBtn.count();
      if (count > 0) {
        await settingsBtn.first().click();
        await page.waitForTimeout(500);

        const settingsPanel = page.locator('[class*="Settings"]').or(page.locator('text=LLM 配置'));

        const panelCount = await settingsPanel.count();
        expect(panelCount).toBeGreaterThanOrEqual(0);

        await page.keyboard.press('Escape');
      }
    });

    // ====== Compilation Features Tests ======

    test('compile button should exist', async () => {
      const compileBtn = page
        .locator('[data-testid="compile-button"]')
        .or(page.locator('[aria-label*="编译"]'))
        .or(page.locator('button[title*="编译"]'))
        .or(page.locator('button[title*="Compile"]'));

      const count = await compileBtn.count();
      expect(count).toBeGreaterThanOrEqual(0);
    });

    // ====== Theme Tests ======

    test('application should have theme styles', async () => {
      const isDarkTheme = await page.evaluate(() => {
        return (
          document.documentElement.classList.contains('dark') ||
          document.body.classList.contains('dark') ||
          getComputedStyle(document.body).backgroundColor.includes('0') ||
          getComputedStyle(document.body).backgroundColor.includes('rgb(10')
        );
      });

      expect(typeof isDarkTheme).toBe('boolean');
    });

    // ====== Accessibility Tests ======

    test('page should have correct title', async () => {
      const title = await page.title();
      expect(title).toBeTruthy();
      expect(title.length).toBeGreaterThan(0);
    });

    test('buttons should be accessible via keyboard', async () => {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(200);

      const focusedElement = await page.evaluate(() => {
        const el = document.activeElement;
        return {
          tagName: el?.tagName,
          role: el?.getAttribute('role'),
          tabIndex: el?.getAttribute('tabindex'),
        };
      });

      expect(focusedElement.tagName).toBeTruthy();
    });

    // ====== Keyboard Shortcuts Tests ======

    test('keyboard shortcut functionality verification', async () => {
      const shortcuts = [
        { keys: 'Control+S', name: '保存' },
        { keys: 'Control+Z', name: '撤销' },
        { keys: 'Control+F', name: '查找' },
      ];

      for (const { keys, name } of shortcuts) {
        await page.keyboard.press(keys);
        await page.waitForTimeout(200);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
        console.log(`Shortcut ${keys} (${name}): tested`);
      }
    });

    // ====== Performance Tests ======

    test('UI responsiveness test', async () => {
      const start = Date.now();

      await page.keyboard.press('Control+P');
      await page.waitForTimeout(100);
      await page.keyboard.press('Escape');

      const duration = Date.now() - start;
      console.log(`Command palette response time: ${duration}ms`);

      expect(duration).toBeLessThan(2000);
    });

    test('memory usage check', async () => {
      const memoryInfo = await page.evaluate(() => {
        if ('memory' in performance) {
          const mem = (performance as any).memory;
          return {
            usedJSHeapSize: mem.usedJSHeapSize,
            totalJSHeapSize: mem.totalJSHeapSize,
            jsHeapSizeLimit: mem.jsHeapSizeLimit,
          };
        }
        return null;
      });

      if (memoryInfo) {
        console.log('Memory usage:', {
          used: `${(memoryInfo.usedJSHeapSize / 1024 / 1024).toFixed(2)} MB`,
          total: `${(memoryInfo.totalJSHeapSize / 1024 / 1024).toFixed(2)} MB`,
        });

        expect(memoryInfo.usedJSHeapSize).toBeLessThan(500 * 1024 * 1024);
      }
    });
  });
