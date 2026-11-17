// Screen Time collector for macOS (experimental).
// Reads app-usage intervals from macOS's local knowledge database and sends daily
// per-app totals to lifestats. With "Share across devices" enabled in Screen Time,
// iPhone usage may also be present (device = peer device id). Writes a CSV into data/inbox,
// which the running lifestats picks up within a minute.
//
// Requires Full Disk Access for the app running this (Terminal / iTerm):
//   System Settings → Privacy & Security → Full Disk Access.
//
// Usage:  node scripts/screentime-mac.ts [days=30]
// Schedule it (e.g. hourly) with launchd or cron for automatic updates.
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { config } from '../server/config.ts';

const days = Number(process.argv[2] || 30);
const dbPath = path.join(os.homedir(), 'Library/Application Support/Knowledge/knowledgeC.db');
const MAC_EPOCH = 978307200; // 2001-01-01 in unix seconds

let db: DatabaseSync;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
  db.prepare('SELECT 1 FROM ZOBJECT LIMIT 1').get();
} catch (e) {
  console.error(`Не удалось открыть ${dbPath}: ${(e as Error).message}`);
  console.error('Дай Терминалу «Полный доступ к диску»: Системные настройки → Конфиденциальность и безопасность → Полный доступ к диску.');
  process.exit(1);
}

const since = Date.now() / 1000 - days * 86400 - MAC_EPOCH;
const rows = db.prepare(`
  SELECT o.ZVALUESTRING app, o.ZSTARTDATE s, o.ZENDDATE e, COALESCE(src.ZDEVICEID, '') device
  FROM ZOBJECT o LEFT JOIN ZSOURCE src ON o.ZSOURCE = src.Z_PK
  WHERE o.ZSTREAMNAME = '/app/usage' AND o.ZSTARTDATE > ?`).all(since) as { app: string; s: number; e: number; device: string }[];

if (!rows.length) {
  console.error('В knowledgeC.db нет записей /app/usage. В новых версиях macOS эти данные могут храниться в другом месте (Biome) — коллектор их пока не читает.');
  process.exit(2);
}

const names = new Map<string, string>();
function appName(bundle: string): string {
  if (names.has(bundle)) return names.get(bundle)!;
  let name = bundle.split('.').pop() || bundle;
  try {
    const p = execFileSync('mdfind', [`kMDItemCFBundleIdentifier == "${bundle.replace(/"/g, '')}"`], { encoding: 'utf8', timeout: 3000 }).split('\n')[0];
    if (p) name = path.basename(p, '.app');
  } catch { /* keep fallback */ }
  names.set(bundle, name);
  return name;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (unix: number) => { const d = new Date(unix * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const agg = new Map<string, number>();
for (const r of rows) {
  const minutes = (r.e - r.s) / 60;
  if (!(minutes > 0) || minutes > 24 * 60) continue;
  const key = `${localDate(r.s + MAC_EPOCH)}\t${r.device ? 'Другое устройство' : 'Mac'}\t${appName(r.app)}`;
  agg.set(key, (agg.get(key) ?? 0) + minutes);
}
const payload = [...agg].map(([k, minutes]) => { const [date, device, app] = k.split('\t'); return { date, device, app, minutes: Math.round(minutes * 10) / 10 }; });

const inbox = path.join(config.dataDir, 'inbox');
fs.mkdirSync(inbox, { recursive: true });
const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = ['date,device,app,minutes', ...payload.map((r) => [r.date, r.device, r.app, String(r.minutes)].map(q).join(','))].join('\n');
const file = path.join(inbox, `screentime-${Date.now()}.csv`);
fs.writeFileSync(file, csv);
console.log(`Записал ${payload.length} строк → ${file}`);
