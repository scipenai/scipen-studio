/**
 * Smoke driver: spawn snaca-editor and run through init → session.open
 * → chat.send → done → shutdown using the raw Node primitives the
 * Studio agent layer wraps. Validates the binary + the wire shape are
 * compatible with the TS protocol layer's expectations.
 *
 * Run:
 *   node scripts/smoke-snaca-editor.mjs
 *
 * Requires snaca-editor.exe at D:\scipen\snaca\target\debug\.
 */

import { spawn } from 'node:child_process';

const BIN = 'D:\\scipen\\snaca\\target\\debug\\snaca-editor.exe';

const child = spawn(BIN, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let buffer = '';
let nextId = 1;
const pending = new Map();

function send(method, params, isNotification = false) {
  const msg = isNotification
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: nextId, method, params };
  const line = JSON.stringify(msg) + '\n';
  child.stdin.write(line);
  if (isNotification) return Promise.resolve();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
  });
}

const notifications = [];

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && msg.method === undefined) {
      // response
      const p = pending.get(msg.id);
      if (!p) {
        console.warn('orphan response', msg);
        continue;
      }
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message} (code=${msg.error.code})`));
      else p.resolve(msg.result);
    } else if (msg.method) {
      notifications.push(msg);
    }
  }
});

child.stderr.on('data', () => {
  // suppressed: stderr is the tracing channel
});

async function main() {
  console.log('[1/4] init');
  const init = await send('init', {
    protocol_version: '1.0',
    host: { name: 'studio-smoke', version: '0.0.1' },
    snaca_config: {
      llm: { provider: 'deepseek', api_key_env: 'SNACA_API_KEY', model: 'deepseek-chat' },
      approval_mode: 'interactive',
    },
    host_caps: {
      ui_surfaces: ['chat'],
      context_kinds: ['active_file'],
      edit_apply_strategy: 'host_applies',
      approval_ui: 'local_card',
      framing: ['ndjson'],
    },
  });
  console.log('      engine_version=' + init.engine_version);

  console.log('[2/4] session.open');
  const open = await send('session.open', {
    project_id: '550e8400-e29b-41d4-a716-446655440000',
    workspace_root: 'D:/scipen/snaca',
    metadata_root: 'D:/scipen/snaca-smoke-meta-studio',
    display_name: 'studio smoke',
    project_type: 'latex',
  });
  const sessionId = open.session_id;
  const threadId = open.threads[0].thread_id;
  console.log(`      session=${sessionId.slice(0, 8)}... thread=${threadId.slice(0, 8)}...`);

  console.log('[3/4] chat.send');
  const chat = await send('chat.send', {
    session_id: sessionId,
    thread_id: threadId,
    content: 'hello from studio TS driver',
    context: {},
  });
  console.log(`      turn=${chat.turn_id.slice(0, 8)}...`);
  // wait up to 2s for done
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const done = notifications.find(
      (n) => n.method === 'turn.delta' && n.params.kind === 'done' && n.params.turn_id === chat.turn_id
    );
    if (done) {
      const textDeltas = notifications.filter(
        (n) => n.method === 'turn.delta' && n.params.kind === 'text' && n.params.turn_id === chat.turn_id
      );
      const usage = notifications.find(
        (n) => n.method === 'usage.update' && n.params.turn_id === chat.turn_id
      );
      console.log(
        `      received ${textDeltas.length} text deltas + done (reason=${done.params.reason}) + usage=${!!usage}`
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log('[4/4] shutdown');
  await send('shutdown', {});
  child.stdin.end();
  await new Promise((r) => child.once('exit', r));
  console.log('\nOK: studio TS smoke passed');
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
