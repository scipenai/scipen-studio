import { applyOverleafOps, computeGitBlobSha1, offsetPatchesToOverleafOps, overleafOpsToOffsetPatches } from './op-translator.js';
import { transformRanges } from './range-manager.js';

export class DocumentStateManager {
  constructor() {
    this.states = new Map();
    this.requestCache = new Map();
    this.maxRememberedRequestsPerSession = 200;
  }

  getStateKey(sessionId, docId) {
    return `${sessionId}:${docId}`;
  }

  setJoinedState(sessionId, docId, snapshot) {
    const key = this.getStateKey(sessionId, docId);
    const state = {
      docId,
      sessionId,
      version: Number(snapshot.version ?? 0),
      serverContent: String(snapshot.content ?? ''),
      inflightOp: null,
      ranges: snapshot.ranges ?? {},
      joinEpoch: Number(snapshot.joinEpoch ?? Date.now()),
      connected: true,
      hash: computeGitBlobSha1(String(snapshot.content ?? '')),
    };
    this.states.set(key, state);
    return state;
  }

  getState(sessionId, docId) {
    return this.states.get(this.getStateKey(sessionId, docId)) ?? null;
  }

  ensureState(sessionId, docId) {
    const state = this.getState(sessionId, docId);
    if (!state) {
      throw new Error(`Document state not found for session=${sessionId}, doc=${docId}`);
    }
    return state;
  }

  rememberRequest(sessionId, requestId, result) {
    if (!requestId) {
      return;
    }
    const cacheKey = `${sessionId}:${requestId}`;
    this.requestCache.set(cacheKey, {
      result,
      recordedAt: Date.now(),
    });

    const sessionEntries = Array.from(this.requestCache.keys()).filter((key) => key.startsWith(`${sessionId}:`));
    if (sessionEntries.length <= this.maxRememberedRequestsPerSession) {
      return;
    }

    sessionEntries
      .sort((left, right) => (this.requestCache.get(left)?.recordedAt ?? 0) - (this.requestCache.get(right)?.recordedAt ?? 0))
      .slice(0, sessionEntries.length - this.maxRememberedRequestsPerSession)
      .forEach((key) => {
        this.requestCache.delete(key);
      });
  }

  getRememberedRequest(sessionId, requestId) {
    if (!requestId) {
      return null;
    }
    const cacheKey = `${sessionId}:${requestId}`;
    const cached = this.requestCache.get(cacheKey) ?? null;
    if (!cached) {
      return null;
    }
    if (Date.now() - cached.recordedAt > 5 * 60 * 1000) {
      this.requestCache.delete(cacheKey);
      return null;
    }
    return cached.result;
  }

  listDocIds(sessionId) {
    return Array.from(this.states.values())
      .filter((state) => state.sessionId === sessionId)
      .map((state) => state.docId);
  }

  prepareLocalUpdate(sessionId, docId, baseVersion, patches) {
    const state = this.ensureState(sessionId, docId);
    if (state.inflightOp) {
      throw new Error('Document already has an inflight update');
    }
    if (Number(baseVersion) !== state.version) {
      const error = new Error(`Stale version: expected ${state.version}, got ${baseVersion}`);
      error.code = 'STALE_VERSION';
      throw error;
    }

    const ops = offsetPatchesToOverleafOps(state.serverContent, patches);
    if (ops.length === 0) {
      return {
        version: state.version,
        content: state.serverContent,
        patches: [],
        ranges: state.ranges,
      };
    }

    state.inflightOp = ops;
    const nextContent = applyOverleafOps(state.serverContent, ops);
    const nextRanges = transformRanges(state.ranges, ops);

    return {
      state,
      ops,
      nextContent,
      nextRanges,
      hash: computeGitBlobSha1(nextContent),
    };
  }

  acknowledgeLocalUpdate(sessionId, docId, prepared) {
    const state = this.ensureState(sessionId, docId);
    state.serverContent = prepared.nextContent;
    state.version += 1;
    state.hash = prepared.hash;
    state.ranges = prepared.nextRanges;
    state.inflightOp = null;

    return {
      docId,
      sessionId,
      version: state.version,
      content: state.serverContent,
      ranges: state.ranges,
      patches: overleafOpsToOffsetPatches(prepared.ops),
    };
  }

  failLocalUpdate(sessionId, docId) {
    const state = this.ensureState(sessionId, docId);
    state.inflightOp = null;
  }

  applyRemoteUpdate(sessionId, docId, update) {
    const state = this.getState(sessionId, docId);
    if (!state) {
      return null;
    }
    const ops = Array.isArray(update?.op) ? update.op : [];
    if (ops.length === 0) {
      return null;
    }

    state.serverContent = applyOverleafOps(state.serverContent, ops);
    state.version = Math.max(state.version, Number(update?.v ?? state.version) + 1);
    state.hash = computeGitBlobSha1(state.serverContent);
    state.ranges = transformRanges(state.ranges, ops);

    return {
      docId,
      sessionId,
      version: state.version,
      content: state.serverContent,
      ranges: state.ranges,
      patches: overleafOpsToOffsetPatches(ops),
      source: update?.meta?.source ?? null,
    };
  }

  markDisconnected(sessionId) {
    for (const state of this.states.values()) {
      if (state.sessionId === sessionId) {
        state.connected = false;
      }
    }
  }

  releaseSession(sessionId) {
    for (const key of Array.from(this.states.keys())) {
      if (key.startsWith(`${sessionId}:`)) {
        this.states.delete(key);
      }
    }
    for (const key of Array.from(this.requestCache.keys())) {
      if (key.startsWith(`${sessionId}:`)) {
        this.requestCache.delete(key);
      }
    }
  }
}
