/**
 * @file TrigramIndex.test.ts
 * @description Pure-data unit tests for the trigram inverted index.
 *   We pin the public contract (upsert / remove / search semantics) so
 *   the ranking heuristics can be tuned without breaking ZoteroIndex.
 */

import { describe, expect, it } from 'vitest';
import {
  TrigramIndex,
  extractTrigrams,
} from '../../../shared/utils/trigram';

describe('extractTrigrams', () => {
  it('lowercases and pads tokens with leading/trailing space', () => {
    const grams = extractTrigrams('Hi');
    // padded to "  hi " — yields "  h", " hi", "hi ".
    expect(grams.has('  h')).toBe(true);
    expect(grams.has(' hi')).toBe(true);
    expect(grams.has('hi ')).toBe(true);
  });

  it('treats punctuation as token boundaries', () => {
    const grams = extractTrigrams('foo-bar');
    expect(grams.has(' fo')).toBe(true);
    expect(grams.has(' ba')).toBe(true);
    expect(grams.has('foo')).toBe(true);
    expect(grams.has('bar')).toBe(true);
    // No 'oo-' / 'o-b' grams: punctuation broke the token.
    expect(grams.has('oo-')).toBe(false);
  });

  it('returns empty set for blank input', () => {
    expect(extractTrigrams('').size).toBe(0);
    expect(extractTrigrams('   ').size).toBe(0);
    expect(extractTrigrams('!!!').size).toBe(0);
  });
});

describe('TrigramIndex', () => {
  it('ranks citation-key matches above pure title matches', () => {
    const idx = new TrigramIndex<string>();
    idx.upsert('A', 'smith2024deep learning protein folding', 1.5);
    idx.upsert('B', 'jones2023nlp language models', 1.5);
    idx.upsert('C', 'a paper that mentions smith somewhere', 1.0);

    const hits = idx.search('smit', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.id).toBe('A');
  });

  it('removes deleted entries from future searches', () => {
    const idx = new TrigramIndex<string>();
    idx.upsert('A', 'smith2024');
    idx.upsert('B', 'jones2023');
    idx.remove('A');

    const hits = idx.search('smit');
    expect(hits.some((h) => h.id === 'A')).toBe(false);
    expect(idx.size()).toBe(1);
  });

  it('upsert replaces prior text rather than accumulating', () => {
    const idx = new TrigramIndex<string>();
    idx.upsert('A', 'old text');
    idx.upsert('A', 'completely different content');

    const oldHits = idx.search('old', 10);
    expect(oldHits.find((h) => h.id === 'A')).toBeUndefined();

    const newHits = idx.search('content', 10);
    expect(newHits.find((h) => h.id === 'A')).toBeDefined();
  });

  it('honours limit', () => {
    const idx = new TrigramIndex<string>();
    for (let i = 0; i < 10; i++) idx.upsert(`id-${i}`, 'apple banana cherry');
    const hits = idx.search('apple', 3);
    expect(hits.length).toBe(3);
  });

  it('returns empty for blank queries', () => {
    const idx = new TrigramIndex<string>();
    idx.upsert('A', 'smith');
    expect(idx.search('').length).toBe(0);
    expect(idx.search('   ').length).toBe(0);
  });
});
