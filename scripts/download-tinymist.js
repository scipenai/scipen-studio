/**
 * @file download-tinymist.js - Tinymist LSP binary downloader
 * @description Downloads Tinymist LSP server binaries for different platforms from GitHub releases.
 *              Extracts and places them in resources/bin/ directory.
 * @depends https, fs, path, url, child_process
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// ====== Paths ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== Configuration ======
const TINYMIST_VERSION = 'v0.14.4';

const PLATFORM_CONFIG = {
  win32: {
    url: `https://github.com/Myriad-Dreamin/tinymist/releases/download/${TINYMIST_VERSION}/tinymist-x86_64-pc-windows-msvc.zip`,
    filename: 'tinymist.exe',
    archiveType: 'zip',
    archiveName: 'tinymist-x86_64-pc-windows-msvc.zip',
    binaryInArchive: 'tinymist.exe',
  },
  'win32-arm64': {
    url: `https://github.com/Myriad-Dreamin/tinymist/releases/download/${TINYMIST_VERSION}/tinymist-aarch64-pc-windows-msvc.zip`,
    filename: 'tinymist.exe',
    archiveType: 'zip',
    archiveName: 'tinymist-aarch64-pc-windows-msvc.zip',
    binaryInArchive: 'tinymist.exe',
  },
  darwin: {
    url: `https://github.com/Myriad-Dreamin/tinymist/releases/download/${TINYMIST_VERSION}/tinymist-x86_64-apple-darwin.tar.gz`,
    filename: 'tinymist',
    archiveType: 'tar.gz',
    archiveName: 'tinymist-x86_64-apple-darwin.tar.gz',
    binaryInArchive: 'tinymist',
  },
  'darwin-arm64': {
    url: `https://github.com/Myriad-Dreamin/tinymist/releases/download/${TINYMIST_VERSION}/tinymist-aarch64-apple-darwin.tar.gz`,
    filename: 'tinymist',
    archiveType: 'tar.gz',
    archiveName: 'tinymist-aarch64-apple-darwin.tar.gz',
    binaryInArchive: 'tinymist',
  },
  linux: {
    url: `https://github.com/Myriad-Dreamin/tinymist/releases/download/${TINYMIST_VERSION}/tinymist-x86_64-unknown-linux-gnu.tar.gz`,
    filename: 'tinymist',
    archiveType: 'tar.gz',
    archiveName: 'tinymist-x86_64-unknown-linux-gnu.tar.gz',
    binaryInArchive: 'tinymist',
  },
  'linux-arm64': {
    url: `https://github.com/Myriad-Dreamin/tinymist/releases/download/${TINYMIST_VERSION}/tinymist-aarch64-unknown-linux-gnu.tar.gz`,
    filename: 'tinymist',
    archiveType: 'tar.gz',
    archiveName: 'tinymist-aarch64-unknown-linux-gnu.tar.gz',
    binaryInArchive: 'tinymist',
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
  } else if (platform === 'win32' && process.arch === 'arm64') {
    platform = 'win32-arm64';
  } else if (platform === 'linux' && process.arch === 'arm64') {
    platform = 'linux-arm64';
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

// ====== Extraction ======
function extractArchive(archivePath, destDir, archiveType) {
  console.log(`Extracting: ${archivePath}`);

  if (archiveType === 'zip') {
    // Use PowerShell on Windows as it's more reliable than unzip
    if (process.platform === 'win32') {
      execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`, {
        stdio: 'inherit',
      });
    } else {
      execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'inherit' });
    }
  } else if (archiveType === 'tar.gz') {
    execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' });
  }

  console.log('Extraction completed');
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
  console.log(`Tinymist version: ${TINYMIST_VERSION}`);

  const binDir = path.join(__dirname, '..', 'resources', 'bin');
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  const archivePath = path.join(binDir, config.archiveName);
  const binaryPath = path.join(binDir, config.filename);

  if (fs.existsSync(binaryPath)) {
    console.log(`Tinymist already exists: ${binaryPath}`);
    const overwrite = process.argv.includes('--force');
    if (!overwrite) {
      console.log('Use --force flag to force re-download');
      return;
    }
    console.log('Forcing re-download...');
  }

  try {
    await downloadFile(config.url, archivePath);
    extractArchive(archivePath, binDir, config.archiveType);

    // The tar.gz archive contains: <archiveBaseName>/<binaryName>
    // e.g. tinymist-x86_64-unknown-linux-gnu/tinymist
    // We need to move it to the bin directory root
    if (!fs.existsSync(binaryPath)) {
      const archiveBaseName = config.archiveName.replace(/\.(tar\.gz|zip)$/, '');
      const candidates = [
        path.join(binDir, archiveBaseName, config.binaryInArchive),
        path.join(binDir, archiveBaseName),
      ];
      let found = false;
      for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          fs.copyFileSync(candidate, binaryPath);
          console.log(`Copied: ${candidate} -> ${binaryPath}`);
          found = true;
          break;
        }
      }
      // Clean up extracted subdirectory
      const extractedDir = path.join(binDir, archiveBaseName);
      if (fs.existsSync(extractedDir) && fs.statSync(extractedDir).isDirectory()) {
        fs.rmSync(extractedDir, { recursive: true, force: true });
        console.log(`Cleaned up: ${extractedDir}`);
      }
      if (!found) {
        const files = fs.readdirSync(binDir);
        console.error(`Expected binary not found. Files in ${binDir}:`);
        files.forEach((f) => console.error(`  - ${f}`));
        throw new Error(`Binary not found after extraction: ${config.filename}`);
      }
    }

    if (platform !== 'win32' && platform !== 'win32-arm64') {
      fs.chmodSync(binaryPath, 0o755);
      console.log('Executable permissions set');
    }

    fs.unlinkSync(archivePath);
    console.log('Temporary files cleaned up');

    if (fs.existsSync(binaryPath)) {
      const stats = fs.statSync(binaryPath);
      console.log(`\n✅ Tinymist downloaded successfully!`);
      console.log(`   Path: ${binaryPath}`);
      console.log(`   Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    } else {
      throw new Error('Binary file not found');
    }
  } catch (error) {
    console.error(`\n❌ Download failed: ${error.message}`);
    process.exit(1);
  }
}

main();

