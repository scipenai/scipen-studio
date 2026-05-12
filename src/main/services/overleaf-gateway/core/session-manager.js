import crypto from 'node:crypto';
import { OverleafSocketAdapter } from './socket-legacy.js';

function mergeCookieStrings(base, setCookieHeader) {
  const jar = new Map();

  const addCookie = (pair) => {
    const [name, ...rest] = pair.split('=');
    if (!name || rest.length === 0) {
      return;
    }
    jar.set(name.trim(), rest.join('=').trim());
  };

  for (const fragment of (base || '').split(';')) {
    const pair = fragment.trim();
    if (pair) {
      addCookie(pair);
    }
  }

  const rawSetCookie = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader].filter(Boolean);
  for (const header of rawSetCookie) {
    for (const item of String(header).split(/,(?=[^;]+=[^;]+)/)) {
      const pair = item.split(';')[0]?.trim();
      if (pair) {
        addCookie(pair);
      }
    }
  }

  return Array.from(jar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

async function fetchProjectContext({ serverUrl, projectId, cookies }) {
  const url = `${serverUrl.replace(/\/+$/, '')}/project/${projectId}`;
  const response = await fetch(url, {
    headers: {
      Cookie: cookies,
      Origin: new URL(serverUrl).origin,
    },
  });

  const body = await response.text();
  const csrfMatch = body.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]+)"/i);
  const mergedCookies = mergeCookieStrings(cookies, response.headers.get('set-cookie'));

  return {
    cookies: mergedCookies,
    csrfToken: csrfMatch?.[1] ?? null,
  };
}

async function warmupSocketCookies({ serverUrl, cookies }) {
  const url = `${serverUrl.replace(/\/+$/, '')}/socket.io/socket.io.js`;
  const response = await fetch(url, {
    headers: {
      Cookie: cookies,
      Origin: new URL(serverUrl).origin,
    },
  });

  return mergeCookieStrings(cookies, response.headers.get('set-cookie'));
}

const TRANSIENT_ERROR_TOKENS = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'socket hang up',
  'fetch failed',
  'Handshake timeout',
  'Overleaf connection timeout',
  'Socket connect failed',
];

function isTransientConnectError(error) {
  const msg = String(error?.message || error);
  return TRANSIENT_ERROR_TOKENS.some(token => msg.includes(token));
}

async function retryTransient(fn, { maxRetries = 3, baseDelay = 2000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && isTransientConnectError(error)) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export class SessionManager {
  constructor({ onRemoteUpdate, onTreeEvent, onThreadEvent, onDisconnect, adapterFactory }) {
    this.sessions = new Map();
    this.onRemoteUpdate = onRemoteUpdate;
    this.onTreeEvent = onTreeEvent;
    this.onThreadEvent = onThreadEvent;
    this.onDisconnect = onDisconnect;
    this.adapterFactory =
      adapterFactory ??
      ((options) => new OverleafSocketAdapter(options));
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) ?? null;
  }

  async connectSession({ sessionType = 'user', serverUrl, projectId, cookies, clientInstanceId }) {
    const resolvedCookies = sessionType === 'bot'
      ? process.env.OVERLEAF_BOT_COOKIE?.trim()
      : String(cookies || '').trim();
    const resolvedServerUrl = sessionType === 'bot'
      ? process.env.OVERLEAF_URL?.trim() || serverUrl
      : serverUrl;

    if (!resolvedServerUrl) {
      throw new Error('Missing Overleaf server URL');
    }
    if (!projectId) {
      throw new Error('Missing Overleaf project ID');
    }
    if (!resolvedCookies) {
      throw new Error(`Missing Overleaf cookies for session type ${sessionType}`);
    }

    const { projectContext, warmedCookies, adapter, connection } = await retryTransient(async (attempt) => {
      if (attempt > 1) {
        console.log(`[SessionManager] connectSession retry attempt ${attempt} for project ${projectId}`);
      }

      const ctx = await fetchProjectContext({
        serverUrl: resolvedServerUrl,
        projectId,
        cookies: resolvedCookies,
      });

      const warmed = await warmupSocketCookies({
        serverUrl: resolvedServerUrl,
        cookies: ctx.cookies,
      });

      const adp = this.adapterFactory({
        serverUrl: resolvedServerUrl,
        cookies: warmed,
        projectId,
      });
      try {
        const conn = await adp.connect();
        return { projectContext: ctx, warmedCookies: warmed, adapter: adp, connection: conn };
      } catch (connectError) {
        adp.disconnect();
        throw connectError;
      }
    });

    const sessionId = crypto.randomUUID();
    const session = {
      sessionId,
      sessionType,
      serverUrl: resolvedServerUrl,
      projectId,
      clientInstanceId: clientInstanceId || null,
      cookies: warmedCookies,
      csrfToken: projectContext.csrfToken,
      protocolVersion: connection.protocolVersion ?? null,
      adapter,
      project: connection.project ?? null,
    };

    adapter.on('otUpdateApplied', (update) => this.onRemoteUpdate(session, update));
    adapter.on('tree.changed', (event) => this.onTreeEvent(session, event));
    adapter.on('thread.changed', (event) => this.onThreadEvent(session, event));
    adapter.on('disconnect', (event) => this.onDisconnect(session, event));

    this.sessions.set(sessionId, session);
    return session;
  }

  disconnectSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }
    session.adapter.disconnect();
    this.sessions.delete(sessionId);
  }

  removeSession(sessionId) {
    this.sessions.delete(sessionId);
  }
}

export { fetchProjectContext, mergeCookieStrings, warmupSocketCookies, isTransientConnectError, retryTransient };
