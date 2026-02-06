/**
 * @file templateManager.ts - Template and style file manager
 * @description Scans, validates, and manages user .tex templates and .sty style files for Beamer presentations
 * @depends fs, path, os
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function getScipenHomeDir(): string {
  return path.join(os.homedir(), '.scipen');
}

export interface TemplateInfo {
  name: string;
  path: string;
  description: string;
  usesStyleFile: boolean;
  styleFiles: string[];
}

export interface StyleFileInfo {
  name: string;
  path: string;
  exists: boolean;
}

export interface TemplateConfig {
  useCustomTemplate: boolean;
  templatePath?: string;
  styleFiles: StyleFileInfo[];
}

export class TemplateManager {
  private templatesDir: string;
  private stylesDir: string;

  constructor(baseDir?: string) {
    // Default to global directory ~/.scipen/beamer
    const effectiveBaseDir = baseDir || path.join(getScipenHomeDir(), 'beamer');
    this.templatesDir = path.join(effectiveBaseDir, 'templates');
    this.stylesDir = path.join(effectiveBaseDir, 'styles');
    
    // Ensure directories exist
    this.ensureDirectories();
  }

  /**
   * Ensures necessary directories exist
   */
  private ensureDirectories(): void {
    if (!fs.existsSync(this.templatesDir)) {
      fs.mkdirSync(this.templatesDir, { recursive: true });
      console.log(`📁 Created template directory: ${this.templatesDir}`);
    }
    
    if (!fs.existsSync(this.stylesDir)) {
      fs.mkdirSync(this.stylesDir, { recursive: true });
      console.log(`📁 Created styles directory: ${this.stylesDir}`);
    }
  }

  /**
   * Scan all available templates
   */
  scanTemplates(): TemplateInfo[] {
    const templates: TemplateInfo[] = [];

    if (!fs.existsSync(this.templatesDir)) {
      return templates;
    }

    const files = fs.readdirSync(this.templatesDir);
    
    for (const file of files) {
      if (!file.endsWith('.tex')) {
        continue;
      }

      const templatePath = path.join(this.templatesDir, file);
      const content = fs.readFileSync(templatePath, 'utf-8');
      
      const styleFiles = this.extractStyleFiles(content);

      templates.push({
        name: path.basename(file, '.tex'),
        path: templatePath,
        description: this.extractDescription(content),
        usesStyleFile: styleFiles.length > 0,
        styleFiles: styleFiles
      });
    }

    return templates;
  }

  /**
   * Extracts style file references from template content
   * Returns custom style files that exist in styles/ directory
   */
  private extractStyleFiles(content: string): string[] {
    const allPackages = this.extractAllPackages(content);
    
    // Only return packages that exist in styles directory
    return allPackages.filter(packageName => {
      const styPath = path.join(this.stylesDir, `${packageName}.sty`);
      return fs.existsSync(styPath);
    });
  }

  /**
   * Extracts all non-standard packages referenced in template (for prompting user about missing dependencies)
   */
  extractRequiredPackages(content: string): {
    found: string[];      // Found in styles/ directory
    missing: string[];    // Non-standard packages not in styles/ directory
    standard: string[];   // Standard packages (no user input required)
  } {
    const allPackages = this.extractAllPackages(content);
    
    const found: string[] = [];
    const missing: string[] = [];
    const standard: string[] = [];
    
    for (const pkg of allPackages) {
      const styPath = path.join(this.stylesDir, `${pkg}.sty`);
      if (fs.existsSync(styPath)) {
        found.push(pkg);
      } else if (this.isStandardPackage(pkg)) {
        standard.push(pkg);
      } else {
        missing.push(pkg);
      }
    }
    
    return { found, missing, standard };
  }

  private extractAllPackages(content: string): string[] {
    const packages = new Set<string>();
    
    // Remove comment lines to avoid matching commented-out packages
    const contentWithoutComments = content
      .split('\n')
      .map(line => {
        const commentIndex = line.indexOf('%');
        // Handle escaped \% sequences
        if (commentIndex > 0 && line[commentIndex - 1] === '\\') {
          return line;
        }
        return commentIndex >= 0 ? line.substring(0, commentIndex) : line;
      })
      .join('\n');
    
    // Match \usepackage and \RequirePackage (supports multi-line options)
    const packageRegex = /\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/gi;
    let match;
    
    while ((match = packageRegex.exec(contentWithoutComments)) !== null) {
      const packageList = match[1];
      
      // Handle multi-package syntax: \usepackage{pkg1,pkg2,pkg3}
      const pkgNames = packageList.split(',').map(p => p.trim()).filter(p => p);
      
      for (const pkg of pkgNames) {
        // Remove path prefixes (e.g., ./local/mystyle)
        const cleanPkg = path.basename(pkg, '.sty');
        if (cleanPkg && !cleanPkg.includes('/') && !cleanPkg.includes('\\')) {
          packages.add(cleanPkg);
        }
      }
    }
    
    // Detect Beamer theme-related commands
    const themeCommands = [
      { regex: /\\usetheme(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/gi, prefix: 'beamertheme' },
      { regex: /\\usecolortheme(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/gi, prefix: 'beamercolortheme' },
      { regex: /\\usefonttheme(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/gi, prefix: 'beamerfonttheme' },
      { regex: /\\useinnertheme(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/gi, prefix: 'beamerinnertheme' },
      { regex: /\\useoutertheme(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/gi, prefix: 'beameroutertheme' },
    ];
    
    for (const { regex, prefix } of themeCommands) {
      while ((match = regex.exec(contentWithoutComments)) !== null) {
        const themeName = match[1].trim();
        // Only check non-standard themes
        if (!this.isStandardBeamerTheme(themeName)) {
          packages.add(`${prefix}${themeName}`);
        }
      }
    }
    
    return [...packages];
  }

  private isStandardPackage(packageName: string): boolean {
    // Common standard LaTeX packages (provided by TeX Live)
    const standardPackages = new Set([
      // Math-related
      'amsmath', 'amssymb', 'amsfonts', 'amsthm', 'mathtools', 'mathrsfs', 'bm',
      
      // Graphics-related
      'graphicx', 'graphics', 'epsfig', 'subfig', 'subfigure', 'caption', 'subcaption',
      'tikz', 'pgf', 'pgfplots', 'pgfplotstable', 'pstricks',
      
      // Color-related
      'color', 'xcolor', 'colortbl',
      
      // Font-related
      'fontenc', 'inputenc', 'textcomp', 'lmodern', 'times', 'helvet', 'courier',
      'mathptmx', 'palatino', 'bookman', 'utopia', 'charter', 'newcent', 'fontspec',
      
      // Chinese support
      'xeCJK', 'CJK', 'CJKutf8', 'ctex', 'xeCJKfntef', 'luatexja',
      
      // Page layout
      'geometry', 'fancyhdr', 'setspace', 'parskip', 'indentfirst', 'titlesec',
      
      // Hyperlinks and bookmarks
      'hyperref', 'url', 'xurl', 'bookmark', 'href',
      
      // Lists and enumeration
      'enumerate', 'enumitem', 'paralist', 'mdwlist',
      
      // Code and algorithms
      'listings', 'algorithm', 'algorithmic', 'algorithm2e', 'algorithmicx', 
      'algpseudocode', 'minted', 'verbatim', 'fancyvrb', 'moreverb',
      
      // Table-related
      'array', 'tabularx', 'longtable', 'booktabs', 'multirow', 'hhline',
      'tabulary', 'tabu', 'threeparttable',
      
      // Bibliography
      'natbib', 'biblatex', 'cite', 'bibtex', 'apacite',
      
      // Beamer-related
      'beamer', 'beamerposter', 'beamerarticle',
      
      // Other common packages
      'babel', 'csquotes', 'etoolbox', 'xparse', 'ifthen', 'calc', 'xifthen',
      'float', 'wrapfig', 'rotating', 'pdflscape', 'pdfpages', 'afterpage',
      'multicol', 'appendix', 'tocbibind', 'microtype', 'lipsum', 'blindtext',
      'soul', 'ulem', 'cancel', 'siunitx', 'units', 'datetime', 'fmtcount',
      'adjustbox', 'trimclip', 'environ', 'tcolorbox', 'mdframed', 'framed',
      'stackengine', 'scalerel', 'relsize', 'anyfontsize',
    ]);
    
    return standardPackages.has(packageName);
  }

  private isStandardBeamerTheme(themeName: string): boolean {
    const standardThemes = new Set([
      // Standard themes
      'default', 'AnnArbor', 'Antibes', 'Bergen', 'Berkeley', 'Berlin',
      'Boadilla', 'CambridgeUS', 'Copenhagen', 'Darmstadt', 'Dresden',
      'EastLansing', 'Frankfurt', 'Goettingen', 'Hannover', 'Ilmenau',
      'JuanLesPins', 'Luebeck', 'Madrid', 'Malmoe', 'Marburg', 'Montpellier',
      'PaloAlto', 'Pittsburgh', 'Rochester', 'Singapore', 'Szeged', 'Warsaw',
      
      // Standard color themes
      'default', 'albatross', 'beaver', 'beetle', 'crane', 'dolphin',
      'dove', 'fly', 'lily', 'monarca', 'orchid', 'rose', 'seagull',
      'seahorse', 'sidebartab', 'spruce', 'structure', 'whale', 'wolverine',
      
      // Standard font themes
      'default', 'professionalfonts', 'serif', 'structurebold',
      'structureitalicserif', 'structuresmallcapsserif',
    ]);
    
    return standardThemes.has(themeName);
  }

  private extractDescription(content: string): string {
    // Look for comments like % Description: xxx
    const descRegex = /%\s*Description:\s*(.+)/i;
    const match = content.match(descRegex);
    
    if (match) {
      return match[1].trim();
    }

    return 'Custom template';
  }

  getStyleFilePath(styleName: string): string | null {
    const styPath = path.join(this.stylesDir, `${styleName}.sty`);
    
    if (fs.existsSync(styPath)) {
      return styPath;
    }

    return null;
  }

  /**
   * Validate template file structure
   * @throws Never throws, returns errors array on validation failure
   */
  validateTemplate(templatePath: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!fs.existsSync(templatePath)) {
      errors.push('Template file does not exist');
      return { valid: false, errors };
    }

    if (!templatePath.endsWith('.tex')) {
      errors.push('Template file must be .tex format');
      return { valid: false, errors };
    }

    try {
      const content = fs.readFileSync(templatePath, 'utf-8');

      if (!content.includes('\\documentclass')) {
        errors.push('Template missing \\documentclass declaration');
      }

      if (!content.includes('\\begin{document}')) {
        errors.push('Template missing \\begin{document}');
      }

      if (!content.includes('\\end{document}')) {
        errors.push('Template missing \\end{document}');
      }

      if (!content.includes('\\documentclass') || !content.toLowerCase().includes('beamer')) {
        errors.push('Warning: Template may not be a Beamer document class');
      }

    } catch (error) {
      errors.push(`Cannot read template file: ${error instanceof Error ? error.message : String(error)}`);
    }

    return { valid: errors.length === 0, errors };
  }

  createTemplateConfig(templatePath?: string): TemplateConfig {
    if (!templatePath) {
      return {
        useCustomTemplate: false,
        styleFiles: []
      };
    }

    const content = fs.readFileSync(templatePath, 'utf-8');
    const styleNames = this.extractStyleFiles(content);
    
    const styleFiles: StyleFileInfo[] = styleNames.map(name => {
      const styPath = this.getStyleFilePath(name);
      return {
        name,
        path: styPath || path.join(this.stylesDir, `${name}.sty`),
        exists: styPath !== null
      };
    });

    return {
      useCustomTemplate: true,
      templatePath,
      styleFiles
    };
  }

  getTemplateName(templatePath: string): string {
    return path.basename(templatePath, '.tex');
  }

  listStyleFiles(): string[] {
    if (!fs.existsSync(this.stylesDir)) {
      return [];
    }

    return fs.readdirSync(this.stylesDir)
      .filter(file => file.endsWith('.sty'))
      .map(file => path.basename(file, '.sty'));
  }

  hasStyleFiles(): boolean {
    return this.listStyleFiles().length > 0;
  }

  hasTemplates(): boolean {
    return this.scanTemplates().length > 0;
  }

  getDirectoryPaths(): { templates: string; styles: string } {
    return {
      templates: this.templatesDir,
      styles: this.stylesDir
    };
  }
}

