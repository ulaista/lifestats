// Streaming importer for Apple Health "export.zip" / "export.xml".
// export.xml can be several GB, so we never load it whole: we read it line by line
// (Apple writes every element start-tag on its own line) and aggregate on the fly.
import fs from 'node:fs';
import readline from 'node:readline';
import { Readable, Transform } from 'node:stream';
import yauzl from 'yauzl';
import { db, tx } from '../db.ts';
import { parseHkDate } from '../lib/time.ts';
import { normalize, typeInfo } from '../lib/hk.ts';
import { rebuildDaily, rebuildSleep } from '../derive.ts';
import { SLEEP_STAGE, writeSleep, writeWorkouts, writeCategory, activityName, type SleepSeg, type Workout, type CatEvent } from './store.ts';

export interface Progress { phase: string; bytes: number; total: number; records: number }

const ATTR_RE = /([A-Za-z_:][\w:.-]*)="([^"]*)"/g;
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescape(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e] ?? m));
}
function attrs(tag: string): Record<string, string> {
  const o: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(tag))) o[m[1]] = unescape(m[2]);
  return o;
}

function openZipEntry(file: string, match: RegExp): Promise<{ stream: Readable; size: number }> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('Не удалось открыть zip'));
      let found = false;
      zip.on('entry', (entry: yauzl.Entry) => {
        if (match.test(entry.fileName)) {
          found = true;
          zip.openReadStream(entry, (e2, rs) => {
            if (e2 || !rs) return reject(e2);
            resolve({ stream: rs, size: entry.uncompressedSize });
          });
        } else zip.readEntry();
      });
      zip.on('end', () => { if (!found) reject(new Error('В архиве нет export.xml — это точно экспорт из «Здоровья»?')); });
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

export async function importHealthExport(file: string, onProgress: (p: Progress) => void = () => {}): Promise<Record<string, number>> {
  let input: Readable, total: number;
  if (/\.zip$/i.test(file)) {
    const r = await openZipEntry(file, /(^|\/)export\.xml$/);
    input = r.stream; total = r.size;
  } else {
    input = fs.createReadStream(file); total = fs.statSync(file).size;
  }
  const prog: Progress = { phase: 'Чтение export.xml', bytes: 0, total, records: 0 };
  const counter = new Transform({
    transform(chunk, _enc, cb) { prog.bytes += chunk.length; cb(null, chunk); },
  });
  input.pipe(counter);
  const rl = readline.createInterface({ input: counter, crlfDelay: Infinity });

  // Additive accumulator for this import; flushed into a temp table so memory stays bounded.
  db.exec(`DROP TABLE IF EXISTS temp.imp_q;
    CREATE TEMP TABLE imp_q (type TEXT, hour TEXT, source TEXT, kind TEXT, sum REAL, min REAL, max REAL, count INTEGER, PRIMARY KEY(type, hour, source)) WITHOUT ROWID;`);
  const upsert = db.prepare(`INSERT INTO imp_q VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(type, hour, source) DO UPDATE SET sum = sum + excluded.sum, min = MIN(min, excluded.min), max = MAX(max, excluded.max), count = count + excluded.count`);
  const acc = new Map<string, number[]>();
  const kinds = new Map<string, string>();
  const flushAcc = () => {
    tx(() => {
      for (const [k, v] of acc) {
        const [type, hour, source] = k.split('\t');
        upsert.run(type, hour, source, kinds.get(type)!, v[0], v[1], v[2], v[3]);
      }
    });
    acc.clear();
  };

  let sleep: SleepSeg[] = [], cats: CatEvent[] = [], workouts: Workout[] = [];
  const summaries: Record<string, string>[] = [];
  const flushMisc = () => {
    tx(() => { writeSleep(sleep); writeCategory(cats); writeWorkouts(workouts); });
    sleep = []; cats = []; workouts = [];
  };

  const stats: Record<string, number> = { records: 0, quantity: 0, sleep: 0, category: 0, workouts: 0, activitySummaries: 0, skipped: 0 };
  let pending = ''; // multi-line start tag buffer
  let curWorkout: (Workout & { stats: Record<string, string>[] }) | null = null;
  let lastReport = 0;

  for await (const raw of rl) {
    let line = pending ? pending + ' ' + raw : raw.trimStart();
    if (pending || (line.startsWith('<') && !line.includes('>'))) {
      if (!line.includes('>')) { pending = line; continue; }
      pending = '';
    }
    if (line.startsWith('<Record ')) {
      stats.records++;
      const a = attrs(line);
      const type = a.type;
      const s = parseHkDate(a.startDate), e = parseHkDate(a.endDate);
      if (!type || !s || !e) { stats.skipped++; continue; }
      const source = a.sourceName || '?';
      if (type.startsWith('HKQuantityTypeIdentifier')) {
        const vRaw = parseFloat(a.value);
        if (!Number.isFinite(vRaw)) { stats.skipped++; continue; }
        const v = normalize(type, vRaw, a.unit);
        if (!kinds.has(type)) kinds.set(type, typeInfo(type).kind);
        const key = type + '\t' + s.local.slice(0, 13) + '\t' + source;
        const cur = acc.get(key);
        if (cur) { cur[0] += v; if (v < cur[1]) cur[1] = v; if (v > cur[2]) cur[2] = v; cur[3]++; }
        else acc.set(key, [v, v, v, 1]);
        stats.quantity++;
        if (acc.size >= 300_000) flushAcc();
      } else if (type === 'HKCategoryTypeIdentifierSleepAnalysis') {
        const stage = SLEEP_STAGE[a.value];
        if (stage) { sleep.push({ source, startLocal: s.local, endLocal: e.local, startMs: s.epoch, endMs: e.epoch, stage }); stats.sleep++; }
      } else if (type.startsWith('HKCategoryTypeIdentifier')) {
        cats.push({ type, source, startLocal: s.local, endLocal: e.local, startMs: s.epoch, endMs: e.epoch, value: a.value ?? '' });
        stats.category++;
      } else stats.skipped++;
      if (sleep.length + cats.length >= 20_000) flushMisc();
    } else if (line.startsWith('<Workout ')) {
      const a = attrs(line);
      const s = parseHkDate(a.startDate), e = parseHkDate(a.endDate);
      if (!s || !e) continue;
      let dur = parseFloat(a.duration);
      if (Number.isFinite(dur)) dur = a.durationUnit === 's' ? dur / 60 : a.durationUnit === 'hr' ? dur * 60 : dur;
      else dur = (e.epoch - s.epoch) / 60000;
      const dist = parseFloat(a.totalDistance), en = parseFloat(a.totalEnergyBurned);
      curWorkout = {
        source: a.sourceName || '?', activity: activityName(a.workoutActivityType || 'Other'),
        startLocal: s.local, endLocal: e.local, startMs: s.epoch, durationMin: dur,
        distanceKm: Number.isFinite(dist) && dist > 0 ? normalize('Distance', dist, a.totalDistanceUnit) : null,
        energyKcal: Number.isFinite(en) && en > 0 ? normalize('Energy', en, a.totalEnergyBurnedUnit) : null,
        hrAvg: null, hrMax: null, stats: [],
      };
      if (line.endsWith('/>')) { workouts.push(curWorkout); curWorkout = null; stats.workouts++; }
    } else if (curWorkout && line.startsWith('<WorkoutStatistics ')) {
      const a = attrs(line);
      const t = a.type || '';
      if (t.endsWith('HeartRate')) {
        curWorkout.hrAvg = parseFloat(a.average) || null;
        curWorkout.hrMax = parseFloat(a.maximum) || null;
      } else if (t.endsWith('ActiveEnergyBurned') && !curWorkout.energyKcal) {
        const v = parseFloat(a.sum); if (v > 0) curWorkout.energyKcal = normalize(t, v, a.unit);
      } else if (t.includes('Distance') && !curWorkout.distanceKm) {
        const v = parseFloat(a.sum); if (v > 0) curWorkout.distanceKm = normalize(t, v, a.unit);
      }
    } else if (curWorkout && line.startsWith('</Workout>')) {
      workouts.push(curWorkout); curWorkout = null; stats.workouts++;
    } else if (line.startsWith('<ActivitySummary ')) {
      summaries.push(attrs(line));
      stats.activitySummaries++;
    }
    prog.records = stats.records;
    if (prog.bytes - lastReport > 8 * 1024 * 1024) { lastReport = prog.bytes; onProgress(prog); }
  }
  flushAcc();
  flushMisc();

  onProgress({ ...prog, phase: 'Запись в базу' });
  tx(() => {
    db.exec(`INSERT OR REPLACE INTO q_hourly SELECT type, hour, source, kind, sum, min, max, count FROM imp_q`);
    const st = db.prepare(`INSERT OR REPLACE INTO activity_summaries VALUES (?,?,?,?,?,?,?)`);
    for (const a of summaries) {
      if (!a.dateComponents) continue;
      const n = (k: string) => (a[k] !== undefined && a[k] !== '' ? parseFloat(a[k]) : null);
      const kcal = (k: string) => { const v = n(k); return v === null ? null : normalize('Energy', v, a.activeEnergyBurnedUnit); };
      st.run(a.dateComponents, kcal('activeEnergyBurned'), kcal('activeEnergyBurnedGoal'), n('appleExerciseTime'), n('appleExerciseTimeGoal'), n('appleStandHours'), n('appleStandHoursGoal'));
    }
  });
  db.exec('DROP TABLE IF EXISTS temp.imp_q');

  onProgress({ ...prog, phase: 'Пересчёт дневных итогов' });
  rebuildDaily();
  rebuildSleep();
  return stats;
}
