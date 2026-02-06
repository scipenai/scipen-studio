#!/usr/bin/env node

/**
 * @file build-cli-sidecars.js - CLI tools build script
 * @description Builds all CLI tools in cli_tools/ directory using esbuild. Generates JS bundles
 *              that are executed by Electron via ELECTRON_RUN_AS_NODE.
 * @depends child_process, fs, path, url
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ====== Path Resolution ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== Configuration ======
const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');

const CLI_TOOLS = [
  { name: 'scipen-pdf2tex', dir: 'scipen_pdf2tex' },
  { name: 'scipen-reviewer', dir: 'scipen-reviewer' },
  { name: 'scipen-beamer', dir: 'scipen-beamer' },
];

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logStep(step, message) {
  console.log(`${colors.cyan}[${step}]${colors.reset} ${message}`);
}

function logSuccess(message) {
  console.log(`${colors.green}✓${colors.reset} ${message}`);
}

function logError(message) {
  console.log(`${colors.red}✗${colors.reset} ${message}`);
}

function logWarning(message) {
  console.log(`${colors.yellow}⚠${colors.reset} ${message}`);
}

// ====== Paths ======
const projectRoot = path.resolve(__dirname, '..');
const cliToolsDir = path.join(projectRoot, 'cli_tools');

if (!fs.existsSync(cliToolsDir)) {
  logError(`cli_tools directory does not exist: ${cliToolsDir}`);
  process.exit(1);
}

// ====== Command Execution ======
function runCommand(command, options = {}) {
  const { cwd = projectRoot, ignoreError = false } = options;

  if (verbose) {
    logStep('CMD', command);
  }

  try {
    const result = execSync(command, {
      cwd,
      stdio: verbose ? 'inherit' : 'pipe',
      encoding: 'utf-8',
    });
    return { success: true, output: result };
  } catch (error) {
    if (ignoreError) {
      return { success: false, error: error.message };
    }
    logError(`Command execution failed: ${command}`);
    if (error.stderr) {
      console.error(error.stderr);
    }
    throw error;
  }
}

// ====== Build Functions ======
async function buildTool(tool) {
  const toolDir = path.join(cliToolsDir, tool.dir);

  if (!fs.existsSync(toolDir)) {
    logWarning(`Tool directory does not exist: ${toolDir}`);
    return false;
  }

  const packageJson = path.join(toolDir, 'package.json');
  if (!fs.existsSync(packageJson)) {
    logWarning(`package.json does not exist: ${packageJson}`);
    return false;
  }

  log(`\n${'─'.repeat(50)}`, colors.blue);
  logStep('BUILD', `Building ${tool.name}...`);

  const nodeModulesDir = path.join(toolDir, 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    logStep('DEPS', 'Installing dependencies...');
    runCommand('pnpm install', { cwd: toolDir });
  }

  logStep('ESBUILD', 'Building JS bundle...');
  runCommand('pnpm run build', { cwd: toolDir });

  logSuccess(`${tool.name} build completed`);
  return true;
}

// ====== Main ======
async function main() {
  log('\n' + '═'.repeat(50), colors.cyan);
  log('  SciPen CLI Tools Build Script', colors.cyan);
  log('═'.repeat(50), colors.cyan);

  log(`\nNumber of tools: ${CLI_TOOLS.length}`);

  const results = [];

  for (const tool of CLI_TOOLS) {
    try {
      const success = await buildTool(tool);
      results.push({ tool: tool.name, success });
    } catch (error) {
      results.push({ tool: tool.name, success: false, error: error.message });
    }
  }

  // Output build results summary
  log('\n' + '═'.repeat(50), colors.cyan);
  log('  Build Results', colors.cyan);
  log('═'.repeat(50), colors.cyan);

  let allSuccess = true;
  for (const result of results) {
    if (result.success) {
      logSuccess(`${result.tool}`);
    } else {
      logError(`${result.tool}: ${result.error || 'Build failed'}`);
      allSuccess = false;
    }
  }

  // List generated files
  log('\nGenerated files:', colors.cyan);
  const ENTRY_FILES = {
    'scipen_pdf2tex': 'index.js',
    'scipen-reviewer': 'cli/scipen-cli.mjs',  // ESM 格式
    'scipen-beamer': 'cli/index.mjs',  // ESM 格式
  };
  for (const tool of CLI_TOOLS) {
    const distDir = path.join(cliToolsDir, tool.dir, 'dist');
    const entryFile = ENTRY_FILES[tool.dir] || 'index.js';
    const entryPath = path.join(distDir, entryFile);
    if (fs.existsSync(entryPath)) {
      const stats = fs.statSync(entryPath);
      const sizeKB = (stats.size / 1024).toFixed(1);
      log(`  - ${tool.dir}/dist/${entryFile} (${sizeKB} KB)`);
    }
  }

  if (allSuccess) {
    log('\n✅ All tools built successfully!\n', colors.green);
  } else {
    log('\n❌ Some tools failed to build\n', colors.red);
    process.exit(1);
  }
}

main().catch((error) => {
  logError(`Build failed: ${error.message}`);
  process.exit(1);
});
