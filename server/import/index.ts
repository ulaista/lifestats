import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import { db } from '../db.ts';
import { importHealthExport, type Progress } from './health-export.ts';
import { importAppleMusic } from './apple-music.ts';
import { importScreentimeCsv } from './screentime.ts';
import { ingestHealthExport, isHealthExport } from './healthexport.ts';
import { ingestHealthAutoExport } from './hae.ts';

function zipHas(file: string, re: RegExp): Promise<boolean> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('Не zip-архив'));
      let hit = false;
      zip.on('entry', (e: yauzl.Entry) => { if (re.test(e.fileName)) { hit = true; zip.close(); resolve(true); } else zip.readEntry(); });
      zip.on('end', () => { if (!hit) resolve(false); });
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

export type ImportKind = 'health' | 'music' | 'screentime' | 'hae';

export async function detectKind(file: string): Promise<ImportKind> {
  const name = path.basename(file).toLowerCase();
  if (name.endsWith('.zip')) return (await zipHas(file, /(^|\/)export\.xml$/)) ? 'health' : 'music';
  if (name.endsWith('.xml')) return 'health';
  if (name.endsWith('.json')) return 'hae';
  if (name.endsWith('.csv')) {
    const head = fs.readFileSync(file, { encoding: 'utf8', flag: 'r' }).slice(0, 400).toLowerCase();
    return /^\W*date\s*,\s*device\s*,\s*app/.test(head) ? 'screentime' : 'music';
  }
  throw new Error('Неизвестный формат файла: ' + name);
}

export async function importAny(file: string, onProgress?: (p: Progress) => void) {
  const kind = await detectKind(file);
  const log = db.prepare("INSERT INTO imports(kind, started_at, status) VALUES (?, datetime('now'), 'running')").run(kind);
  const id = Number(log.lastInsertRowid);
  try {
    let res: Record<string, unknown>;
    if (kind === 'health') res = await importHealthExport(file, onProgress);
    else if (kind === 'music') res = await importAppleMusic(file);
    else if (kind === 'screentime') res = importScreentimeCsv(file);
    else {
      const body = JSON.parse(fs.readFileSync(file, 'utf8'));
      res = isHealthExport(body) ? ingestHealthExport(body) : ingestHealthAutoExport(body);
    }
    db.prepare("UPDATE imports SET finished_at = datetime('now'), status = 'ok', detail = ? WHERE id = ?").run(JSON.stringify(res), id);
    return { kind, ...res };
  } catch (e) {
    db.prepare("UPDATE imports SET finished_at = datetime('now'), status = 'error', detail = ? WHERE id = ?").run(String((e as Error).message), id);
    throw e;
  }
}
