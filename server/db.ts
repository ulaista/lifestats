// Two backends with the same synchronous API:
//  • on the Mac: a local SQLite file (node:sqlite);
//  • in the cloud (TURSO_DATABASE_URL set): Turso via libsql — an embedded replica in /tmp for fast
//    local reads, writes go to the Turso primary (read-your-writes).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

export interface Stmt {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
export interface Db { prepare(sql: string): Stmt; exec(sql: string): unknown }

export const cloud = Boolean(process.env.TURSO_DATABASE_URL);
let writeCount = 0;
/** Data writes so far in this process (cloud): lets the API notice changes made by the bot. */
export const writes = () => writeCount;

/** Turso's server re-prints SQL and upper-cases aliases that are keywords (`first` → `FIRST`); map them back. */
function fixKeys(d: Db): Db {
  const fix = (r: unknown) => {
    if (!r || typeof r !== 'object') return r;
    const o = r as Record<string, unknown>;
    for (const k of Object.keys(o)) if (/[A-Z]/.test(k) && !/[a-z]/.test(k) && /^[A-Z0-9_]+$/.test(k)) { o[k.toLowerCase()] = o[k]; delete o[k]; }
    return o;
  };
  const prepare = d.prepare.bind(d);
  d.prepare = (sql: string) => {
    const s = prepare(sql);
    const get = s.get.bind(s), all = s.all.bind(s), run = s.run.bind(s);
    const counts = !/\bkv\b/i.test(sql); // kv holds versions/offsets, not dashboard data
    return Object.assign(s, {
      get: (...p: unknown[]) => fix(get(...p)), all: (...p: unknown[]) => all(...p).map(fix),
      run: (...p: unknown[]) => { const r = run(...p) as { changes?: number }; if (counts && r?.changes) writeCount++; return r; },
    });
  };
  return d;
}

function open(): Db & { sync?: () => unknown } {
  if (cloud) {
    const Database = createRequire(import.meta.url)('libsql');
    // Default: talk to Turso directly (same region as the function, a few ms per query).
    // TURSO_REPLICA=1: embedded replica in /tmp (fast reads, but slow cold starts and writes).
    if (process.env.TURSO_REPLICA !== '1') return fixKeys(new Database(process.env.TURSO_DATABASE_URL, { authToken: process.env.TURSO_AUTH_TOKEN }));
    const replica = path.join(process.env.REPLICA_DIR || '/tmp', 'lifestats-replica.db');
    const d = new Database(replica, { syncUrl: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN, readYourWrites: true });
    d.sync();
    return d;
  }
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite'); // lazy: the cloud never loads it
  const d = new DatabaseSync(config.dbPath) as Db;
  d.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  return d;
}

export const db = open();
/** Pull the latest changes from Turso (cloud only; no-op locally). */
export function syncDb() {
  if (!cloud || process.env.TURSO_REPLICA !== '1') return;
  try { (db as { sync?: () => unknown }).sync?.(); } catch (e) { console.warn('[db] sync:', (e as Error).message); }
}

db.exec(`

-- Quantity samples aggregated per local hour and source.
-- kind: 'cum' (summed: steps, kcal…) or 'disc' (averaged: pulse, weight…)
CREATE TABLE IF NOT EXISTS q_hourly (
  type   TEXT NOT NULL,
  hour   TEXT NOT NULL,          -- local 'YYYY-MM-DDTHH'
  source TEXT NOT NULL,
  kind   TEXT NOT NULL,
  sum    REAL NOT NULL,
  min    REAL NOT NULL,
  max    REAL NOT NULL,
  count  INTEGER NOT NULL,
  PRIMARY KEY (type, hour, source)
) WITHOUT ROWID;

-- Derived: one row per type/day after per-hour source de-duplication.
CREATE TABLE IF NOT EXISTS q_daily (
  type  TEXT NOT NULL,
  date  TEXT NOT NULL,
  value REAL NOT NULL,           -- sum for cum, mean for disc
  min   REAL NOT NULL,
  max   REAL NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (type, date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sleep_segments (
  source TEXT NOT NULL,
  start_local TEXT NOT NULL,
  end_local   TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms   INTEGER NOT NULL,
  stage  TEXT NOT NULL,           -- inbed | asleep | core | deep | rem | awake
  night  TEXT NOT NULL,           -- wake-up date
  PRIMARY KEY (source, start_ms, end_ms, stage)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sleep_segments_night ON sleep_segments(night);

CREATE TABLE IF NOT EXISTS sleep_nights (
  night TEXT PRIMARY KEY,
  source TEXT,
  bedtime TEXT,                   -- local ISO of first asleep segment
  waketime TEXT,
  asleep_min REAL, inbed_min REAL, awake_min REAL,
  core_min REAL, deep_min REAL, rem_min REAL, unspecified_min REAL,
  has_stages INTEGER
);

CREATE TABLE IF NOT EXISTS category_events (
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  start_local TEXT NOT NULL,
  end_local TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  value TEXT,
  date TEXT NOT NULL,
  PRIMARY KEY (type, source, start_ms, end_ms)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS category_events_date ON category_events(date, type);

CREATE TABLE IF NOT EXISTS workouts (
  source TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  activity TEXT NOT NULL,
  start_local TEXT NOT NULL,
  end_local TEXT NOT NULL,
  date TEXT NOT NULL,
  duration_min REAL,
  distance_km REAL,
  energy_kcal REAL,
  hr_avg REAL,
  hr_max REAL,
  PRIMARY KEY (source, start_ms, activity)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS workouts_date ON workouts(date);
CREATE INDEX IF NOT EXISTS workouts_start ON workouts(start_ms);

CREATE TABLE IF NOT EXISTS activity_summaries (
  date TEXT PRIMARY KEY,
  move_kcal REAL, move_goal REAL,
  exercise_min REAL, exercise_goal REAL,
  stand_hours REAL, stand_goal REAL
);

-- Music plays. Apple Music "Daily Tracks" rows are already aggregated per track/day,
-- so a row carries play_count and total duration.
CREATE TABLE IF NOT EXISTS music_plays (
  source TEXT NOT NULL,           -- apple | lastfm
  date TEXT NOT NULL,
  played_at TEXT NOT NULL,        -- local ISO (or date + first hour)
  hour INTEGER,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  album TEXT,
  genre TEXT,
  play_count INTEGER NOT NULL DEFAULT 1,
  skip_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,            -- total listened ms (null = unknown)
  PRIMARY KEY (source, played_at, artist, title)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS music_plays_date ON music_plays(date);

CREATE TABLE IF NOT EXISTS screentime (
  date TEXT NOT NULL,
  device TEXT NOT NULL,
  app TEXT NOT NULL,
  category TEXT,
  minutes REAL NOT NULL,
  PRIMARY KEY (date, device, app)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  detail TEXT
);
`);

export function kvGet(k: string): string | undefined {
  const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
  return r?.v;
}
export function kvSet(k: string, v: string) {
  db.prepare('INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}

/** One multi-row INSERT per chunk: a single round trip to Turso instead of one per row. */
export function insertMany(head: string, rows: unknown[][], tail = '') {
  if (!rows.length) return;
  const width = rows[0].length, per = Math.max(1, Math.floor(30000 / width));
  const tuple = '(' + Array(width).fill('?').join(',') + ')';
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    db.prepare(`${head} VALUES ${chunk.map(() => tuple).join(',')} ${tail}`).run(...chunk.flat());
  }
}

export function tx<T>(fn: () => T): T {
  // Turso replica: statements prepared before BEGIN run outside the remote transaction and the
  // COMMIT then fails, so in the cloud each write simply autocommits.
  if (cloud) return fn();
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
