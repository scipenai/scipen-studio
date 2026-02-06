/**
 * @file ICompilerRegistry - Compiler registry contract
 * @description Public interface for compiler registration and lookup
 * @depends CompilerRegistry
 */

import type { CompilerRegistration, ICompiler } from '../compiler/interfaces/ICompiler';

// ====== Interface Definition ======

/**
 * Compiler registry interface.
 * Supports lazy instantiation on first access.
 */
export interface ICompilerRegistry {
  /**
   * Registers a compiler.
   * @param registration Compiler registration info
   * @sideeffect Adds compiler factory to registry
   */
  register(registration: CompilerRegistration): void;

  /**
   * Returns compiler by id or extension.
   * @param idOrExtension Compiler id or file extension
   * @returns Compiler instance or null when missing
   */
  get(idOrExtension: string): ICompiler | null;

  /**
   * Returns compiler by file extension.
   * @param extension File extension (e.g. '.tex', '.typ')
   * @returns Compiler instance or null when missing
   */
  getByExtension(extension: string): ICompiler | null;

  /**
   * Returns compiler by engine name.
   * @param engine Compiler engine (e.g. 'xelatex', 'typst')
   * @returns Compiler instance or null when missing
   */
  getByEngine(engine: string): ICompiler | null;

  /**
   * Returns registered compiler IDs.
   */
  getRegisteredIds(): string[];

  /**
   * Checks whether compiler id is registered.
   * @param id Compiler id
   */
  has(id: string): boolean;

  /**
   * Unregisters a compiler.
   * @param id Compiler id
   * @returns Whether unregistration succeeded
   * @sideeffect Removes compiler from registry
   */
  unregister(id: string): boolean;

  /**
   * Clears all registrations.
   * @sideeffect Empties registry
   */
  clear(): void;
}
