/**
 * @file download-marksman.js - Marksman LSP binary downloader
 * @description Downloads Marksman LSP server binaries for different platforms from GitHub releases.
 *              Marksman publishes bare binaries (no archive), so download→rename→chmod is sufficient.
 * @depends https, fs, path, url
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ====== Paths ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== Configuration ======
const MARKSMAN_VERSION = '2026-02-08';

const PLATFORM_CONFIG = {
  win32: {
    url: `https://github.com/artempyanykh/marksman/releases/download/${MARKSMAN_VERSION}/marksman.exe`,
    filename: 'marksman.exe',
    downloadName: 'marksman.exe',
  },
  darwin: {
    url: `https://github.com/artempyanykh/marksman/releases/download/${MARKSMAN_VERSION}/marksman-macos`,
    filename: 'marksman',
    downloadName: 'marksman-macos',
  },
  'darwin-arm64': {
    url: `https://github.com/artempyanykh/marksman/releases/download/${MARKSMAN_VERSION}/marksman-macos`,
    filename: 'marksman',
    downloadName: 'marksman-macos',
  },
  linux: {
    url: `https://github.com/artempyanykh/marksman/releases/download/${MARKSMAN_VERSION}/marksman-linux-x64`,
    filename: 'marksman',
    downloadName: 'marksman-linux-x64',
  },
};

// ====== Platform Detection ======
function getTargetPlatform() {
  const arg = process.argv[2];
  if (arg) {
    if (PLATFORM_CONFIG[arg]) {
      return arg;
    }
    console.error(`Unknown platform: ${arg}`);
    console.error(`Supported platforms: ${Object.keys(PLATFORM_CONFIG).join(', ')}`);
    process.exit(1);
  }

  let platform = process.platform;
  if (platform === 'darwin' && process.arch === 'arm64') {
    platform = 'darwin-arm64';
  }
  return platform;
}

// ====== Download ======
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading: ${url}`);

    const file = fs.createWriteStream(destPath);

    const request = (url) => {
      https.get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          const redirectUrl = response.headers.location;
          console.log(`Redirecting to: ${redirectUrl}`);
          request(redirectUrl);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloadedSize = 0;

        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          if (totalSize) {
            const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
            process.stdout.write(`\rDownload progress: ${percent}%`);
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          console.log('\nDownload completed');
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    };

    request(url);
  });
}

// ====== Main ======
async function main() {
  const platform = getTargetPlatform();
  const config = PLATFORM_CONFIG[platform];

  if (!config) {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }

  console.log(`Target platform: ${platform}`);
  console.log(`Marksman version: ${MARKSMAN_VERSION}`);

  const binDir = path.join(__dirname, '..', 'resources', 'bin');
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  const binaryPath = path.join(binDir, config.filename);
  // Download to a temp name first, then rename
  const downloadPath = path.join(binDir, config.downloadName);

  if (fs.existsSync(binaryPath)) {
    console.log(`Marksman already exists: ${binaryPath}`);
    const overwrite = process.argv.includes('--force');
    if (!overwrite) {
      console.log('Use --force flag to force re-download');
      return;
    }
    console.log('Forcing re-download...');
  }

  try {
    // Marksman publishes bare binaries (no archive), download directly
    await downloadFile(config.url, downloadPath);

    // Rename to final filename if different
    if (downloadPath !== binaryPath) {
      fs.renameSync(downloadPath, binaryPath);
      console.log(`Renamed: ${config.downloadName} -> ${config.filename}`);
    }

    // Set executable permissions on Unix
    if (platform !== 'win32') {
      fs.chmodSync(binaryPath, 0o755);
      console.log('Executable permissions set');
    }

    if (fs.existsSync(binaryPath)) {
      const stats = fs.statSync(binaryPath);
      console.log(`\n✅ Marksman downloaded successfully!`);
      console.log(`   Path: ${binaryPath}`);
      console.log(`   Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    } else {
      throw new Error('Binary file not found');
    }
  } catch (error) {
    console.error(`\n❌ Download failed: ${error.message}`);
    // Clean up partial download
    if (fs.existsSync(downloadPath)) {
      fs.unlinkSync(downloadPath);
    }
    process.exit(1);
  }
}

main();
