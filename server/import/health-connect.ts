// Android: Health Connect data from the "HC Webhook" app (github.com/mcnaveen/health-connect-webhook) → POST /hc.
// Payload: top-level arrays per type — steps [{count,start_time,end_time}], sleep [{session_end_time,duration_seconds,
// stages:[{stage,start_time,end_time}]}], heart_rate [{bpm,time} | {time,avg,min,max}], active_calories /
// distance / exercise / resting_heart_rate / heart_rate_variability / weight …; times ISO 8601 (Z or offset).
// The app sends only records new since its last sync, so raw records are kept and hours are re-summed from them
// (re-sends and the app's outbox are harmless: records are keyed by type + time + origin).
import { db, kvSet, tx } from '../db.ts';
import { rebuildDaily } from '../derive.ts';
import { T } from '../stats/queries.ts';
import { writeHourly, writeWorkouts, type SleepSeg, type Workout } from './store.ts';
import { stageOf, syncSleep } from './health-sleep.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS hc_records (
  type     TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms   INTEGER NOT NULL,
  origin   TEXT NOT NULL DEFAULT '',
  value    REAL NOT NULL,
  min      REAL,
  max      REAL,
  rid      TEXT,
  PRIMARY KEY (type, start_ms, end_ms, origin)
);
CREATE INDEX IF NOT EXISTS hc_records_rid ON hc_records(rid);
`);

const SRC = 'Health Connect';

function local(ms: number): string {
  return new Date(ms).toLocaleString('sv-SE', { hour12: false }).replace(' ', 'T').slice(0, 19);
}
/** ISO string (Z or offset) or epoch seconds/ms → ms. */
function ms(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim()) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const origin = (r: any) => String(r?.metadata?.data_origin ?? r?.data_origin ?? '').slice(0, 80);
const rid = (r: any) => (r?.metadata?.id ?? r?.id ?? null) as string | null;
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// Which of our metrics each Health Connect array feeds, and how.
const CUM: [string, string, (r: any) => number | null][] = [
  ['steps', T.steps, (r) => num(r.count)],
  ['active_calories', T.active, (r) => num(r.calories)],
  ['distance', T.distance, (r) => { const m = num(r.meters); return m === null ? null : m / 1000; }],
];
const DISC: [string, string, (r: any) => { v: number | null; min?: number | null; max?: number | null }][] = [
  ['heart_rate', T.hr, (r) => ({ v: num(r.avg) ?? num(r.bpm), min: num(r.min), max: num(r.max) })],
  ['resting_heart_rate', T.rhr, (r) => ({ v: num(r.bpm) ?? num(r.avg) })],
  ['heart_rate_variability', T.hrv, (r) => ({ v: num(r.rmssd_millis) ?? num(r.avg) })],
  ['weight', T.weight, (r) => ({ v: num(r.kilograms) })],
];

/** Health Connect stage: enum name ("STAGE_TYPE_DEEP", "deep", "out_of_bed" …) or its number. */
const HC_STAGE_NUM: Record<number, string> = { 0: 'asleep', 1: 'awake', 2: 'asleep', 3: 'awake', 4: 'core', 5: 'deep', 6: 'rem', 7: 'awake' };
function hcStage(v: unknown): string | null {
  if (typeof v === 'number') return HC_STAGE_NUM[v] ?? null;
  const s = String(v ?? '');
  if (/out.?of.?bed/i.test(s)) return 'awake';
  if (/unknown/i.test(s)) return 'asleep';
  return stageOf(s);
}

export function isHealthConnect(body: any): boolean {
  return Boolean(body && typeof body === 'object' && 'app_version' in body && 'timezone' in body && !('metrics' in body));
}

export function ingestHealthConnect(body: any): Record<string, number> {
  const stats: Record<string, number> = {};
  const hours = new Map<string, Set<string>>(); // our type → affected local hours
  const touch = (type: string, hour: string) => { let s = hours.get(type); if (!s) hours.set(type, (s = new Set())); s.add(hour); };
  const ins = db.prepare('INSERT OR REPLACE INTO hc_records(type, start_ms, end_ms, origin, value, min, max, rid) VALUES(?,?,?,?,?,?,?,?)');

  tx(() => {
    // Records deleted on the phone since the last sync.
    for (const d of list(body.deleted)) {
      if (!d?.id) continue;
      for (const r of db.prepare('SELECT type, start_ms FROM hc_records WHERE rid = ?').all(String(d.id)) as { type: string; start_ms: number }[]) touch(r.type, local(r.start_ms).slice(0, 13));
      db.prepare('DELETE FROM hc_records WHERE rid = ?').run(String(d.id));
    }
    for (const [key, type, pick] of CUM) {
      for (const r of list(body[key])) {
        const a = ms(r.start_time), b = ms(r.end_time) ?? a, v = pick(r);
        if (a === null || v === null || v < 0) continue;
        ins.run(type, a, b!, origin(r), v, null, null, rid(r));
        touch(type, local(a).slice(0, 13)); stats[key] = (stats[key] ?? 0) + 1;
      }
    }
    for (const [key, type, pick] of DISC) {
      for (const r of list(body[key])) {
        const a = ms(r.time ?? r.start_time), p = pick(r);
        if (a === null || p.v === null) continue;
        ins.run(type, a, a, origin(r), p.v, p.min ?? p.v, p.max ?? p.v, rid(r));
        touch(type, local(a).slice(0, 13)); stats[key] = (stats[key] ?? 0) + 1;
      }
    }
  });

  // Re-sum every touched hour per origin from the raw records; rebuildDaily then keeps the biggest origin per
  // hour (phone vs. watch double counting), the same rule as for Apple Health.
  const days = new Set<string>();
  for (const [type, hs] of hours) {
    const kind = CUM.some(([, t]) => t === type) ? 'cum' : 'disc';
    const rows: Parameters<typeof writeHourly>[0] = [];
    tx(() => {
      for (const h of hs) {
        const from = Date.parse(h + ':00:00'), to = from + 3600_000; // local wall-clock hour (process TZ = APP_TZ)
        db.prepare(`DELETE FROM q_hourly WHERE type = ? AND hour = ? AND source LIKE '${SRC}%'`).run(type, h);
        const agg = db.prepare(`SELECT origin, SUM(value) s, COUNT(*) n, MIN(COALESCE(min, value)) lo, MAX(COALESCE(max, value)) hi
          FROM hc_records WHERE type = ? AND start_ms >= ? AND start_ms < ? GROUP BY origin`).all(type, from, to) as { origin: string; s: number; n: number; lo: number; hi: number }[];
        for (const g of agg) rows.push({ type, hour: h, source: `${SRC}${g.origin ? ': ' + g.origin : ''}`, kind, sum: g.s, min: g.lo, max: g.hi, count: kind === 'cum' ? 1 : g.n });
        days.add(h.slice(0, 10));
      }
      writeHourly(rows);
    });
  }
  if (days.size) { const d = [...days].sort(); rebuildDaily(d[0], d.at(-1)!); }

  // Sleep sessions arrive complete (after waking up).
  const segs: SleepSeg[] = [];
  for (const s of list(body.sleep)) {
    const src = `${SRC}${origin(s) ? ': ' + origin(s) : ''}`;
    const stages = list(s.stages);
    const staged = stages.some((st) => ['deep', 'rem', 'core'].includes(hcStage(st.stage) ?? ''));
    for (const st of stages) {
      const a = ms(st.start_time), b = ms(st.end_time);
      // "sleeping"/"unknown" inside a staged session is real sleep the device didn't classify — count it as core.
      let stage = hcStage(st.stage);
      if (stage === 'asleep' && staged) stage = 'core';
      if (a === null || b === null || b <= a || !stage) continue;
      segs.push({ source: src, stage, startMs: a, endMs: b, startLocal: local(a), endLocal: local(b) });
    }
    if (!stages.length) { // a session without stages: one "asleep" block
      const b = ms(s.session_end_time ?? s.end_time), dur = num(s.duration_seconds);
      const a = ms(s.session_start_time ?? s.start_time) ?? (b !== null && dur ? b - dur * 1000 : null);
      if (a !== null && b !== null && b > a) segs.push({ source: src, stage: 'asleep', startMs: a, endMs: b, startLocal: local(a), endLocal: local(b) });
    }
  }
  if (segs.length) stats.sleep = syncSleep(segs).nights.length;

  const workouts: Workout[] = [];
  for (const w of list(body.exercise)) {
    const a = ms(w.start_time), b = ms(w.end_time);
    if (a === null) continue;
    const type = String(w.type ?? 'Other').replace(/^EXERCISE_TYPE_/i, '').toLowerCase().replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase());
    workouts.push({
      source: SRC, activity: type || 'Other', startLocal: local(a), endLocal: local(b ?? a), startMs: a,
      durationMin: num(w.duration_seconds) !== null ? num(w.duration_seconds)! / 60 : b !== null ? (b - a) / 60000 : null,
      distanceKm: num(w.distance_meters) !== null ? num(w.distance_meters)! / 1000 : null, energyKcal: null, hrAvg: null, hrMax: null,
    });
  }
  if (workouts.length) { writeWorkouts(workouts); stats.exercise = workouts.length; }

  kvSet('hae:last', new Date().toISOString());
  kvSet('hc:last', new Date().toISOString());
  return stats;
}
