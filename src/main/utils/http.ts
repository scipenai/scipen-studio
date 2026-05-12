/**
 * @file HTTP utility — fetch wrapper with timeout and retry.
 * @description Shared by services such as OverleafProjectMetaService.
 */

export interface FetchRetryConfig {
  /** Timeout in milliseconds. Default 8000 (lowered from 30000 so a single hung connection doesn't stall startup). */
  timeout?: number;
  /** Maximum number of retries. Default 1 (lowered from 2). */
  maxRetries?: number;
  /** Base retry delay in milliseconds. Default 1000. */
  retryDelay?: number;
  /** Retry only on these HTTP status codes. Default [502, 503, 504]. */
  retryOn?: number[];
}

/**
 * fetch with timeout and retry.
 * - Timeout enforced via AbortController.
 * - Auto-retries only on gateway errors (502/503/504).
 * - Retry delay grows linearly (delay * attempt).
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  config: FetchRetryConfig = {}
): Promise<Response> {
  const { timeout = 8000, maxRetries = 1, retryDelay = 1000, retryOn = [502, 503, 504] } = config;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (retryOn.includes(response.status) && attempt < maxRetries) {
        console.warn(
          `[fetchWithRetry] HTTP ${response.status}, retry ${attempt + 1}/${maxRetries}...`
        );
        await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
        continue;
      }

      return response;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        lastError = new Error(`Request timeout (${timeout}ms): ${url}`);
      } else {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      if (attempt < maxRetries) {
        console.warn(
          `[fetchWithRetry] Request failed, retry ${attempt + 1}/${maxRetries}...`,
          lastError.message
        );
        await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error(`Request failed: ${url}`);
}
