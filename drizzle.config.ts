import { defineConfig } from 'drizzle-kit';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Determine database path
const userDataPath = process.env.APPDATA 
  || (process.platform === 'darwin' 
    ? path.join(os.homedir(), 'Library', 'Application Support') 
    : path.join(os.homedir(), '.local', 'share'));
const dbDir = path.join(userDataPath, 'SciPen Studio');
const dbPath = path.join(dbDir, 'scipen-studio.db');

// Ensure directory exists
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export default defineConfig({
  schema: './src/main/database/schema.ts',
  out: './src/main/database/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: dbPath
  },
  verbose: true,
  strict: true
});

