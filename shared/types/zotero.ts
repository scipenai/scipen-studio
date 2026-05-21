/**
 * @file Zotero DTOs — wire types shared between main and renderer
 * @description Settings shape (with API key presence flags, never plaintext) + detection / ping result shapes
 */

export type ZoteroEmbeddingProvider = 'zhipu' | 'aliyun' | 'openai';

/**
 * Zotero settings returned to renderer. Sensitive API keys are NEVER sent
 * over IPC in plaintext — only boolean presence flags are exposed.
 */
export interface ZoteroSettingsDTO {
  /** Filesystem path to the Zotero installation; empty when not yet detected. */
  path: string;
  /** Whether Zotero's Local API at localhost:23119 is enabled (user-confirmed). */
  localApiEnabled: boolean;
  /** Embedding provider for the M3 active-recommendation feature. */
  embeddingProvider: ZoteroEmbeddingProvider;
  /** Master toggle for M3 active citation suggestion panel. */
  activeRecommendation: boolean;
  /** Whether a MinerU API token is stored in OS keychain. */
  hasMinerUApiKey: boolean;
  /** Whether an embedding-provider API key is stored in OS keychain. */
  hasEmbeddingApiKey: boolean;
}

/**
 * Partial update payload for non-sensitive Zotero settings. API keys go
 * through dedicated channels (`Zotero_SetMinerUApiKey` etc.) so they never
 * touch a generic setter.
 */
export type ZoteroSettingsPatchDTO = Partial<
  Pick<
    ZoteroSettingsDTO,
    'path' | 'localApiEnabled' | 'embeddingProvider' | 'activeRecommendation'
  >
>;

/** Result of auto-detecting a local Zotero installation. */
export interface ZoteroDetectionResultDTO {
  found: boolean;
  /** Filesystem path; only present when `found` is true. */
  path?: string;
  /** Zotero version string (e.g., "7.0.15"); only present when found. */
  version?: string;
  /**
   * Whether Better BibTeX (BBT) plugin appears installed (its JSON-RPC
   * endpoint at `localhost:23119/better-bibtex/json-rpc` is reachable).
   * Wizard step 3 uses this to decide whether to surface the BBT install
   * card; missing BBT degrades citation keys to 8-char Zotero itemKeys
   * but does not block the wizard.
   */
  betterBibTexInstalled?: boolean;
}

/** Result of pinging Zotero's Local API at localhost:23119. */
export interface ZoteroPingResultDTO {
  ok: boolean;
  /** Zotero major version (7 | 8); only present when ok. */
  version?: number;
  /** Human-readable error message; only present when !ok. */
  error?: string;
}

/**
 * Minimal projection of a Zotero library item over the wire. We expose
 * only the fields the IDE actually consumes — full Zotero items carry
 * dozens of mostly-empty CSL slots that would bloat IPC payloads and
 * couple us to Zotero schema churn.
 */
export interface ZoteroItemDTO {
  /** Stable 8-char Zotero item identifier (the "itemKey"). */
  itemKey: string;
  /** Item type, e.g. "journalArticle", "book", "preprint". */
  itemType: string;
  title: string;
  /** Concatenated author surnames for quick display ("Smith, Jones, Liu"). */
  creatorsLabel?: string;
  /** Publication year extracted from `date` field (best-effort). */
  year?: number;
  /** Abstract / note used for hover tooltips. */
  abstractNote?: string;
  /**
   * BBT-style citation key when present (Zotero proper does not assign
   * one). Resolved by the index layer, not by the Local API.
   */
  citationKey?: string;
  /** Formatted citation HTML from `?include=citation` (best-effort). */
  citation?: string;
  /** Formatted bibliography entry HTML from `?include=bib` (best-effort). */
  bib?: string;
}

/**
 * Subset of Zotero annotation fields used by the IDE. M2 will wire this
 * into the PDF panel; M1 keeps the type so the LocalApi client surface
 * is complete.
 */
export interface ZoteroAnnotationDTO {
  itemKey: string;
  /** Parent (attachment) item that owns this annotation. */
  parentItemKey: string;
  annotationType: 'highlight' | 'note' | 'image' | 'ink' | string;
  annotationText?: string;
  annotationComment?: string;
  annotationColor?: string;
  annotationPageLabel?: string;
}

export interface ZoteroGetItemsOptionsDTO {
  /** Default 25, max 100 per Zotero API (we cap conservatively at 100). */
  limit?: number;
  /** Pagination offset; pairs with `limit`. */
  start?: number;
}
