/**
 * @file text.ts - UTF-8 byte-aware text utilities
 * @description Shared between Main and Renderer for byte-budgeted truncation
 *              (LLM context payloads must respect byte caps, not char counts).
 */

/** Exact UTF-8 byte length of a string. */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Truncate `s` so its UTF-8 byte length stays within `maxBytes`, appending a
 * `[...truncated]` marker. Binary-searches the cut point because multi-byte
 * codepoints make char-index slicing unsafe. Reserves headroom for the marker.
 */
export function truncateToBytes(s: string, maxBytes: number): string {
  if (utf8ByteLength(s) <= maxBytes) return s;
  const reserve = 80;
  const safeMax = Math.max(0, maxBytes - reserve);
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (utf8ByteLength(s.slice(0, mid)) <= safeMax) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo)}\n\n[...truncated]`;
}
