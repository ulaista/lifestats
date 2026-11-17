// Weekly encrypted backup of the whole database, sent to the owner's Telegram chat as a file.
// Format: "LSB1" | 12-byte IV | AES-256-GCM(gzip(JSON)) | 16-byte tag. The key (BACKUP_KEY, 64 hex chars)
// lives only in .env and Vercel — Telegram holds a file it cannot read. Restore: scripts/restore-backup.ts.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { db } from './db.ts';

const MAGIC = Buffer.from('LSB1');

function key(): Buffer {
  const k = process.env.BACKUP_KEY ?? '';
  if (!/^[0-9a-f]{64}$/i.test(k)) throw new Error('BACKUP_KEY не настроен');
  return Buffer.from(k, 'hex');
}

export function tables(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
}

/** Every table's rows as JSON (raw column names, so it restores into the same schema). */
export function dump(): { json: Buffer; rows: number; tables: number } {
  const out: Record<string, unknown[]> = {};
  let rows = 0;
  for (const t of tables()) {
    const r = db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[];
    out[t] = r; rows += r.length;
  }
  const json = Buffer.from(JSON.stringify({ v: 1, created: new Date().toISOString(), tables: out }));
  return { json, rows, tables: Object.keys(out).length };
}

export function encrypt(plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(zlib.gzipSync(plain, { level: 9 })), c.final()]);
  return Buffer.concat([MAGIC, iv, body, c.getAuthTag()]);
}

export function decrypt(file: Buffer): { v: number; created: string; tables: Record<string, Record<string, unknown>[]> } {
  if (file.length < 32 || !file.subarray(0, 4).equals(MAGIC)) throw new Error('Это не файл резервной копии lifestats');
  const iv = file.subarray(4, 16), tag = file.subarray(file.length - 16), body = file.subarray(16, file.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(body), d.final()]); // throws if the key is wrong or the file was altered
  return JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
}

export function makeBackup(): { file: Buffer; name: string; caption: string } {
  const { json, rows, tables: n } = dump();
  const file = encrypt(json);
  const day = new Date().toLocaleDateString('sv-SE');
  return {
    file, name: `lifestats-backup-${day}.lsb`,
    caption: `🗄 Резервная копия lifestats за ${day}: ${rows} записей в ${n} таблицах, ${Math.ceil(file.length / 1024)} КБ.\nЗашифрована ключом BACKUP_KEY — без него файл не открыть. Восстановление: scripts/restore-backup.ts.`,
  };
}
