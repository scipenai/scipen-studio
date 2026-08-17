/**
 * @file citationKeyMinter — mint human-readable citation keys aligned to BBT
 * @description Web mode has no Better BibTeX to consult; studio mints its own
 *              keys following BBT's default formula:
 *
 *                  [auth:lower][year][veryshorttitle:lower]
 *
 *              e.g. Smith (2024) "Deep Learning for NLP" → `smith2024deep`.
 *
 *              Pure function module — accepts a plain CitationKeyContext,
 *              returns a string. No IO, no globals. CitationKeyStore owns
 *              persistence + collision-history; this file only knows
 *              how to *compute* one key given the current existing-keys set.
 *
 *              This is a subset of BBT — we implement the *default formula*
 *              and the most common corner cases (unicode → ASCII, stop-word
 *              filtering, collision postfixes, missing-year sentinel). Full
 *              BBT feature parity (custom formulas, arbitrary filters,
 *              per-user templates) is intentionally out of scope for stage A.
 *
 * @see https://retorque.re/zotero-better-bibtex/citing/
 */

const MISSING_YEAR_SENTINEL = '0000';

const UNTITLED_FALLBACK = 'untitled';

const MAX_TITLE_WORD_LENGTH = 20;

const MAX_AUTHOR_LENGTH = 40;

/**
 * BBT default "skipStrings" for veryshorttitle — English + Romance stop words
 * that are dropped when picking the first "meaningful" title word. Kept short
 * (13 entries vs BBT's ~30) to bias toward *more* meaningful title tokens; if
 * users report false positives we can extend.
 */
const SKIP_STRINGS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'of',
  'on',
  'in',
  'to',
  'for',
  'with',
  'and',
  'or',
  'but',
  'de',
  'la',
  'le',
]);

/**
 * Latin diacritic → ASCII mapping. We prefer the *two-letter* German
 * transliteration (ü→ue, ö→oe, ä→ae, ß→ss) over the single-letter
 * unidecode convention because it yields more distinctive keys
 * (`mueller2024` vs `muller2024`) and is common in academic BibTeX corpora.
 * If a paper collides due to this choice, BBT-synced keys always win via
 * CitationKeyStore.updateFromBbt.
 */
const DIACRITIC_MAP: Record<string, string> = {
  // German umlauts + ß
  ä: 'ae',
  Ä: 'Ae',
  ö: 'oe',
  Ö: 'Oe',
  ü: 'ue',
  Ü: 'Ue',
  ß: 'ss',
  // Common Romance / Nordic
  à: 'a',
  á: 'a',
  â: 'a',
  ã: 'a',
  å: 'a',
  ç: 'c',
  è: 'e',
  é: 'e',
  ê: 'e',
  ë: 'e',
  ì: 'i',
  í: 'i',
  î: 'i',
  ï: 'i',
  ñ: 'n',
  ò: 'o',
  ó: 'o',
  ô: 'o',
  õ: 'o',
  ø: 'o',
  ù: 'u',
  ú: 'u',
  û: 'u',
  ý: 'y',
  ÿ: 'y',
  À: 'A',
  Á: 'A',
  Â: 'A',
  Ã: 'A',
  Å: 'A',
  Ç: 'C',
  È: 'E',
  É: 'E',
  Ê: 'E',
  Ë: 'E',
  Ì: 'I',
  Í: 'I',
  Î: 'I',
  Ï: 'I',
  Ñ: 'N',
  Ò: 'O',
  Ó: 'O',
  Ô: 'O',
  Õ: 'O',
  Ø: 'O',
  Ù: 'U',
  Ú: 'U',
  Û: 'U',
  Ý: 'Y',
  // Ligatures
  æ: 'ae',
  Æ: 'Ae',
  œ: 'oe',
  Œ: 'Oe',
  // Iberian / Nordic / Polish / Vietnamese
  ð: 'd',
  Ð: 'D',
  đ: 'd',
  Đ: 'D',
  þ: 'th',
  Þ: 'Th',
  ł: 'l',
  Ł: 'L',
};

export interface CitationKeyCreator {
  firstName?: string;
  lastName?: string;
  /** Institutional / single-name creators (e.g. "WHO"). */
  name?: string;
}

/**
 * Minimal input the minter needs. Kept independent of ZoteroItemDTO so the
 * function is trivially unit-testable and can be reused by future stages
 * (imports, manual add flows) without depending on live orchestrator DTOs.
 */
export interface CitationKeyContext {
  /** Author / editor list, in Zotero's `creators` array shape. */
  creators?: CitationKeyCreator[];
  /** Full item title (raw, may contain Unicode / punctuation / stop words). */
  title?: string;
  /** Publication year (numeric); undefined uses MISSING_YEAR_SENTINEL. */
  year?: number;
}

/**
 * Compute the citation key for one item. Purely functional: same input +
 * same `existingKeys` = same output. Never touches disk.
 *
 * Collision policy: base key ("smith2024deep") is checked against
 * `existingKeys`; if taken, append lowercase Latin postfix `a`..`z`, then
 * `aa`..`zz`, until the composed key is unique. Caller is responsible for
 * updating the set after minting (typically the CitationKeyStore.put path).
 */
export function mintCitationKey(ctx: CitationKeyContext, existingKeys: Set<string>): string {
  const auth = firstAuthorSlug(ctx.creators) || 'anon';
  const year =
    ctx.year !== undefined && Number.isFinite(ctx.year) ? String(ctx.year) : MISSING_YEAR_SENTINEL;
  const title = veryShortTitleSlug(ctx.title) || UNTITLED_FALLBACK;
  const base = `${auth}${year}${title}`;
  return dedupe(base, existingKeys);
}

/**
 * Extract the first author's last-name-ish string, transliterate to ASCII,
 * lowercase, strip non-alphanum. Falls back through `name` (institutional) →
 * `firstName` when `lastName` is absent.
 */
function firstAuthorSlug(creators?: CitationKeyCreator[]): string {
  if (!creators || creators.length === 0) return '';
  const raw = pickAuthorLabel(creators[0]);
  return normalizeAuthor(raw);
}

function pickAuthorLabel(c: CitationKeyCreator): string {
  if (c.lastName && c.lastName.length > 0) return c.lastName;
  if (c.name && c.name.length > 0) return c.name;
  if (c.firstName && c.firstName.length > 0) return c.firstName;
  return '';
}

function normalizeAuthor(raw: string): string {
  if (!raw) return '';
  const ascii = transliterate(raw);
  const alnum = ascii.toLowerCase().replace(/[^a-z0-9]/g, '');
  return alnum.slice(0, MAX_AUTHOR_LENGTH);
}

/**
 * BBT-style veryshorttitle: strip punctuation, split on whitespace, drop
 * stop words, take the first surviving word, lowercase + ASCII-clean.
 * Returns '' when no meaningful token survives — caller handles the fallback.
 */
function veryShortTitleSlug(title?: string): string {
  if (!title) return '';
  const cleaned = title.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim();
  if (!cleaned) return '';
  const words = cleaned.split(/\s+/);
  for (const word of words) {
    const asciiLower = transliterate(word).toLowerCase();
    const alnum = asciiLower.replace(/[^a-z0-9]/g, '');
    if (!alnum) continue;
    if (SKIP_STRINGS.has(alnum)) continue;
    return alnum.slice(0, MAX_TITLE_WORD_LENGTH);
  }
  return '';
}

/**
 * Character-level transliteration:
 *   1. Explicit DIACRITIC_MAP for common Latin variants (preferred).
 *   2. Unicode NFD decomposition + strip combining marks for everything else
 *      the map missed (handles e.g. Vietnamese à̀).
 *   3. Non-Latin scripts (CJK / Cyrillic / Arabic) fall through unchanged and
 *      are stripped by the alphanum filter downstream — resulting slug will be
 *      empty and the caller will fall back to 'anon' / 'untitled'.
 */
function transliterate(input: string): string {
  let out = '';
  for (const ch of input) {
    const mapped = DIACRITIC_MAP[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    out += ch;
  }
  // Strip Unicode nonspacing marks (Mn) after NFD decomposition to produce
  // an ASCII-safe key. `\p{Mn}` covers the Combining Diacritical Marks
  // block (U+0300–U+036F) plus other combining marks. A character-class
  // range would trip biome's noMisleadingCharacterClass because the
  // endpoints themselves are combining characters.
  return out.normalize('NFD').replace(/\p{Mn}/gu, '');
}

function dedupe(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  // 'a'..'z' then 'aa'..'zz' — bounded at 702 candidates (26 + 676).
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < alphabet.length; i++) {
    const candidate = `${base}${alphabet[i]}`;
    if (!existing.has(candidate)) return candidate;
  }
  for (let i = 0; i < alphabet.length; i++) {
    for (let j = 0; j < alphabet.length; j++) {
      const candidate = `${base}${alphabet[i]}${alphabet[j]}`;
      if (!existing.has(candidate)) return candidate;
    }
  }
  // Astronomically unlikely (702+ items with identical base key). Prior
  // version used `Date.now()` here — but this function is declared purely
  // functional, and a time-based tail would break determinism (same input +
  // same existingKeys should always produce the same output). Throw instead
  // so callers see the exhaustion explicitly rather than silently emitting
  // a non-reproducible key.
  throw new Error(
    `mintCitationKey exhausted 702 postfix candidates for base "${base}" — library too dense at this key`
  );
}
