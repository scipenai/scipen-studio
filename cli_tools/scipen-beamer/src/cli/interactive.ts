import * as readline from 'readline';
import { TemplateManager, type TemplateInfo } from '../utils/templateManager.js';

/**
 * Interactive selection result
 */
export interface InteractiveResult {
  useCustomTemplate: boolean;
  templatePath?: string;
}

/**
 * Interactive CLI tool
 */
export class InteractiveCLI {
  private rl: readline.Interface;
  private templateManager: TemplateManager;

  constructor(baseDir: string = './.scipen') {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    this.templateManager = new TemplateManager(baseDir);
  }

  /**
   * Ask a question and get the answer
   */
  private question(query: string): Promise<string> {
    return new Promise(resolve => {
      this.rl.question(query, resolve);
    });
  }

  /**
   * Close readline interface
   */
  close(): void {
    this.rl.close();
  }

  /**
   * Show welcome message
   */
  private showWelcome(): void {
    console.log(`\n\x1b[36m${'='.repeat(60)}\x1b[0m`);
    console.log('\x1b[36m  📄 Paper-to-Beamer Generation System\x1b[0m');
    console.log(`\x1b[36m${'='.repeat(60)}\x1b[0m\n`);
  }

  /**
   * Display template information
   */
  private displayTemplateInfo(templates: TemplateInfo[]): void {
    console.log('\n\x1b[33m📋 Available Templates:\x1b[0m\n');
    
    templates.forEach((template, index) => {
      console.log(`  \x1b[32m[${index + 1}]\x1b[0m ${template.name}`);
      console.log(`      Description: ${template.description}`);
      
      if (template.usesStyleFile && template.styleFiles.length > 0) {
        const stylesList = template.styleFiles.join(', ');
        console.log(`      Styles: ${stylesList}`);
        
        // Check if style files exist
        const missingStyles = template.styleFiles.filter(name => {
          const styPath = this.templateManager.getStyleFilePath(name);
          return styPath === null;
        });
        
        if (missingStyles.length > 0) {
          console.log(`      \x1b[31m⚠️  Missing style files: ${missingStyles.join(', ')}\x1b[0m`);
        }
      } else {
        console.log('      Styles: None');
      }
      
      console.log('');
    });
  }

  /**
   * Ask if user wants to use custom template
   */
  async askForTemplate(): Promise<InteractiveResult> {
    this.showWelcome();

    // Ask user if they want to use custom template
    const useCustom = await this.question('\x1b[36mUse custom Beamer template? (y/n): \x1b[0m');
    
    // If not using custom template, use default style
    if (useCustom.toLowerCase() !== 'y' && useCustom.toLowerCase() !== 'yes') {
      this.close();
      console.log('\n\x1b[32m✓ Using default style (Boadilla theme)\x1b[0m\n');
      return { useCustomTemplate: false };
    }

    // Ask for template file path
    console.log('');
    const templatePath = await this.question('\x1b[36mEnter template file path (.tex): \x1b[0m');
    
    this.close();

    // Validate path
    const trimmedPath = templatePath.trim();
    if (!trimmedPath) {
      console.log('\n\x1b[33m⚠️  No path entered, using default style\x1b[0m\n');
      return { useCustomTemplate: false };
    }

    // Check if file exists
    const fs = await import('fs');
    const path = await import('path');
    
    if (!fs.existsSync(trimmedPath)) {
      console.log(`\n\x1b[31m❌ File not found: ${trimmedPath}\x1b[0m`);
      console.log('\x1b[33mUsing default style\x1b[0m\n');
      return { useCustomTemplate: false };
    }

    // Validate template
    const validation = this.templateManager.validateTemplate(trimmedPath);
    
    if (!validation.valid) {
      console.log('\n\x1b[31m❌ Template validation failed:\x1b[0m');
      validation.errors.forEach(err => console.log(`   - ${err}`));
      console.log('\n\x1b[33mUsing default style\x1b[0m\n');
      return { useCustomTemplate: false };
    }

    // Check style files referenced in template (using improved detection method)
    const templateContent = fs.readFileSync(trimmedPath, 'utf-8');
    const packageInfo = this.templateManager.extractRequiredPackages(templateContent);
    
    const dirs = this.templateManager.getDirectoryPaths();
    
    // Display detection results
    if (packageInfo.found.length > 0) {
      console.log(`\n\x1b[32m✓ Found custom style files:\x1b[0m ${packageInfo.found.join(', ')}`);
    }
    
    if (packageInfo.missing.length > 0) {
      console.log(`\n\x1b[33m⚠️  Detected potentially required style files (not found in styles/ directory):\x1b[0m`);
      packageInfo.missing.forEach(name => console.log(`   - ${name}.sty`));
      console.log(`\n   If these are custom styles, please place .sty files in:`);
      console.log(`   \x1b[36m${dirs.styles}\x1b[0m`);
      console.log(`   If these are standard TeX packages, you can ignore this warning.\n`);
    }
    
    console.log(`\x1b[32m✓ Selected template: ${path.basename(trimmedPath)}\x1b[0m\n`);

    return {
      useCustomTemplate: true,
      templatePath: trimmedPath
    };
  }

  /**
   * Silent mode: automatically select default style
   */
  static useDefaultSilently(): InteractiveResult {
    return { useCustomTemplate: false };
  }

  /**
   * Show template hint information (non-interactive mode)
   */
  static showTemplateHint(): void {
    const templateManager = new TemplateManager();
    const dirs = templateManager.getDirectoryPaths();
    
    console.log('\n\x1b[36m💡 Hint:\x1b[0m');
    console.log('   Custom templates (.tex): ' + dirs.templates);
    console.log('   Style files (.sty):      ' + dirs.styles);
    console.log('');
  }
}

