import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

console.log(`📦 Building scipen-reviewer...`);

/**
 * 递归复制目录
 */
function copyDirRecursive(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    return;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const srcPath = path.join(sourceDir, entry.name);
    const destPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 复制 Claude Agent SDK 运行时资源
 * SDK 需要 cli.js 和其他运行时文件
 */
function copyClaudeAgentSdkRuntime() {
  const sdkDir = path.join('node_modules', '@anthropic-ai', 'claude-agent-sdk');
  if (!fs.existsSync(sdkDir)) {
    console.warn('⚠ Claude Agent SDK not found, skip copying runtime assets.');
    return;
  }

  const distDir = path.join('dist', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(distDir, { recursive: true });

  // 复制主要文件
  const filesToCopy = [
    'cli.js',
    'sdk.mjs',
    'sdk.d.ts',
    'sdk-tools.d.ts',
    'resvg.wasm',
    'tree-sitter.wasm',
    'tree-sitter-bash.wasm',
    'package.json',
    'LICENSE.md',
    'README.md',
  ];

  let copied = 0;
  for (const file of filesToCopy) {
    const srcPath = path.join(sdkDir, file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(distDir, file));
      copied++;
    }
  }

  // 复制 entrypoints 目录
  copyDirRecursive(path.join(sdkDir, 'entrypoints'), path.join(distDir, 'entrypoints'));
  // 复制 transport 目录
  copyDirRecursive(path.join(sdkDir, 'transport'), path.join(distDir, 'transport'));
  // 复制 vendor 目录（包含 ripgrep 等原生二进制）
  copyDirRecursive(path.join(sdkDir, 'vendor'), path.join(distDir, 'vendor'));

  console.log(`✅ Copied Claude Agent SDK runtime (${copied} files + directories)`);
}

// esbuild 打包 - 输出 ESM 格式（因为 SDK 是 ESM）
await esbuild.build({
  entryPoints: ['src/cli/scipen-cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'dist/cli/scipen-cli.mjs',  // 使用 .mjs 扩展名
  format: 'esm',  // 输出 ESM 格式
  // claude-agent-sdk 必须 external，因为它需要 cli.js 等运行时文件
  external: ['@anthropic-ai/claude-agent-sdk'],
  // ESM 格式不需要 banner，因为 import.meta.url 原生可用
  // 源代码已经正确处理了 __dirname
});

// 复制模板文件
const srcTemplates = 'src/templates';
const distTemplates = 'dist/templates';

if (fs.existsSync(srcTemplates)) {
  if (!fs.existsSync(distTemplates)) {
    fs.mkdirSync(distTemplates, { recursive: true });
  }
  
  const files = fs.readdirSync(srcTemplates);
  for (const file of files) {
    fs.copyFileSync(
      path.join(srcTemplates, file),
      path.join(distTemplates, file)
    );
  }
  console.log(`✅ Copied ${files.length} template files`);
}

// 复制 Claude Agent SDK 运行时依赖
copyClaudeAgentSdkRuntime();

// Write package.json for ESM
fs.writeFileSync('dist/package.json', JSON.stringify({
  name: 'scipen-reviewer-dist',
  type: 'module',  // ESM 模式
  version: '2.0.0',
}, null, 2));

console.log('✅ Build completed: dist/cli/scipen-cli.mjs');
