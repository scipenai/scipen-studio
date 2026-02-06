/**
 * @file test-fixtures.ts - E2E test fixtures and utility functions
 * @description Provides test data and common operation wrappers
 * @depends Playwright, fs, os, path
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Page } from '@playwright/test';

// ====== Test Data ======

export const TEST_LATEX_SIMPLE = `\\documentclass{article}
\\begin{document}
Hello, World!
\\end{document}`;

export const TEST_LATEX_WITH_MATH = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}

\\title{Test Document}
\\author{E2E Test}
\\date{\\today}
\\maketitle

\\section{Introduction}
This is a test document with mathematical formulas.

\\subsection{Inline Math}
The famous equation $E = mc^2$ describes mass-energy equivalence.

\\subsection{Display Math}
The quadratic formula is:
$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$

\\section{More Formulas}
The Pythagorean theorem:
\\begin{equation}
a^2 + b^2 = c^2
\\end{equation}

Matrix example:
\\begin{pmatrix}
1 & 2 \\\\
3 & 4
\\end{pmatrix}

\\end{document}`;

export const TEST_LATEX_WITH_BIB = `\\documentclass{article}
\\usepackage{biblatex}
\\addbibresource{refs.bib}
\\begin{document}

\\title{Test with Citations}
\\maketitle

According to \\cite{einstein1905}, the theory of relativity changed physics.

\\printbibliography

\\end{document}`;

export const TEST_BIBTEX = `@article{einstein1905,
  author = {Einstein, Albert},
  title = {On the Electrodynamics of Moving Bodies},
  journal = {Annalen der Physik},
  year = {1905},
  volume = {17},
  pages = {891--921}
}

@book{knuth1984,
  author = {Knuth, Donald E.},
  title = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year = {1984}
}`;

export const TEST_TYPST_SIMPLE = `#set page(paper: "a4")
#set text(font: "New Computer Modern")

= Test Document

This is a test Typst document.

== Math

The famous equation: $E = m c^2$

Display math:
$ x = (-b plus.minus sqrt(b^2 - 4 a c)) / (2 a) $
`;

// ====== Test Directory Management ======

export class TestDirectory {
  readonly path: string;

  constructor(prefix = 'scipen-e2e') {
    this.path = path.join(
      os.tmpdir(),
      `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(this.path, { recursive: true });
  }

  createFile(filename: string, content: string): string {
    const filepath = path.join(this.path, filename);
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, content, 'utf-8');
    return filepath;
  }

  createBinaryFile(filename: string, size: number): string {
    const filepath = path.join(this.path, filename);
    fs.mkdirSync(path.dirname(filepath), { recursive: true });

    const buffer = Buffer.alloc(size);
    for (let i = 0; i < size; i++) {
      buffer[i] = Math.floor(Math.random() * 256);
    }
    fs.writeFileSync(filepath, buffer);
    return filepath;
  }

  createLargeLatexFile(lines: number): string {
    let content = '\\documentclass{article}\n\\begin{document}\n';
    for (let i = 0; i < lines; i++) {
      content += `\\section{Section ${i}}\nParagraph ${i}. Lorem ipsum dolor sit amet.\n\n`;
    }
    content += '\\end{document}';
    return this.createFile('large-document.tex', content);
  }

  cleanup(): void {
    try {
      fs.rmSync(this.path, { recursive: true, force: true });
    } catch (e) {
      console.warn('Failed to cleanup test directory:', e);
    }
  }

  getPath(filename: string): string {
    return path.join(this.path, filename);
  }
}

// ====== Page Operation Helpers ======

export class PageHelper {
  constructor(private page: Page) {}

  async waitForApp(timeout = 5000): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForTimeout(timeout);
  }

  async openCommandPalette(): Promise<void> {
    await this.page.keyboard.press('Control+P');
    await this.page.waitForTimeout(300);
  }

  async closeCommandPalette(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(100);
  }

  async typeInEditor(content: string, delay = 10): Promise<void> {
    const editor = this.page.locator('.monaco-editor').first();
    await editor.click();
    await this.page.keyboard.type(content, { delay });
  }

  async saveFile(): Promise<void> {
    await this.page.keyboard.press('Control+S');
    await this.page.waitForTimeout(300);
  }

  async compile(): Promise<void> {
    const compileBtn = this.page
      .locator('[data-testid="compile-button"]')
      .or(this.page.locator('button[title*="编译"]'))
      .or(this.page.locator('[aria-label*="编译"]'));

    const count = await compileBtn.count();
    if (count > 0) {
      await compileBtn.first().click();
    } else {
      await this.page.keyboard.press('Control+Enter');
    }
  }

  async waitForCompilation(timeout = 60000): Promise<boolean> {
    try {
      await this.page.waitForSelector('text=/编译成功|Compilation successful|编译完成/i', {
        timeout,
      });
      return true;
    } catch {
      return false;
    }
  }

  async switchToTab(tabName: string): Promise<void> {
    const tab = this.page
      .locator(`[data-testid="${tabName}-tab"]`)
      .or(this.page.locator(`button:has-text("${tabName}")`))
      .or(this.page.locator(`[title*="${tabName}"]`));

    const count = await tab.count();
    if (count > 0) {
      await tab.first().click();
      await this.page.waitForTimeout(300);
    }
  }

  async getEditorContent(): Promise<string> {
    return await this.page.evaluate(() => {
      const monacoEditor = (window as any).monaco?.editor?.getModels?.()?.[0];
      if (monacoEditor) {
        return monacoEditor.getValue();
      }
      return '';
    });
  }

  async setEditorContent(content: string): Promise<void> {
    await this.page.evaluate((content) => {
      const monacoEditor = (window as any).monaco?.editor?.getModels?.()?.[0];
      if (monacoEditor) {
        monacoEditor.setValue(content);
      }
    }, content);
  }

  async isPDFVisible(): Promise<boolean> {
    const pdfElements = this.page.locator('[class*="pdf"]').or(this.page.locator('canvas'));
    return (await pdfElements.count()) > 0;
  }

  async screenshot(name: string, fullPage = false): Promise<void> {
    const dir = path.join(process.cwd(), 'test-results', 'screenshots');
    fs.mkdirSync(dir, { recursive: true });

    await this.page.screenshot({
      path: path.join(dir, `${name}.png`),
      fullPage,
    });
  }
}

// ====== Performance Measurement ======

export class PerformanceHelper {
  private measurements: Map<string, number[]> = new Map();

  async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const result = await fn();
    const duration = performance.now() - start;

    if (!this.measurements.has(name)) {
      this.measurements.set(name, []);
    }
    this.measurements.get(name)!.push(duration);

    return result;
  }

  getStats(name: string): { avg: number; min: number; max: number; count: number } | null {
    const values = this.measurements.get(name);
    if (!values || values.length === 0) return null;

    return {
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
    };
  }

  printReport(): void {
    console.log('\n=== Performance Report ===');
    for (const [name, Values] of this.measurements) {
      const stats = this.getStats(name);
      if (stats) {
        console.log(`${name}:`);
        console.log(`  Count: ${stats.count}`);
        console.log(`  Avg: ${stats.avg.toFixed(2)}ms`);
        console.log(`  Min: ${stats.min.toFixed(2)}ms`);
        console.log(`  Max: ${stats.max.toFixed(2)}ms`);
      }
    }
    console.log('==========================\n');
  }
}

// ====== Assertion Helpers ======

export const assertions = {
  async toHaveVisibleElement(page: Page, selector: string, timeout = 5000): Promise<boolean> {
    try {
      await page.waitForSelector(selector, { state: 'visible', timeout });
      return true;
    } catch {
      return false;
    }
  },

  async toHaveText(page: Page, text: string, timeout = 5000): Promise<boolean> {
    try {
      await page.waitForSelector(`text=${text}`, { timeout });
      return true;
    } catch {
      return false;
    }
  },

  async elementCount(page: Page, selector: string): Promise<number> {
    return await page.locator(selector).count();
  },
};

// ====== Network Simulation ======

export const networkSimulation = {
  async goOffline(page: Page): Promise<void> {
    await page.context().setOffline(true);
  },

  async goOnline(page: Page): Promise<void> {
    await page.context().setOffline(false);
  },

  async simulateSlowNetwork(_page: Page): Promise<void> {
    console.log('Slow network simulation (placeholder)');
  },
};
