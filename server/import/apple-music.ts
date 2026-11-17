// Apple Music listening history from the Apple privacy export (privacy.apple.com →
// "Apple Media Services information"). The archive contains nested zips; we look for:
//   • "...Play History Daily Tracks.csv"  (best: per-track per-day play counts & duration)
//   • "...Play Activity.csv"              (fallback: raw play events)
//   • "...Track Play History.csv"         (last resort)
//   • "...Library Tracks.json"            (album / genre lookup)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { parse } from 'csv-parse';
import { db, tx } from '../db.ts';
import { wallIso } from '../lib/time.ts';

type Found = { name: string; file: string };

function listZip(file: string): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out: yauzl.Entry[] = [];
      zip.on('entry', (e: yauzl.Entry) => { out.push(e); zip.readEntry(); });
      zip.on('end', () => { zip.close(); resolve(out); });
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}
function extractEntry(file: string, name: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      zip.on('entry', (e: yauzl.Entry) => {
        if (e.fileName !== name) return zip.readEntry();
        zip.openReadStream(e, (e2, rs) => {
          if (e2 || !rs) return reject(e2);
          pipeline(rs, fs.createWriteStream(dest)).then(resolve, reject);
        });
      });
      zip.on('end', resolve);
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

const WANT = /(Play History Daily Tracks\.csv|Play Activity\.csv|Track Play History\.csv|Library Tracks\.json)$/i;

/** Walk a (possibly nested) zip and extract interesting files into tmp. */
async function collect(file: string, tmp: string, depth = 0): Promise<Found[]> {
  const found: Found[] = [];
  if (!/\.zip$/i.test(file)) return [{ name: path.basename(file), file }];
  for (const e of await listZip(file)) {
    if (e.fileName.endsWith('/') || e.fileName.includes('__MACOSX')) continue;
    const base = path.basename(e.fileName);
    if (WANT.test(base)) {
      const dest = path.join(tmp, `${found.length}-${depth}-${base}`);
      await extractEntry(file, e.fileName, dest);
      found.push({ name: base, file: dest });
    } else if (/\.zip$/i.test(base) && depth < 3 && /media|music|apple/i.test(e.fileName)) {
      const dest = path.join(tmp, `nested-${depth}-${found.length}-${base}`);
      await extractEntry(file, e.fileName, dest);
      found.push(...(await collect(dest, tmp, depth + 1)));
    }
  }
  return found;
}

async function* csvRows(file: string): AsyncGenerator<Record<string, string>> {
  const parser = fs.createReadStream(file).pipe(parse({ columns: (h: string[]) => h.map((x) => x.replace(/^﻿/, '').trim().toLowerCase()), relax_column_count: true, relax_quotes: true, skip_empty_lines: true }));
  for await (const r of parser as Readable) yield r as Record<string, string>;
}

interface Lib { artist?: string; title?: string; album?: string; genre?: string }

function loadLibrary(files: Found[]): { byId: Map<string, Lib>; byTitle: Map<string, Lib> } {
  const byId = new Map<string, Lib>(), byTitle = new Map<string, Lib>();
  for (const f of files.filter((f) => /Library Tracks\.json$/i.test(f.name))) {
    try {
      const arr = JSON.parse(fs.readFileSync(f.file, 'utf8'));
      for (const t of Array.isArray(arr) ? arr : []) {
        const lib: Lib = { artist: t['Artist'] || t['Album Artist'], title: t['Title'] || t['Name'], album: t['Album'], genre: t['Genre'] };
        for (const k of ['Track Identifier', 'Apple Music Track Identifier', 'Catalog Track Identifier']) if (t[k]) byId.set(String(t[k]), lib);
        if (lib.title) byTitle.set(lib.title.toLowerCase(), lib);
      }
    } catch { /* ignore malformed */ }
  }
  return { byId, byTitle };
}

function splitDescription(desc: string): { artist: string; title: string } {
  const i = desc.indexOf(' - ');
  return i > 0 ? { artist: desc.slice(0, i).trim(), title: desc.slice(i + 3).trim() } : { artist: 'Неизвестный исполнитель', title: desc.trim() };
}

interface Row { date: string; played_at: string; hour: number | null; artist: string; title: string; album: string | null; genre: string | null; plays: number; skips: number; ms: number | null }

export async function importAppleMusic(file: string): Promise<Record<string, number>> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifestats-am-'));
  try {
    const files = await collect(file, tmp);
    const { byId, byTitle } = loadLibrary(files);
    const rows = new Map<string, Row>();
    const add = (r: Row) => {
      const k = `${r.played_at}\t${r.artist}\t${r.title}`;
      const cur = rows.get(k);
      if (cur) { cur.plays += r.plays; cur.skips += r.skips; cur.ms = (cur.ms ?? 0) + (r.ms ?? 0); }
      else rows.set(k, r);
    };
    let used = '';
    const daily = files.find((f) => /Daily Tracks\.csv$/i.test(f.name));
    const activity = files.find((f) => /Play Activity\.csv$/i.test(f.name));
    const history = files.find((f) => /Track Play History\.csv$/i.test(f.name));

    if (daily) {
      used = daily.name;
      for await (const r of csvRows(daily.file)) {
        if (r['media type'] && r['media type'] !== 'AUDIO') continue;
        const dp = (r['date played'] || '').replace(/\D/g, '');
        if (dp.length !== 8) continue;
        const date = `${dp.slice(0, 4)}-${dp.slice(4, 6)}-${dp.slice(6, 8)}`;
        const hour = parseInt((r['hours'] || '').split(/[,\s]+/).filter(Boolean)[0] ?? '', 10);
        const lib = byId.get(r['track identifier'] || '') ;
        const d = splitDescription(r['track description'] || '');
        const plays = parseInt(r['play count'] || '1', 10) || 1;
        add({
          date, hour: Number.isFinite(hour) ? hour : null,
          played_at: `${date}T${Number.isFinite(hour) ? String(hour).padStart(2, '0') : '12'}:00:00`,
          artist: lib?.artist || d.artist, title: lib?.title || d.title, album: lib?.album ?? null, genre: lib?.genre ?? null,
          plays, skips: parseInt(r['skip count'] || '0', 10) || 0, ms: parseInt(r['play duration milliseconds'] || '', 10) || null,
        });
      }
    } else if (activity) {
      used = activity.name;
      for await (const r of csvRows(activity.file)) {
        const ms = parseInt(r['play duration milliseconds'] || '0', 10);
        if (!(ms >= 30000)) continue; // a "play" = ≥30 s listened
        if (r['event type'] && !/PLAY_END/i.test(r['event type'])) continue;
        const ts = Date.parse(r['event start timestamp'] || r['event received timestamp'] || '');
        if (!Number.isFinite(ts)) continue;
        const off = parseInt(r['utc offset in seconds'] || '0', 10) || 0;
        const local = wallIso(ts + off * 1000);
        const title = r['song name'] || r['content name'] || '';
        if (!title) continue;
        const lib = byTitle.get(title.toLowerCase());
        add({
          date: local.slice(0, 10), hour: +local.slice(11, 13), played_at: local,
          artist: r['artist name'] || lib?.artist || 'Неизвестный исполнитель', title,
          album: r['album name'] || lib?.album || null, genre: r['genre'] || lib?.genre || null,
          plays: 1, skips: /SKIP/i.test(r['end reason type'] || '') ? 1 : 0, ms,
        });
      }
    } else if (history) {
      used = history.name;
      for await (const r of csvRows(history.file)) {
        const ts = Number(r['last played date']);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        const local = wallIso(ts + new Date(ts).getTimezoneOffset() * -60000);
        const d = splitDescription(r['track name'] || '');
        add({ date: local.slice(0, 10), hour: +local.slice(11, 13), played_at: local, ...d, album: null, genre: null, plays: 1, skips: 0, ms: null });
      }
    } else {
      throw new Error('Не нашёл историю Apple Music. Нужен архив «Apple Media Services» с privacy.apple.com или файл «… Play History Daily Tracks.csv».');
    }

    tx(() => {
      db.prepare("DELETE FROM music_plays WHERE source = 'apple'").run();
      const st = db.prepare(`INSERT OR REPLACE INTO music_plays (source, date, played_at, hour, artist, title, album, genre, play_count, skip_count, duration_ms) VALUES ('apple',?,?,?,?,?,?,?,?,?,?)`);
      for (const r of rows.values()) st.run(r.date, r.played_at, r.hour, r.artist, r.title, r.album, r.genre, r.plays, r.skips, r.ms);
    });
    let plays = 0;
    for (const r of rows.values()) plays += r.plays;
    return { rows: rows.size, plays, libraryTracks: byId.size, file: used as unknown as number };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
