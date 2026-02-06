/**
 * @file Compiler Setup - Compiler Service Initialization
 * @description Registers all compilers (LaTeX/Typst) at app startup with lazy loading
 * @depends CompilerRegistry, LaTeXCompiler, TypstCompiler
 */

import { LaTeXCompiler } from '../LaTeXCompiler';
import { createLogger } from '../LoggerService';
import { TypstCompiler } from '../TypstCompiler';
import { CompilerRegistry } from './CompilerRegistry';

const logger = createLogger('CompilerSetup');
// Note: OverleafCompiler requires configuration to initialize, not auto-registered here

/**
 * Initialize and register all local compilers
 *
 * Uses lazy loading mode: compilers are only instantiated on first use,
 * reducing application startup time and initial memory usage.
 *
 * After calling this function, access all registered compilers via CompilerRegistry:
 * - CompilerRegistry.getByExtension('.tex') -> LaTeXCompiler
 * - CompilerRegistry.getByExtension('.typ') -> TypstCompiler
 * - CompilerRegistry.getByEngine('xelatex') -> LaTeXCompiler
 */
export function initializeCompilerRegistry(): void {
  logger.info('[Compiler Setup] Initializing compiler registry (lazy mode)...');

  // Register LaTeX compiler - lazy loading
  // Provide metadata to avoid immediate instantiation
  CompilerRegistry.register({
    id: 'latex-local',
    compiler: LaTeXCompiler,
    enabled: true,
    priority: 10,
    // Metadata used for indexing, can query without instantiation
    extensions: ['.tex', '.ltx', '.sty', '.cls', '.bib'],
    engines: ['pdflatex', 'xelatex', 'lualatex', 'tectonic', 'latex'],
  });

  // Register Typst compiler - lazy loading
  CompilerRegistry.register({
    id: 'typst-local',
    compiler: TypstCompiler,
    enabled: true,
    priority: 10,
    extensions: ['.typ'],
    engines: ['typst', 'tinymist'],
  });

  logger.info(
    '[Compiler Setup] Compiler registry initialization complete (compilers will be instantiated on first use)'
  );
  logger.info(
    '[Compiler Setup] Registered compiler IDs:',
    CompilerRegistry.getRegisteredIds().join(', ')
  );
}

/**
 * Register Overleaf remote compiler
 *
 * Overleaf compiler requires configuration to use, so registration function is provided separately
 *
 * @param overleafCompiler Overleaf compiler instance
 */
export function registerOverleafCompiler(_overleafCompiler: unknown): void {
  // Note: OverleafCompiler doesn't implement ICompiler interface yet
  // This is just a reserved extension point
  logger.info(
    '[Compiler Setup] Overleaf compiler registration (needs ICompiler interface implementation)'
  );
}

/**
 * Get compiler that supports the specified file
 *
 * @param filePath File path
 * @returns Compiler instance or undefined
 */
export function getCompilerForFile(filePath: string) {
  return CompilerRegistry.getByFilePath(filePath);
}

/**
 * Get compiler for specified engine
 *
 * @param engine Engine name
 * @returns Compiler instance or undefined
 */
export function getCompilerByEngine(engine: string) {
  return CompilerRegistry.getByEngine(engine);
}

// Export CompilerRegistry for other modules to use directly
export { CompilerRegistry } from './CompilerRegistry';
