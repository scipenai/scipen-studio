/**
 * @file OverleafAuthService — Overleaf authentication service (sole owner of cookies).
 * @description Handles login, cookie persistence, CSRF token retrieval, and expiry detection.
 *   Cookies stay inside the main process; renderer can at most observe isLoggedIn via IPC.
 */

import { createLogger } from './LoggerService';
import { setOverleafCookies, deleteOverleafCookies } from './SecureStorageService';

const logger = createLogger('OverleafAuthService');

/** Auth state. */
export interface OverleafAuthState {
  csrfToken: string;
  cookies: string;
  userId?: string;
  serverUrl: string;
}

/** Merge cookies from a set-cookie header into the existing jar. */
function mergeCookieStrings(base: string, setCookieHeader: string | null): string {
  const jar = new Map<string, string>();

  const addCookie = (pair: string) => {
    const [name, ...rest] = pair.split('=');
    if (!name || rest.length === 0) return;
    jar.set(name.trim(), rest.join('=').trim());
  };

  for (const fragment of (base || '').split(';')) {
    const pair = fragment.trim();
    if (pair) addCookie(pair);
  }

  for (const header of [setCookieHeader].filter(Boolean) as string[]) {
    for (const item of String(header).split(/,(?=[^;]+=[^;]+)/)) {
      const pair = item.split(';')[0]?.trim();
      if (pair) addCookie(pair);
    }
  }

  return Array.from(jar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function syncEmbeddedGatewayBotEnv(state: OverleafAuthState | null): void {
  if (!state) {
    process.env.OVERLEAF_BOT_COOKIE = undefined;
    process.env.OVERLEAF_URL = undefined;
    return;
  }

  // Studio's embedded Overleaf Gateway shares the main process. OpenClaw's
  // overleaf_collaborative_edit connects with sessionType=bot, and SessionManager only reads
  // auth from OVERLEAF_BOT_COOKIE / OVERLEAF_URL. Without syncing the current login here, the
  // host survives but bot sessions fail permanently with "Missing Overleaf cookies".
  process.env.OVERLEAF_BOT_COOKIE = state.cookies;
  process.env.OVERLEAF_URL = state.serverUrl;
}

export class OverleafAuthService {
  private state: OverleafAuthState | null = null;

  // ====== Public API ======

  /**
   * Log in to Overleaf using either email+password or existing cookies.
   */
  async login(config: {
    serverUrl: string;
    email?: string;
    password?: string;
    cookies?: string;
  }): Promise<{ success: boolean; message: string; userId?: string }> {
    const serverUrl = config.serverUrl.replace(/\/+$/, '');

    if (config.cookies) {
      return this.loginWithCookies(serverUrl, config.cookies);
    }

    if (!config.email || !config.password) {
      return { success: false, message: 'Please provide email/password or Cookies' };
    }

    try {
      const identity = await this.fetchCsrfToken(serverUrl);

      const response = await fetch(`${serverUrl}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Cookie: identity.cookies,
          'X-Csrf-Token': identity.csrfToken,
        },
        body: JSON.stringify({
          _csrf: identity.csrfToken,
          email: config.email,
          password: config.password,
        }),
      });

      if (response.status === 302) {
        const location = response.headers.get('location');
        if (location?.includes('/project')) {
          const newCookies = mergeCookieStrings(
            identity.cookies,
            response.headers.get('set-cookie')
          );
          return this.loginWithCookies(serverUrl, newCookies);
        }
      }

      interface LoginErrorResponse {
        message?: { message?: string; text?: string } | string;
      }
      const result = (await response.json()) as LoginErrorResponse;
      const msg =
        typeof result.message === 'object'
          ? result.message?.message || result.message?.text
          : result.message;
      return { success: false, message: msg || 'Login failed' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Login failed',
      };
    }
  }

  /** Test Overleaf server reachability. */
  async testConnection(serverUrl: string): Promise<{ success: boolean; message: string }> {
    try {
      const response = await fetch(`${serverUrl.replace(/\/+$/, '')}/login`, {
        method: 'GET',
        redirect: 'manual',
      });
      if (response.ok || response.status === 302) {
        return { success: true, message: `Successfully connected to ${serverUrl}` };
      }
      return { success: false, message: `Server returned status code: ${response.status}` };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  isLoggedIn(): boolean {
    return this.state !== null;
  }

  /** Main-process only: return current cookies (never exposed to renderer). */
  getCookies(): string | null {
    return this.state?.cookies ?? null;
  }

  getCsrfToken(): string | null {
    return this.state?.csrfToken ?? null;
  }

  getServerUrl(): string | null {
    return this.state?.serverUrl ?? null;
  }

  getUserId(): string | null {
    return this.state?.userId ?? null;
  }

  /** Headers other services inject to authenticate HTTP calls. */
  getAuthHeaders(): { Cookie: string; 'X-Csrf-Token': string } | null {
    if (!this.state) return null;
    return {
      Cookie: this.state.cookies,
      'X-Csrf-Token': this.state.csrfToken,
    };
  }

  /** Merge set-cookie headers from an HTTP response into the cookie jar. */
  absorbResponseCookies(response: Response): void {
    if (!this.state) return;
    const merged = mergeCookieStrings(this.state.cookies, response.headers.get('set-cookie'));
    if (merged && merged !== this.state.cookies) {
      this.state = { ...this.state, cookies: merged };
      setOverleafCookies(merged);
      syncEmbeddedGatewayBotEnv(this.state);
      logger.info('Cookies updated from HTTP response');
    }
  }

  logout(): void {
    this.state = null;
    deleteOverleafCookies();
    syncEmbeddedGatewayBotEnv(null);
    logger.info('Logged out, secure storage cleared');
  }

  // ====== Internals ======

  /** Fetch CSRF token by parsing HTTP GET /login. */
  private async fetchCsrfToken(serverUrl: string): Promise<{ csrfToken: string; cookies: string }> {
    const response = await fetch(`${serverUrl}/login`, {
      method: 'GET',
      redirect: 'manual',
    });

    const body = await response.text();
    const match = body.match(/<input.*name="_csrf".*value="([^"]*)">/);
    if (!match) {
      throw new Error('Failed to get CSRF Token');
    }

    return {
      csrfToken: match[1],
      cookies: mergeCookieStrings('', response.headers.get('set-cookie')),
    };
  }

  /** Validate login state using cookies. */
  private async loginWithCookies(
    serverUrl: string,
    cookies: string
  ): Promise<{ success: boolean; message: string; userId?: string }> {
    try {
      const response = await fetch(`${serverUrl}/project`, {
        method: 'GET',
        redirect: 'manual',
        headers: { Cookie: cookies },
      });

      const body = await response.text();
      const userIdMatch = body.match(/<meta\s+name="ol-user_id"\s+content="([^"]*)">/);
      const csrfTokenMatch = body.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]*)">/);

      if (userIdMatch && csrfTokenMatch) {
        const mergedCookies = mergeCookieStrings(cookies, response.headers.get('set-cookie'));
        this.state = {
          csrfToken: csrfTokenMatch[1],
          cookies: mergedCookies,
          userId: userIdMatch[1],
          serverUrl,
        };
        setOverleafCookies(mergedCookies);
        syncEmbeddedGatewayBotEnv(this.state);
        logger.info(`Login successful: userId=${userIdMatch[1]}`);
        return { success: true, message: 'Login successful', userId: userIdMatch[1] };
      }

      return { success: false, message: 'Cookies invalid or expired' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to verify Cookies',
      };
    }
  }
}
