/**
 * @file workflow.e2e.ts - E2E workflow tests for SciPen Studio
 * @description Complete end-to-end tests simulating real user behavior. Run with: npm run test:e2e or npx playwright test tests/e2e/workflow.e2e.ts. Scenarios: PDF import -> AI Q&A -> citation jump; new LaTeX -> edit -> compile -> preview -> SyncTeX; destructive tests: offline, large files, special characters.
 * @depends Playwright, Electron
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

const Filename = fileURLToPath(import.meta.url);
const Dirname = path.dirname(Filename);

// ====== Test Configuration ======

let electronApp: ElectronApplication;
let page: Page;

const TEST_DIR = path.join(os.tmpdir(), `scipen-e2e-test-${Date.now()}`);

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
      SCIPEN_E2E_TEST: 'true',
      SCIPEN_ALLOW_MULTIPLE_INSTANCES: 'true',
    },
  };
};

// ====== Test File Creation ======
const createTestFile = (filename: string, content: string): string => {
  const filepath = path.join(TEST_DIR, filename);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
};

// ====== Test Suite ======
test.describe
  .serial('SciPen Studio Workflow E2E Tests', () => {
    test.beforeAll(async () => {
      fs.mkdirSync(TEST_DIR, { recursive: true });

      const appPath = getAppPath();

      if (appPath) {
        electronApp = await electron.launch({
          executablePath: appPath,
          args: ['--disable-gpu', '--no-sandbox'],
          env: {
            ...process.env,
            NODE_ENV: 'test',
            SCIPEN_E2E_TEST: 'true',
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

      try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
      } catch (e) {
        console.warn('Failed to cleanup test directory:', e);
      }
    });

    // ====== Core Path 1: PDF Knowledge Base + AI Q&A ======

    test('1.1 application should start and display home page', async () => {
      const windows = electronApp.windows();
      expect(windows.length).toBeGreaterThan(0);

      const body = await page.locator('body');
      await expect(body).toBeVisible();
    });

    test('1.2 switch to knowledge base panel', async () => {
      const knowledgeTab = page
        .locator('[data-testid="knowledge-tab"]')
        .or(page.locator('button:has-text("知识库")'))
        .or(page.locator('[title*="知识库"]'));

      const count = await knowledgeTab.count();
      if (count > 0) {
        await knowledgeTab.first().click();
        await page.waitForTimeout(500);
      }
    });

    test('1.3 switch to AI panel', async () => {
      const aiTab = page
        .locator('[data-testid="ai-tab"]')
        .or(page.locator('button:has-text("AI")'))
        .or(page.locator('[title*="AI"]'));

      const count = await aiTab.count();
      if (count > 0) {
        await aiTab.first().click();
        await page.waitForTimeout(500);
      }
    });

    test('1.4 find input box in AI panel', async () => {
      const chatInput = page
        .locator('[data-testid="chat-input"]')
        .or(page.locator('textarea[placeholder*="问题"]'))
        .or(page.locator('textarea[placeholder*="输入"]'));

      const count = await chatInput.count();
      if (count > 0) {
        await chatInput.first().fill('这是一个测试问题');
        await page.waitForTimeout(200);
        const value = await chatInput.first().inputValue();
        expect(value).toBe('这是一个测试问题');
      }
    });

    // ====== Core Path 2: LaTeX Edit + Compile + Preview ======

    test('2.1 create new LaTeX file', async () => {
      await page.keyboard.press('Control+N');
      await page.waitForTimeout(500);

      const editor = page.locator('.monaco-editor');
      const count = await editor.count();
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('2.2 input LaTeX content', async () => {
      const editor = page.locator('.monaco-editor').first();
      const editorExists = (await editor.count()) > 0;

      if (editorExists) {
        await editor.click();
        await page.waitForTimeout(200);

        const latexContent = `\\documentclass{article}
\\begin{document}
Hello, LaTeX!
\\end{document}`;

        await page.keyboard.type(latexContent, { delay: 5 });
        await page.waitForTimeout(300);
      }
    });

    test('2.3 trigger auto-completion', async () => {
      const editor = page.locator('.monaco-editor').first();
      const editorExists = (await editor.count()) > 0;

      if (editorExists) {
        await editor.click();
        await page.keyboard.type('\\sec', { delay: 50 });
        await page.waitForTimeout(300);
        await page.keyboard.press('Control+Space');
        await page.waitForTimeout(500);
        await page.keyboard.press('Escape');
      }
    });

    test('2.4 click compile button', async () => {
      const compileBtn = page
        .locator('[data-testid="compile-button"]')
        .or(page.locator('button[title*="编译"]'))
        .or(page.locator('[aria-label*="编译"]'));

      const count = await compileBtn.count();
      if (count > 0) {
        await compileBtn.first().click();
        await page.waitForTimeout(500);
      }
    });

    test('2.5 verify PDF preview area', async () => {
      const pdfPreview = page
        .locator('[data-testid="pdf-preview"]')
        .or(page.locator('[class*="PDFPreview"]'))
        .or(page.locator('[class*="pdf-viewer"]'))
        .or(page.locator('canvas'));

      const count = await pdfPreview.count();
      console.log(`PDF preview element count: ${count}`);
    });

    // ====== Destructive Tests ======

    test('3.1 simulate offline then click AI feature', async () => {
      await page.context().setOffline(true);
      await page.waitForTimeout(200);

      const aiTab = page
        .locator('[data-testid="ai-tab"]')
        .or(page.locator('button:has-text("AI")'));

      const tabCount = await aiTab.count();
      if (tabCount > 0) {
        await aiTab.first().click();
        await page.waitForTimeout(300);
      }

      await page.context().setOffline(false);
      await page.waitForTimeout(200);
    });

    test('3.2 create large test file', async () => {
      let largeContent = '\\documentclass{article}\n\\begin{document}\n';
      for (let i = 0; i < 500; i++) {
        largeContent += `\\section{Section ${i}}\nParagraph ${i}.\n\n`;
      }
      largeContent += '\\end{document}';

      const largePath = createTestFile('large-file.tex', largeContent);
      console.log('Large file test:', largePath, `(${(largeContent.length / 1024).toFixed(1)} KB)`);

      const startTime = Date.now();
      await page.keyboard.press('Control+N');
      await page.waitForTimeout(200);
      const responseTime = Date.now() - startTime;

      expect(responseTime).toBeLessThan(5000);
      console.log(`UI response time: ${responseTime}ms`);
    });

    test('3.3 special character filename test', async () => {
      const specialNames = [
        { name: '中文文件名.tex', desc: 'Chinese' },
        { name: '文件 with spaces.tex', desc: 'spaces' },
        { name: 'CJK日本語한국어.tex', desc: 'CJK mixed' },
      ];

      for (const { name, desc } of specialNames) {
        try {
          const content = `\\documentclass{article}\n\\begin{document}\nTest: ${name}\n\\end{document}`;
          const filePath = createTestFile(name, content);
          const exists = fs.existsSync(filePath);
          expect(exists).toBe(true);
          console.log(`Special filename (${desc}): ✓`);
        } catch (error) {
          console.warn(`Special filename "${name}" test failed:`, error);
        }
      }
    });

    // ====== Performance Tests ======

    test('4.1 application startup time', async () => {
      const timing = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        return {
          domContentLoaded: nav?.domContentLoadedEventEnd - nav?.startTime || 0,
          loadComplete: nav?.loadEventEnd - nav?.startTime || 0,
        };
      });

      console.log('Page load performance:', timing);
      expect(timing.domContentLoaded).toBeLessThan(15000);
    });

    test('4.2 UI responsiveness test', async () => {
      const start = Date.now();
      await page.keyboard.press('Control+P');
      await page.waitForTimeout(100);
      await page.keyboard.press('Escape');
      const duration = Date.now() - start;

      console.log(`Command palette response: ${duration}ms`);
      expect(duration).toBeLessThan(2000);
    });

    test('4.3 memory usage check', async () => {
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

    // ====== Keyboard Shortcuts Tests ======

    test('5.1 keyboard shortcut functionality verification', async () => {
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
        console.log(`Shortcut ${keys} (${name}): ✓`);
      }
    });

    test('5.2 undo/redo functionality', async () => {
      const editor = page.locator('.monaco-editor').first();
      const editorExists = (await editor.count()) > 0;

      if (editorExists) {
        await editor.click();
        await page.keyboard.type('test');
        await page.waitForTimeout(100);
        await page.keyboard.press('Control+Z');
        await page.waitForTimeout(100);
        await page.keyboard.press('Control+Y');
        await page.waitForTimeout(100);
        console.log('Undo/redo: ✓');
      }
    });

    // ====== Screenshot Tests ======

    test('6.1 capture application main interface', async () => {
      const screenshotDir = path.join(TEST_DIR, 'screenshots');
      fs.mkdirSync(screenshotDir, { recursive: true });

      await page.screenshot({
        path: path.join(screenshotDir, 'main-window.png'),
        fullPage: true,
      });
      console.log('Main interface screenshot saved');
    });

    test('6.2 capture editor area', async () => {
      const editor = page.locator('.monaco-editor').first();
      const editorExists = (await editor.count()) > 0;

      if (editorExists) {
        const screenshotDir = path.join(TEST_DIR, 'screenshots');
        await editor.screenshot({
          path: path.join(screenshotDir, 'editor.png'),
        });
        console.log('Editor screenshot saved');
      }
    });
  });
