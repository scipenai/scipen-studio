/**
 * @file getErrorMessage — single extraction point for error text
 * @description Replaces the `err instanceof Error ? err.message : String(err)`
 * ternary that was inlined ~38 times across the renderer.
 */

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
