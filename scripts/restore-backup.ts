// Restores a lifestats backup (.lsb from the Telegram chat).
//   node --no-warnings scripts/restore-backup.ts <file.lsb>            — check: what's inside vs. the database now
//   node --no-warnings scripts/restore-backup.ts <file.lsb> --apply    — replace the database contents with the backup
// Target: Turso when TURSO_DATABASE_URL is set in .env, otherwise the local data/ database. Needs BACKUP_KEY.
import fs from 'node:fs';
import { config } from '../server/config.ts';
const { db, cloud, tx } = await import('../server/db.ts');
// Modules that create their own tables, so the schema exists before rows go in.
await import('../server/plan/store.ts'); await import('../server/plan/money.ts'); await import('../server/plan/budget.ts');
await import('../server/plan/routines.ts'); await import('../server/import/screen-events.ts'); await import('../server/import/mac-music.ts'); await import('../server/import/health-connect.ts');
const { decrypt, tables } = await import('../server/backup.ts');
void config;

const file = process.argv[2], apply = process.argv.includes('--apply');
if (!file) { console.error('usage: restore-backup.ts <file.lsb> [--apply]'); process.exit(1); }
const b = decrypt(fs.readFileSync(file));
const have = new Set(tables());
console.log(`Backup of ${b.created} → ${cloud ? 'Turso (cloud)' : 'local database'}${apply ? '' : ' [check only, add --apply to restore]'}`);
for (const [t, rows] of Object.entries(b.tables)) {
  const now = have.has(t) ? Number((db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get() as { n: number }).n) : null;
  console.log(`  ${t.padEnd(20)} backup ${String(rows.length).padStart(6)}   now ${now === null ? 'no table' : now}`);
}
if (!apply) process.exit(0);
for (const [t, rows] of Object.entries(b.tables)) {
  if (!have.has(t)) { console.log(`  skip ${t}: no such table`); continue; }
  const cols = new Set((db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name));
  tx(() => {
    db.prepare(`DELETE FROM "${t}"`).run();
    for (const r of rows) {
      const keys = Object.keys(r).filter((k) => cols.has(k));
      db.prepare(`INSERT INTO "${t}" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => r[k] as never));
    }
  });
}
console.log('Restored.');
