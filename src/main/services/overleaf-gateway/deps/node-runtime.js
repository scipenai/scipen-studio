import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function getLegacySocketIo() {
  return require('socket.io-client');
}

export function getWsModule() {
  return require('ws');
}
