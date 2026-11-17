// Screen time. iOS has no export or API for Screen Time, so data comes from:
//   • the Mac collector script (scripts/screentime-mac.ts), which drops a CSV into data/inbox, or
//   • any CSV with columns date,device,app,minutes[,category] put into data/inbox or sent to the bot
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { db, kvSet, tx } from '../db.ts';

export interface StRow { date: string; device: string; app: string; minutes: number; category?: string | null }

export function writeScreentime(rows: StRow[]): number {
  const st = db.prepare('INSERT OR REPLACE INTO screentime (date, device, app, category, minutes) VALUES (?,?,?,?,?)');
  let n = 0;
  tx(() => {
    for (const r of rows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !r.app || !(r.minutes >= 0)) continue;
      st.run(r.date, r.device || 'Mac', r.app, r.category ?? null, r.minutes);
      n++;
    }
  });
  return n;
}

export function importScreentimeCsv(file: string) {
  const rows = parse(fs.readFileSync(file, 'utf8'), { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true }) as Record<string, string>[];
  kvSet('screentime:last', new Date().toISOString());
  return { rows: writeScreentime(rows.map((r) => ({ date: r.date, device: r.device, app: r.app, minutes: parseFloat(r.minutes), category: r.category }))) };
}
