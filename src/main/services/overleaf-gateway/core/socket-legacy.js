import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { getLegacySocketIo, getWsModule } from '../deps/node-runtime.js';
import { decodeJoinedRanges, decodeLegacyUtf8 } from './encoding.js';
import { applyOverleafOps, computeGitBlobSha1 } from './op-translator.js';

let patched = false;

function patchLegacySocketIo() {
  if (patched) {
    return getLegacySocketIo();
  }

  const io = getLegacySocketIo();
  const WS = getWsModule();

  io.Socket.prototype.handshake = function handshake(fn) {
    const self = this;
    const options = this.options;
    const extraHeaders = options.extraHeaders || {};
    const scheme = options.secure === false ? 'http:/' : 'https:/';
    const handshakeUrl = [
      scheme,
      `${options.host}:${options.port}`,
      options.resource,
      io.protocol,
      `?t=${Date.now()}`,
    ].join('/');
    const queryStr = options.query || '';
    const fullUrl = queryStr ? `${handshakeUrl}&${queryStr}` : handshakeUrl;
    const parsed = new URL(fullUrl);
    const httpModule = parsed.protocol === 'http:' ? http : https;

    const req = httpModule.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { ...extraHeaders },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            fn.apply(null, body.split(':'));
          } else {
            self.connecting = false;
            self.onError(new Error(`Handshake failed: ${res.statusCode}`));
          }
        });
      }
    );
    req.on('error', (error) => {
      self.connecting = false;
      self.onError(error);
    });
    req.setTimeout(15000, () => req.destroy(new Error('Handshake timeout')));
    req.end();
  };

  io.Transport.websocket.prototype.open = function open() {
    const query = io.util.query(this.socket.options.query);
    const wsOptions = {};
    if (this.socket.options.extraHeaders) {
      wsOptions.headers = this.socket.options.extraHeaders;
    }
    this.websocket = new WS(this.prepareUrl() + query, wsOptions);

    const self = this;
    this.websocket.onopen = function onOpen() {
      self.onOpen();
      self.socket.setBuffer(false);
    };
    this.websocket.onmessage = function onMessage(event) {
      self.onData(event.data);
    };
    this.websocket.onclose = function onClose() {
      self.onClose();
      self.socket.setBuffer(true);
    };
    this.websocket.onerror = function onError(error) {
      self.onError(error);
    };
    return this;
  };

  patched = true;
  return io;
}

export class OverleafSocketAdapter extends EventEmitter {
  constructor({ serverUrl, cookies, projectId }) {
    super();
    this.serverUrl = serverUrl;
    this.cookies = cookies;
    this.projectId = projectId;
    this.socket = null;
    this.connected = false;
    this.protocolVersion = null;
    this.project = null;
  }

  async connect() {
    const io = patchLegacySocketIo();
    const origin = new URL(this.serverUrl).origin;

    const attemptV2 = () =>
      new Promise((resolve, reject) => {
        const queryUrl = `${origin}?projectId=${this.projectId}&t=${Date.now()}`;
        const socket = io.connect(queryUrl, {
          reconnect: false,
          'force new connection': true,
          extraHeaders: {
            Cookie: this.cookies,
            Origin: origin,
          },
        });

        const cleanup = () => {
          clearTimeout(timeout);
        };
        const timeout = setTimeout(() => {
          socket.disconnect();
          reject(new Error('Overleaf connection timeout'));
        }, 15000);

        socket.on('joinProjectResponse', (data) => {
          cleanup();
          resolve({ socket, data, protocolVersion: data?.protocolVersion ?? 2 });
        });

        socket.on('connectionAccepted', (_unused, publicId) => {
          socket.emit('joinProject', { project_id: this.projectId }, (err, project, permissionsLevel, protocolVersion) => {
            cleanup();
            if (err) {
              socket.disconnect();
              reject(new Error(err.message || String(err)));
              return;
            }
            resolve({
              socket,
              data: { publicId, project, permissionsLevel, protocolVersion },
              protocolVersion: protocolVersion ?? 1,
            });
          });
        });

        socket.on('connectionRejected', (error) => {
          cleanup();
          socket.disconnect();
          reject(new Error(error?.message || 'Connection rejected'));
        });
        socket.on('connect_failed', () => {
          cleanup();
          socket.disconnect();
          reject(new Error('Socket connect failed'));
        });
        socket.on('error', (error) => {
          cleanup();
          socket.disconnect();
          reject(new Error(error?.message || 'Socket error'));
        });
      });

    const { socket, data, protocolVersion } = await attemptV2();
    this.socket = socket;
    this.connected = true;
    this.protocolVersion = protocolVersion;
    this.project = data?.project ?? null;
    this._setupEventHandlers();

    return {
      project: this.project,
      protocolVersion: this.protocolVersion,
    };
  }

  async emitAsync(event, ...args) {
    if (!this.socket) {
      throw new Error('Socket is not connected');
    }

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${event} timeout`)), 10000);
      this.socket.emit(event, ...args, (err, ...data) => {
        clearTimeout(timeout);
        if (err) {
          reject(new Error(err.message || String(err)));
        } else {
          resolve(data);
        }
      });
    });
  }

  async joinDoc(docId, fromVersion = -1) {
    const data = await this.emitAsync('joinDoc', docId, fromVersion, { encodeRanges: true });
    const [docLines, version, _updates, ranges] = data;
    const lines = (docLines || []).map((line) => decodeLegacyUtf8(line));
    const decodedRanges = decodeJoinedRanges(ranges);

    return {
      lines,
      content: lines.join('\n'),
      version: Number(version ?? 0),
      ranges: decodedRanges ?? {},
    };
  }

  async applyOtUpdate(docId, op, version, content) {
    const newContent = applyOverleafOps(content, op);
    const update = {
      doc: docId,
      op,
      v: version,
      lastV: version,
      hash: computeGitBlobSha1(newContent),
    };
    await this.emitAsync('applyOtUpdate', docId, update);
    return { hash: update.hash, content: newContent };
  }

  async applyCustomUpdate(docId, update) {
    await this.emitAsync('applyOtUpdate', docId, update);
    return {};
  }

  disconnect() {
    if (this.socket) {
      try {
        this.socket.disconnect();
      } catch {
      }
    }
    this.socket = null;
    this.connected = false;
  }

  _setupEventHandlers() {
    if (!this.socket) {
      return;
    }

    this.socket.on('disconnect', (reason) => {
      this.connected = false;
      this.emit('disconnect', { reason: reason || 'unknown' });
    });
    this.socket.on('otUpdateApplied', (update) => {
      this.emit('otUpdateApplied', update);
    });
    this.socket.on('otUpdateError', (data) => {
      this.emit('otUpdateError', data);
    });
    this.socket.on('reciveNewDoc', (parentFolderId, doc, meta) => {
      this.emit('tree.changed', { type: 'doc.created', parentFolderId, doc, meta });
    });
    this.socket.on('reciveNewFile', (parentFolderId, file, meta) => {
      this.emit('tree.changed', { type: 'file.created', parentFolderId, file, meta });
    });
    this.socket.on('reciveNewFolder', (parentFolderId, folder, meta) => {
      this.emit('tree.changed', { type: 'folder.created', parentFolderId, folder, meta });
    });
    this.socket.on('reciveEntityRename', (entityId, newName) => {
      this.emit('tree.changed', { type: 'entity.renamed', entityId, newName });
    });
    this.socket.on('reciveEntityMove', (entityId, newFolderId) => {
      this.emit('tree.changed', { type: 'entity.moved', entityId, newFolderId });
    });
    this.socket.on('removeEntity', (entityId) => {
      this.emit('tree.changed', { type: 'entity.removed', entityId });
    });
    this.socket.on('new-comment', (threadId, comment) => {
      this.emit('thread.changed', { type: 'thread.created', threadId, comment });
    });
    this.socket.on('resolve-thread', (threadId, user) => {
      this.emit('thread.changed', { type: 'thread.resolved', threadId, user });
    });
    this.socket.on('reopen-thread', (threadId) => {
      this.emit('thread.changed', { type: 'thread.reopened', threadId });
    });
    this.socket.on('delete-thread', (threadId) => {
      this.emit('thread.changed', { type: 'thread.deleted', threadId });
    });
  }
}
