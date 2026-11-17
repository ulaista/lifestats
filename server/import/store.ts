// Shared writers used by the export importer and the automatic ingest endpoints.
import { db, insertMany } from '../db.ts';
import { nightKey } from '../lib/time.ts';

export const SLEEP_STAGE: Record<string, string> = {
  HKCategoryValueSleepAnalysisInBed: 'inbed',
  HKCategoryValueSleepAnalysisAsleep: 'asleep',
  HKCategoryValueSleepAnalysisAsleepUnspecified: 'asleep',
  HKCategoryValueSleepAnalysisAsleepCore: 'core',
  HKCategoryValueSleepAnalysisAsleepDeep: 'deep',
  HKCategoryValueSleepAnalysisAsleepREM: 'rem',
  HKCategoryValueSleepAnalysisAwake: 'awake',
  // Health Auto Export spellings
  'In Bed': 'inbed', InBed: 'inbed', Asleep: 'asleep', Unspecified: 'asleep', Core: 'core', Deep: 'deep', REM: 'rem', Rem: 'rem', Awake: 'awake',
};

export interface SleepSeg { source: string; startLocal: string; endLocal: string; startMs: number; endMs: number; stage: string }

export function writeSleep(segs: SleepSeg[]) {
  insertMany('INSERT OR IGNORE INTO sleep_segments (source, start_local, end_local, start_ms, end_ms, stage, night)',
    segs.map((s) => [s.source, s.startLocal, s.endLocal, s.startMs, s.endMs, s.stage, nightKey(s.startLocal)]));
}

export interface Workout {
  source: string; activity: string; startLocal: string; endLocal: string; startMs: number;
  durationMin: number | null; distanceKm: number | null; energyKcal: number | null; hrAvg: number | null; hrMax: number | null;
}
export function writeWorkouts(ws: Workout[]) {
  // The same workout can arrive from export.zip and from Health Auto Export under different
  // source names: treat anything starting within ±2 min as the same workout (latest write wins).
  const del = db.prepare('DELETE FROM workouts WHERE start_ms BETWEEN ? AND ?');
  const st = db.prepare(`INSERT OR REPLACE INTO workouts
    (source, start_ms, activity, start_local, end_local, date, duration_min, distance_km, energy_kcal, hr_avg, hr_max)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const w of ws) del.run(w.startMs - 120000, w.startMs + 120000), st.run(w.source, w.startMs, w.activity, w.startLocal, w.endLocal, w.startLocal.slice(0, 10), w.durationMin, w.distanceKm, w.energyKcal, w.hrAvg, w.hrMax);
}

export interface CatEvent { type: string; source: string; startLocal: string; endLocal: string; startMs: number; endMs: number; value: string }
export function writeCategory(evs: CatEvent[]) {
  const st = db.prepare(`INSERT OR IGNORE INTO category_events
    (type, source, start_local, end_local, start_ms, end_ms, value, date) VALUES (?,?,?,?,?,?,?,?)`);
  for (const e of evs) st.run(e.type, e.source, e.startLocal, e.endLocal, e.startMs, e.endMs, e.value, e.startLocal.slice(0, 10));
}

/** Upsert already-aggregated hourly rows (replace semantics). */
export function writeHourly(rows: { type: string; hour: string; source: string; kind: string; sum: number; min: number; max: number; count: number }[]) {
  insertMany('INSERT OR REPLACE INTO q_hourly (type, hour, source, kind, sum, min, max, count)',
    rows.map((r) => [r.type, r.hour, r.source, r.kind, r.sum, r.min, r.max, r.count]));
}

/** Workout type id → short name: HKWorkoutActivityTypeRunning → Running */
const HAE_ACTIVITY: Record<string, string> = {
  OutdoorRun: 'Running', IndoorRun: 'Running', Run: 'Running', OutdoorWalk: 'Walking', IndoorWalk: 'Walking', Walk: 'Walking',
  OutdoorCycle: 'Cycling', IndoorCycle: 'Cycling', Cycle: 'Cycling', PoolSwim: 'Swimming', OpenWaterSwim: 'Swimming',
  Strength: 'TraditionalStrengthTraining', HIIT: 'HighIntensityIntervalTraining', Hike: 'Hiking',
};
export function activityName(t: string): string {
  const s = t.replace(/^HKWorkoutActivityType/, '').replace(/\s+/g, '');
  return HAE_ACTIVITY[s] ?? s;
}
