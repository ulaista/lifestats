import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');

// Minimal .env loader (no dependency).
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');

export const config = {
  root,
  dataDir,
  dbPath: path.join(dataDir, 'lifestats.db'),
  lastfm: {
    apiKey: process.env.LASTFM_API_KEY || '',
    user: process.env.LASTFM_USER || '',
    intervalMin: Number(process.env.LASTFM_SYNC_MINUTES || 2),
  },
};
