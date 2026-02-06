/**
 * @file download-texlab.js - TexLab LSP binary downloader
 * @description Downloads TexLab LSP server binaries for different platforms from GitHub releases.
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
const TEXLAB_VERSION = 'v5.21.0';

const PLATFORM_CONFIG = {
  win32: {
    url: `https://github.com/latex-lsp/texlab/releases/download/${TEXLAB_VERSION}/texlab-x86_64-windows.zip`,
    filename: 'texlab.exe',
    archiveType: 'zip',
    archiveName: 'texlab-x86_64-windows.zip',
  },
  darwin: {
    url: `https://github.com/latex-lsp/texlab/releases/download/${TEXLAB_VERSION}/texlab-x86_64-macos.tar.gz`,
    filename: 'texlab',
    archiveType: 'tar.gz',
    archiveName: 'texlab-x86_64-macos.tar.gz',
  },
  'darwin-arm64': {
    url: `https://github.com/latex-lsp/texlab/releases/download/${TEXLAB_VERSION}/texlab-aarch64-macos.tar.gz`,
    filename: 'texlab',
    archiveType: 'tar.gz',
    archiveName: 'texlab-aarch64-macos.tar.gz',
  },
  linux: {
    url: `https://github.com/latex-lsp/texlab/releases/download/${TEXLAB_VERSION}/texlab-x86_64-linux.tar.gz`,
    filename: 'texlab',
    archiveType: 'tar.gz',
    archiveName: 'texlab-x86_64-linux.tar.gz',
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
  console.log(`TexLab version: ${TEXLAB_VERSION}`);

  const binDir = path.join(__dirname, '..', 'resources', 'bin');
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  const archivePath = path.join(binDir, config.archiveName);
  const binaryPath = path.join(binDir, config.filename);

  if (fs.existsSync(binaryPath)) {
    console.log(`TexLab already exists: ${binaryPath}`);
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

    // After extraction, the binary may have a platform-specific name
    // Rename it to the expected filename if needed
    if (!fs.existsSync(binaryPath)) {
      const archiveBaseName = config.archiveName.replace(/\.(tar\.gz|zip)$/, '');
      const candidates = [
        path.join(binDir, archiveBaseName),
        path.join(binDir, archiveBaseName, config.filename),
      ];
      let found = false;
      for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          fs.renameSync(candidate, binaryPath);
          console.log(`Renamed: ${path.basename(candidate)} -> ${config.filename}`);
          found = true;
          break;
        }
      }
      if (!found) {
        const files = fs.readdirSync(binDir);
        console.error(`Expected binary not found. Files in ${binDir}:`);
        files.forEach((f) => console.error(`  - ${f}`));
        throw new Error(`Binary not found after extraction: ${config.filename}`);
      }
    }

    if (platform !== 'win32') {
      fs.chmodSync(binaryPath, 0o755);
      console.log('Executable permissions set');
    }

    fs.unlinkSync(archivePath);
    console.log('Temporary files cleaned up');

    if (fs.existsSync(binaryPath)) {
      const stats = fs.statSync(binaryPath);
      console.log(`\n✅ TexLab downloaded successfully!`);
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
