import * as esbuild from 'esbuild';
import * as fs from 'fs';

console.log(`📦 Building scipen-pdf2tex...`);

// esbuild 打包
await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'dist/index.js',
  format: 'cjs',
  // 只保留必须 external 的原生模块
  external: [
    '@napi-rs/canvas',  // 原生模块，必须 external
    'pdfjs-dist',       // 包含 worker，需要单独处理
    'pdfjs-dist/legacy/build/pdf.mjs',
  ],
});

// Write package.json for CJS
fs.writeFileSync('dist/package.json', JSON.stringify({
  name: 'scipen-pdf2tex-dist',
  type: 'commonjs',
  version: '0.0.1',
}, null, 2));

console.log('✅ Build completed: dist/index.js');
