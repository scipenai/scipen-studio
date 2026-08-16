/**
 * @file citationKeyMinter.test.ts
 * @description Covers BBT default formula `[auth:lower][year][veryshorttitle:lower]`:
 *   - Single / multiple creators (first author wins)
 *   - Missing year → 0000 sentinel
 *   - Missing title → untitled fallback
 *   - Unicode → ASCII (German / French / Spanish / Nordic + NFD decomposition)
 *   - Stop-word skipping (a / the / of / … until a meaningful word)
 *   - Conflict suffixes: a → b → c … aa
 *   - Institutional single-name field
 *   - Completely empty creators → 'anon' fallback
 *   - Mixed stop words + numeric title
 */

import { describe, expect, it } from 'vitest';
import { mintCitationKey } from '../../../src/main/services/zotero/citationKeyMinter';

describe('citationKeyMinter — BBT default formula', () => {
  describe('happy path', () => {
    it('mints smith2024deep for classic {Smith, 2024, "Deep Learning for NLP"}', () => {
      const key = mintCitationKey(
        {
          creators: [{ lastName: 'Smith' }],
          title: 'Deep Learning for NLP',
          year: 2024,
        },
        new Set()
      );
      expect(key).toBe('smith2024deep');
    });

    it('picks FIRST author only (multi-author still yields smith2023...)', () => {
      const key = mintCitationKey(
        {
          creators: [{ lastName: 'Smith' }, { lastName: 'Jones' }, { lastName: 'Lee' }],
          title: 'Distributed Systems',
          year: 2023,
        },
        new Set()
      );
      expect(key).toBe('smith2023distributed');
    });

    it('long title only takes first meaningful word', () => {
      const key = mintCitationKey(
        {
          creators: [{ lastName: 'Chen' }],
          title: 'A Survey of Reinforcement Learning Applications in Robotics',
          year: 2022,
        },
        new Set()
      );
      expect(key).toBe('chen2022survey');
    });
  });

  describe('collision handling', () => {
    it('appends a when base collides once', () => {
      const key = mintCitationKey(
        { creators: [{ lastName: 'Smith' }], title: 'Deep Learning', year: 2024 },
        new Set(['smith2024deep'])
      );
      expect(key).toBe('smith2024deepa');
    });

    it('appends b when a is also taken (plan fixture)', () => {
      const key = mintCitationKey(
        { creators: [{ lastName: 'Smith' }], title: 'Deep Learning', year: 2024 },
        new Set(['smith2024deep', 'smith2024deepa'])
      );
      expect(key).toBe('smith2024deepb');
    });

    it('walks single-letter alphabet fully before double-letter suffix', () => {
      const existing = new Set(['smith2024deep']);
      for (let i = 0; i < 26; i++) {
        existing.add(`smith2024deep${String.fromCharCode(97 + i)}`);
      }
      const key = mintCitationKey(
        { creators: [{ lastName: 'Smith' }], title: 'Deep Learning', year: 2024 },
        existing
      );
      expect(key).toBe('smith2024deepaa');
    });
  });

  describe('fallbacks for missing / degenerate inputs', () => {
    it('missing year → 0000 sentinel', () => {
      const key = mintCitationKey(
        { creators: [{ lastName: 'Smith' }], title: 'Deep Learning' },
        new Set()
      );
      expect(key).toBe('smith0000deep');
    });

    it('missing title → untitled fallback', () => {
      const key = mintCitationKey({ creators: [{ lastName: 'Smith' }], year: 2024 }, new Set());
      expect(key).toBe('smith2024untitled');
    });

    it('empty title string → untitled fallback', () => {
      const key = mintCitationKey(
        { creators: [{ lastName: 'Smith' }], title: '', year: 2024 },
        new Set()
      );
      expect(key).toBe('smith2024untitled');
    });

    it('title consisting only of stop words → untitled fallback', () => {
      const key = mintCitationKey(
        { creators: [{ lastName: 'Smith' }], title: 'The A An Of', year: 2024 },
        new Set()
      );
      expect(key).toBe('smith2024untitled');
    });

    it('missing creators → anon fallback', () => {
      const key = mintCitationKey({ title: 'Deep Learning', year: 2024 }, new Set());
      expect(key).toBe('anon2024deep');
    });

    it('creator with only `name` (institutional) uses name', () => {
      const key = mintCitationKey(
        { creators: [{ name: 'WHO' }], title: 'Pandemic Report', year: 2020 },
        new Set()
      );
      expect(key).toBe('who2020pandemic');
    });

    it('creator with only firstName still contributes', () => {
      const key = mintCitationKey(
        { creators: [{ firstName: 'Aristotle' }], title: 'Physics', year: -350 },
        new Set()
      );
      expect(key).toBe('aristotle-350physics');
    });
  });

  describe('Unicode → ASCII transliteration', () => {
    it('German umlauts use two-letter (ü → ue, ö → oe, ä → ae, ß → ss)', () => {
      const key = mintCitationKey(
        { creators: [{ lastName: 'Müller' }], title: 'Über Machine Learning', year: 2024 },
        new Set()
      );
      expect(key).toBe('mueller2024ueber');
    });

    it('French diacritics → single letter (é → e, ç → c, œ → oe)', () => {
      const key = mintCitationKey(
        { creators: [{ lastName: 'François' }], title: 'Étude sur les réseaux', year: 2021 },
        new Set()
      );
      // "sur" and "les" are NOT in our stop list; test asserts the actual behavior.
      // Étude → etude survives (first non-stop word).
      expect(key).toBe('francois2021etude');
    });

    it('Nordic characters (ø → o, æ → ae, å → a)', () => {
      const key = mintCitationKey(
        { creators: [{ lastName: 'Sørensen' }], title: 'Ærlige studier', year: 2019 },
        new Set()
      );
      expect(key).toBe('sorensen2019aerlige');
    });

    it('NFD-decomposable Vietnamese survives via combining-mark strip', () => {
      const key = mintCitationKey(
        { creators: [{ lastName: 'Nguyễn' }], title: 'Đại số', year: 2020 },
        new Set()
      );
      // ễ → e (NFD strip); Đ → not in map → NFD leaves 'D' base; 'ố' → o.
      // "so" is not a stop word, so it survives.
      expect(key).toBe('nguyen2020dai');
    });

    it('CJK-only creators collapse to anon; CJK-only title collapses to untitled', () => {
      const key = mintCitationKey(
        { creators: [{ lastName: '张' }], title: '深度学习', year: 2024 },
        new Set()
      );
      expect(key).toBe('anon2024untitled');
    });
  });

  describe('title parsing edge cases', () => {
    it('trims punctuation from around words', () => {
      const key = mintCitationKey(
        { creators: [{ lastName: 'Doe' }], title: '"Best" Practices!', year: 2024 },
        new Set()
      );
      expect(key).toBe('doe2024best');
    });

    it('hyphenated first word: keeps only alphanum portion', () => {
      const key = mintCitationKey(
        { creators: [{ lastName: 'Doe' }], title: 'Self-Supervised Learning', year: 2024 },
        new Set()
      );
      // hyphen is preserved as part of the word segment then stripped by alnum filter.
      expect(key).toBe('doe2024selfsupervised');
    });

    it('leading number title survives', () => {
      const key = mintCitationKey(
        { creators: [{ lastName: 'Doe' }], title: '3D Printing at Scale', year: 2024 },
        new Set()
      );
      expect(key).toBe('doe20243d');
    });

    it('caps title word at MAX_TITLE_WORD_LENGTH (20)', () => {
      const key = mintCitationKey(
        {
          creators: [{ lastName: 'Doe' }],
          title: 'Supercalifragilisticexpialidocious Perspectives',
          year: 2024,
        },
        new Set()
      );
      // 34-char first word truncated to 20 → 'supercalifragilistic'
      expect(key).toBe('doe2024supercalifragilistic');
    });
  });
});
