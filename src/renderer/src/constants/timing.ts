/**
 * @file timing.ts - Timeout and delay constants
 * @description Defines timeout constants for various operations such as AI requests, LSP operations, and debouncing
 */

/** Timeout duration (milliseconds) */
export const TIMEOUTS = {
  /** AI request timeout */
  AI: 30000,
  /** VLM (Vision Language Model) request timeout */
  VLM: 60000,
  /** Whisper speech transcription timeout */
  WHISPER: 120000,
  /** Embedding request timeout */
  EMBEDDING: 30000,
  /** TexLab LSP timeout */
  TEXLAB: 5000,
  /** File operation timeout */
  FILE_OPERATION: 30000,
  /** AutoRAG search timeout (seconds) */
  AUTORAG_SEARCH: 30,
} as const;

/** Delay duration (milliseconds) */
export const DELAYS = {
  /** Auto-save delay */
  AUTO_SAVE: 1000,
  /** Auto-compile delay */
  AUTO_COMPILE: 3000,
  /** AI completion trigger delay */
  AI_TRIGGER: 500,
  /** Retry delay */
  RETRY: 1000,
  /** Error recovery delay */
  RECOVERY: 5000,
  /** Default debounce delay */
  DEBOUNCE: 500,
  /** File write stability threshold */
  FILE_WRITE_STABLE: 300,
  /** File polling interval */
  FILE_POLL: 100,
  /** File watch interval */
  FILE_WATCH: 500,
  /** Overleaf update debounce */
  OVERLEAF_UPDATE: 500,
} as const;

/** Retry configuration */
export const RETRY_CONFIG = {
  /** Maximum retry count */
  MAX_RETRIES: 3,
} as const;
