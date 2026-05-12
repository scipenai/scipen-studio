/**
 * @file api.ts - API endpoint constants
 * @description Defines API endpoint addresses for external services such as OpenAI, Overleaf, and Ollama
 */

/** OpenAI API base URL */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Overleaf server URL */
export const OVERLEAF_SERVER_URL = 'https://www.overleaf.com';

/** Ollama local service default URL */
export const OLLAMA_LOCAL_URL = 'http://localhost:11434';

/** API endpoint collection */
export const API_ENDPOINTS = {
  OPENAI: OPENAI_BASE_URL,
  OVERLEAF: OVERLEAF_SERVER_URL,
  OLLAMA: OLLAMA_LOCAL_URL,
} as const;
