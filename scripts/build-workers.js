/**
 * @file build-workers.js - Worker threads and utility process build script
 * @description Builds worker thread files and utility processes using esbuild. Required because
 *              electron-vite doesn't natively support multiple entry points for workers.
 * @depends esbuild, path, url, fs
 */

import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

// ====== Paths ======
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const workersOutDir = resolve(rootDir, 'out/main/workers');
const lspProcessOutDir = resolve(rootDir, 'out/main/lsp-process');

for (const dir of [workersOutDir, lspProcessOutDir]) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ====== Worker Threads Configuration ======
const workers = [
  {
    entry: resolve(rootDir, 'src/main/workers/vectorSearch.worker.ts'),
    // Use .cjs extension because package.json has "type": "module"
    // and worker files use CommonJS format for native module compatibility
    outfile: resolve(workersOutDir, 'vectorSearch.worker.cjs'),
    external: ['better-sqlite3', 'hnswlib-node']
  },
  {
    entry: resolve(rootDir, 'src/main/workers/sqlite.worker.ts'),
    outfile: resolve(workersOutDir, 'sqlite.worker.cjs'),
    external: ['better-sqlite3']
  },
  {
    entry: resolve(rootDir, 'src/main/workers/compile.worker.ts'),
    outfile: resolve(workersOutDir, 'compile.worker.cjs'),
    external: []
  },
  {
    entry: resolve(rootDir, 'src/main/workers/pdf.worker.ts'),
    outfile: resolve(workersOutDir, 'pdf.worker.cjs'),
    external: []
  },
  {
    entry: resolve(rootDir, 'src/main/workers/file.worker.ts'),
    // Externalize native modules that can't be bundled
    outfile: resolve(workersOutDir, 'file.worker.cjs'),
    external: ['@parcel/watcher', 'chokidar', 'fsevents']
  },
  {
    entry: resolve(rootDir, 'src/main/workers/logParser.worker.ts'),
    outfile: resolve(workersOutDir, 'logParser.worker.cjs'),
    external: []
  }
];

// ====== Utility Process Configuration ======
const utilityProcesses = [
  {
    name: 'LSP Process',
    entry: resolve(rootDir, 'src/main/lsp-process/index.ts'),
    // UtilityProcess requires .cjs format for Electron module system compatibility
    outfile: resolve(lspProcessOutDir, 'index.cjs'),
    // Externalize Electron modules and native dependencies that may be imported dynamically
    external: ['electron', 'better-sqlite3', 'hnswlib-node']
  }
];

// ====== Build Functions ======
async function buildWorkers() {
  console.log('[build-workers] Building worker files...');
  
  for (const worker of workers) {
    try {
      await build({
        entryPoints: [worker.entry],
        outfile: worker.outfile,
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        external: worker.external,
        minify: process.env.NODE_ENV === 'production',
        sourcemap: process.env.NODE_ENV !== 'production',
        logLevel: 'info'
      });
      console.log(`[build-workers] Built: ${worker.outfile}`);
    } catch (error) {
      console.error(`[build-workers] Failed to build ${worker.entry}:`, error);
      process.exit(1);
    }
  }
  
  console.log('[build-workers] All workers built successfully.');
}

async function buildUtilityProcesses() {
  console.log('[build-workers] Building UtilityProcess files...');
  
  for (const proc of utilityProcesses) {
    try {
      await build({
        entryPoints: [proc.entry],
        outfile: proc.outfile,
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        external: proc.external,
        minify: process.env.NODE_ENV === 'production',
        sourcemap: process.env.NODE_ENV !== 'production',
        logLevel: 'info',
        // Define process.type so code can detect it's running in a utility process
        define: {
          'process.type': '"utility"'
        }
      });
      console.log(`[build-workers] Built ${proc.name}: ${proc.outfile}`);
    } catch (error) {
      console.error(`[build-workers] Failed to build ${proc.name}:`, error);
      process.exit(1);
    }
  }
  
  console.log('[build-workers] All UtilityProcess files built successfully.');
}

// ====== Main ======
async function main() {
  await buildWorkers();
  await buildUtilityProcesses();
  console.log('[build-workers] All builds completed successfully.');
}

main();

