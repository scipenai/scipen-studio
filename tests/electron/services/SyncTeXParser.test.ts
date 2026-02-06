/**
 * @file SyncTeXParser.test.ts - Unit tests for SyncTeX parser
 * @description Tests output parsing functions: forward sync (source → PDF position), inverse sync (PDF → source), and edge cases. Critical because SyncTeX format varies by version, parsing errors cause wrong PDF jumps, and path format differences need special handling.
 * @depends SyncTeXService parser logic
 */

import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Forward Sync result type
 */
interface ForwardSyncResult {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Inverse Sync result type
 */
interface InverseSyncResult {
  file: string;
  line: number;
  column: number;
}

/**
 * Simulate SyncTeXService parsing logic
 * Extracted from actual implementation for independent testing
 */
class TestableSyncTeXParser {
  /**
   * Parse synctex view command output
   *
   * Based on Overleaf's SynctexOutputParser.parseViewOutput
   * synctex view returns PDF coordinates for source positions
   */
  parseViewOutput(output: string): ForwardSyncResult | null {
    const result: Partial<ForwardSyncResult> = {};

    const lines = output
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim());

    for (const line of lines) {
      const pageMatch = line.match(/^Page:(\d+)/);
      if (pageMatch) {
        result.page = Number.parseInt(pageMatch[1], 10);
        continue;
      }

      const xMatch = line.match(/^x:(-?\d+\.?\d*)/);
      if (xMatch) {
        result.x = Number.parseFloat(xMatch[1]);
        continue;
      }

      const yMatch = line.match(/^y:(-?\d+\.?\d*)/);
      if (yMatch) {
        result.y = Number.parseFloat(yMatch[1]);
        continue;
      }

      const hMatch = line.match(/^h:(-?\d+\.?\d*)/);
      if (hMatch && result.x === undefined) {
        result.x = Number.parseFloat(hMatch[1]);
        continue;
      }

      const vMatch = line.match(/^v:(-?\d+\.?\d*)/);
      if (vMatch && result.y === undefined) {
        result.y = Number.parseFloat(vMatch[1]);
        continue;
      }

      const wMatch = line.match(/^W:(-?\d+\.?\d*)/);
      if (wMatch) {
        result.width = Number.parseFloat(wMatch[1]);
        continue;
      }

      const heightMatch = line.match(/^H:(-?\d+\.?\d*)/);
      if (heightMatch) {
        result.height = Number.parseFloat(heightMatch[1]);
        continue;
      }

      if (
        result.page !== undefined &&
        result.x !== undefined &&
        result.y !== undefined &&
        result.width !== undefined &&
        result.height !== undefined
      ) {
        break;
      }
    }

    if (result.page !== undefined && result.x !== undefined && result.y !== undefined) {
      return {
        page: result.page,
        x: result.x,
        y: result.y,
        width: result.width || 0,
        height: result.height || 0,
      };
    }

    return null;
  }

  /**
   * Parse synctex edit command output
   *
   * Based on Overleaf's SynctexOutputParser.parseEditOutput
   * synctex edit returns source line/column for PDF positions
   */
  parseEditOutput(output: string): InverseSyncResult | null {
    const result: Partial<InverseSyncResult> = {};

    const lines = output.split('\n');
    for (const line of lines) {
      const inputMatch = line.match(/^Input:(.+)$/);
      if (inputMatch) {
        result.file = inputMatch[1].trim();
        continue;
      }

      const lineMatch = line.match(/^Line:(\d+)$/);
      if (lineMatch) {
        result.line = Number.parseInt(lineMatch[1], 10);
        continue;
      }

      const columnMatch = line.match(/^Column:(-?\d+)$/);
      if (columnMatch) {
        result.column = Math.max(0, Number.parseInt(columnMatch[1], 10));
      }
    }

    if (result.file && result.line !== undefined) {
      return {
        file: result.file,
        line: result.line,
        column: result.column || 0,
      };
    }

    return null;
  }
}

describe('SyncTeX Parser - Forward Sync (parseViewOutput)', () => {
  let parser: TestableSyncTeXParser;

  beforeEach(() => {
    parser = new TestableSyncTeXParser();
  });

  describe('Standard Output Parsing', () => {
    it('should parse complete synctex view output', () => {
      const output = `SyncTeX result begin
Output:document.pdf
Page:1
x:72.27
y:702.70
h:72.27
v:702.70
W:469.47
H:12.00
before:
offset:0
middle:
after:
SyncTeX result end
`;
      const result = parser.parseViewOutput(output);

      expect(result).not.toBeNull();
      expect(result!.page).toBe(1);
      expect(result!.x).toBeCloseTo(72.27);
      expect(result!.y).toBeCloseTo(702.7);
      expect(result!.width).toBeCloseTo(469.47);
      expect(result!.height).toBeCloseTo(12.0);
    });

    it('should handle multi-page documents', () => {
      const output = `Page:5
x:100.00
y:500.00
W:300.00
H:15.00`;

      const result = parser.parseViewOutput(output);
      expect(result).not.toBeNull();
      expect(result!.page).toBe(5);
    });

    it('should handle negative coordinate values', () => {
      const output = `Page:1
x:-10.50
y:800.00
W:100.00
H:12.00`;

      const result = parser.parseViewOutput(output);
      expect(result).not.toBeNull();
      expect(result!.x).toBeCloseTo(-10.5);
    });

    it('should use h/v as fallback coordinates', () => {
      const output = `Page:1
h:72.27
v:702.70
W:469.47
H:12.00`;

      const result = parser.parseViewOutput(output);
      expect(result).not.toBeNull();
      expect(result!.x).toBeCloseTo(72.27);
      expect(result!.y).toBeCloseTo(702.7);
    });
  });

  describe('Minimal Output', () => {
    it('should parse output with only required fields', () => {
      const output = `Page:1
x:100.00
y:200.00`;

      const result = parser.parseViewOutput(output);
      expect(result).not.toBeNull();
      expect(result!.page).toBe(1);
      expect(result!.x).toBe(100);
      expect(result!.y).toBe(200);
      expect(result!.width).toBe(0);
      expect(result!.height).toBe(0);
    });
  });

  describe('Errors and Edge Cases', () => {
    it('should return null for empty output', () => {
      const result = parser.parseViewOutput('');
      expect(result).toBeNull();
    });

    it('无效输出应返回 null', () => {
      const output = `This is not synctex output
Just some random text`;

      const result = parser.parseViewOutput(output);
      expect(result).toBeNull();
    });

    it('should return null when page number is missing', () => {
      const output = `x:100.00
y:200.00
W:300.00`;

      const result = parser.parseViewOutput(output);
      expect(result).toBeNull();
    });

    it('should return null when coordinates are missing', () => {
      const output = `Page:1
W:300.00
H:12.00`;

      const result = parser.parseViewOutput(output);
      expect(result).toBeNull();
    });

    it('should handle Windows line endings', () => {
      const output = 'Page:1\r\nx:100.00\r\ny:200.00\r\n';
      const result = parser.parseViewOutput(output);

      expect(result).not.toBeNull();
      expect(result!.page).toBe(1);
    });

    it('should handle output with whitespace', () => {
      const output = `  Page:1  
  x:100.00  
  y:200.00  `;

      const result = parser.parseViewOutput(output);
      expect(result).not.toBeNull();
    });
  });

  describe('Multiple Results Handling', () => {
    it('should correctly handle multiple result blocks', () => {
      const output = `Page:1
x:100.00
y:200.00
W:300.00
H:12.00
Page:2
x:150.00
y:250.00
W:300.00
H:12.00`;

      const result = parser.parseViewOutput(output);
      expect(result).not.toBeNull();
      expect(result!.page).toBeGreaterThanOrEqual(1);
      expect(result!.x).toBeDefined();
      expect(result!.y).toBeDefined();
    });
  });
});

describe('SyncTeX Parser - Inverse Sync (parseEditOutput)', () => {
  let parser: TestableSyncTeXParser;

  beforeEach(() => {
    parser = new TestableSyncTeXParser();
  });

  describe('Standard Output Parsing', () => {
    it('should parse complete synctex edit output', () => {
      const output = `SyncTeX result begin
Output:document.pdf
Input:./main.tex
Line:42
Column:0
SyncTeX result end
`;
      const result = parser.parseEditOutput(output);

      expect(result).not.toBeNull();
      expect(result!.file).toBe('./main.tex');
      expect(result!.line).toBe(42);
      expect(result!.column).toBe(0);
    });

    it('should handle absolute paths', () => {
      const output = `Input:/home/user/project/main.tex
Line:100
Column:5`;

      const result = parser.parseEditOutput(output);
      expect(result).not.toBeNull();
      expect(result!.file).toBe('/home/user/project/main.tex');
    });

    it('should handle Windows paths', () => {
      const output = `Input:c:/Users/name/project/main.tex
Line:50
Column:10`;

      const result = parser.parseEditOutput(output);
      expect(result).not.toBeNull();
      expect(result!.file).toBe('c:/Users/name/project/main.tex');
    });

    it('should handle paths with spaces', () => {
      const output = `Input:./My Documents/project/main.tex
Line:25
Column:0`;

      const result = parser.parseEditOutput(output);
      expect(result).not.toBeNull();
      expect(result!.file).toBe('./My Documents/project/main.tex');
    });
  });

  describe('Column Number Handling', () => {
    it('should handle positive column numbers', () => {
      const output = `Input:main.tex
Line:10
Column:25`;

      const result = parser.parseEditOutput(output);
      expect(result!.column).toBe(25);
    });

    it('should convert negative column numbers to 0', () => {
      const output = `Input:main.tex
Line:10
Column:-1`;

      const result = parser.parseEditOutput(output);
      expect(result!.column).toBe(0);
    });

    it('should default to 0 when column number is missing', () => {
      const output = `Input:main.tex
Line:10`;

      const result = parser.parseEditOutput(output);
      expect(result!.column).toBe(0);
    });
  });

  describe('Errors and Edge Cases', () => {
    it('should return null for empty output', () => {
      const result = parser.parseEditOutput('');
      expect(result).toBeNull();
    });

    it('无效输出应返回 null', () => {
      const output = 'No valid synctex data';
      const result = parser.parseEditOutput(output);
      expect(result).toBeNull();
    });

    it('should return null when filename is missing', () => {
      const output = `Line:42
Column:0`;

      const result = parser.parseEditOutput(output);
      expect(result).toBeNull();
    });

    it('should return null when line number is missing', () => {
      const output = `Input:main.tex
Column:0`;

      const result = parser.parseEditOutput(output);
      expect(result).toBeNull();
    });
  });

  describe('Special Filenames', () => {
    it('should handle LaTeX subfiles', () => {
      const output = `Input:./chapters/chapter1.tex
Line:15
Column:0`;

      const result = parser.parseEditOutput(output);
      expect(result!.file).toBe('./chapters/chapter1.tex');
    });

    it('should handle generated intermediate files', () => {
      const output = `Input:./_minted-main/12345.pyg
Line:1
Column:0`;

      const result = parser.parseEditOutput(output);
      expect(result!.file).toContain('_minted-main');
    });
  });
});

describe('SyncTeX Parser - Integration Scenarios', () => {
  let parser: TestableSyncTeXParser;

  beforeEach(() => {
    parser = new TestableSyncTeXParser();
  });

  it('should correctly handle real synctex view output', () => {
    const realOutput = `This is SyncTeX command line utility, version 1.4
SyncTeX result begin
Output:./main.pdf
Page:3
x:72.26999
y:657.18750
h:72.26999
v:657.18750
W:455.24411
H:12.00000
before:
offset:0
middle:
after:
SyncTeX result end
`;

    const result = parser.parseViewOutput(realOutput);
    expect(result).not.toBeNull();
    expect(result!.page).toBe(3);
    expect(result!.x).toBeCloseTo(72.27, 1);
    expect(result!.y).toBeCloseTo(657.19, 1);
  });

  it('should correctly handle real synctex edit output', () => {
    const realOutput = `This is SyncTeX command line utility, version 1.4
SyncTeX result begin
Output:./main.pdf
Input:c:/Users/test/Documents/thesis/main.tex
Line:156
Column:0
SyncTeX result end
`;

    const result = parser.parseEditOutput(realOutput);
    expect(result).not.toBeNull();
    expect(result!.line).toBe(156);
    expect(result!.file).toContain('thesis/main.tex');
  });
});
