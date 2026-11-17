// Read-side queries used by the bot (and anything else that needs numbers).
import { db, kvGet } from '../db.ts';
import { typeInfo, shortName } from '../lib/hk.ts';

export const T = {
  steps: 'HKQuantityTypeIdentifierStepCount',
  distance: 'HKQuantityTypeIdentifierDistanceWalkingRunning',
  active: 'HKQuantityTypeIdentifierActiveEnergyBurned',
  exercise: 'HKQuantityTypeIdentifierAppleExerciseTime',
  flights: 'HKQuantityTypeIdentifierFlightsClimbed',
  daylight: 'HKQuantityTypeIdentifierTimeInDaylight',
  hr: 'HKQuantityTypeIdentifierHeartRate',
  rhr: 'HKQuantityTypeIdentifierRestingHeartRate',
  walkHr: 'HKQuantityTypeIdentifierWalkingHeartRateAverage',
  hrv: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  vo2: 'HKQuantityTypeIdentifierVO2Max',
  spo2: 'HKQuantityTypeIdentifierOxygenSaturation',
  resp: 'HKQuantityTypeIdentifierRespiratoryRate',
  weight: 'HKQuantityTypeIdentifierBodyMass',
};

export interface DailyPoint { date: string; value: number; min: number; max: number }
export interface Night {
  night: string; source: string; bedtime: string | null; waketime: string | null;
  asleep_min: number | null; inbed_min: number | null; awake_min: number; core_min: number; deep_min: number; rem_min: number; unspecified_min: number; has_stages: number;
}
export interface Workout { activity: string; date: string; start_local: string; duration_min: number | null; distance_km: number | null; energy_kcal: number | null; hr_avg: number | null; hr_max: number | null }

const all = <R>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as never[])) as R[];
const one = <R>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...(a as never[])) as R | undefined;

export function bounds(): { first: string | null; last: string | null } {
  return one<{ first: string | null; last: string | null }>(`SELECT MIN(d) first, MAX(d) last FROM (
    SELECT date d FROM q_daily UNION ALL SELECT night FROM sleep_nights UNION ALL SELECT date FROM music_plays
    UNION ALL SELECT date FROM workouts UNION ALL SELECT date FROM screentime)`)!;
}

export function daily(type: string, from: string, to: string): DailyPoint[] {
  return all<DailyPoint>('SELECT date, value, min, max FROM q_daily WHERE type = ? AND date >= ? AND date <= ? ORDER BY date', type, from, to);
}

export function types() {
  return all<{ type: string; days: number; first: string; last: string }>('SELECT type, COUNT(*) days, MIN(date) first, MAX(date) last FROM q_daily GROUP BY type ORDER BY days DESC')
    .map((t) => ({ ...t, ...typeInfo(t.type), short: shortName(t.type) }));
}

/** Weekday × hour profile; cumulative types → mean hourly total per day, discrete → mean value. */
export function profile(type: string, from: string, to: string): { dow: number; h: number; value: number }[] {
  return all(`
    WITH w AS (
      SELECT hour, kind, sum, count, ROW_NUMBER() OVER (PARTITION BY hour ORDER BY CASE WHEN kind='cum' THEN sum ELSE count END DESC) rn
      FROM q_hourly WHERE type = ? AND hour >= ? AND hour <= ?
    ), days AS (
      SELECT CAST(strftime('%w', substr(hour,1,10)) AS INT) dow, COUNT(DISTINCT substr(hour,1,10)) n FROM w WHERE rn = 1 GROUP BY dow
    )
    SELECT CAST(strftime('%w', substr(w.hour,1,10)) AS INT) dow, CAST(substr(w.hour,12,2) AS INT) h,
      CASE WHEN w.kind='cum' THEN SUM(w.sum) * 1.0 / (SELECT n FROM days WHERE days.dow = CAST(strftime('%w', substr(w.hour,1,10)) AS INT))
           ELSE SUM(w.sum) / SUM(w.count) END value
    FROM w WHERE rn = 1 GROUP BY dow, h ORDER BY dow, h`, type, from, to + 'T99');
}

/** Hourly values for one day (winning source per hour). */
export function hoursOfDay(type: string, date: string): { h: number; value: number }[] {
  return all(`SELECT CAST(substr(hour,12,2) AS INT) h, CASE WHEN kind='cum' THEN sum ELSE sum/count END value FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY hour ORDER BY CASE WHEN kind='cum' THEN sum ELSE count END DESC) rn
      FROM q_hourly WHERE type = ? AND hour LIKE ?) WHERE rn = 1 ORDER BY hour`, type, date + 'T%');
}

export function nights(from: string, to: string): Night[] {
  return all<Night>('SELECT * FROM sleep_nights WHERE night >= ? AND night <= ? ORDER BY night', from, to);
}
export function lastNight(): Night | undefined {
  return one<Night>('SELECT * FROM sleep_nights WHERE asleep_min IS NOT NULL ORDER BY night DESC LIMIT 1');
}
export function sleepSegments(night: string) {
  const n = one<{ source: string }>('SELECT source FROM sleep_nights WHERE night = ?', night);
  if (!n) return [];
  return all<{ start_local: string; end_local: string; stage: string }>('SELECT start_local, end_local, stage FROM sleep_segments WHERE night = ? AND source = ? ORDER BY start_ms', night, n.source);
}

export function workouts(from: string, to: string): Workout[] {
  return all<Workout>('SELECT activity, date, start_local, duration_min, distance_km, energy_kcal, hr_avg, hr_max FROM workouts WHERE date >= ? AND date <= ? ORDER BY start_ms', from, to);
}

export function rings(from: string, to: string) {
  return all<{ date: string; move_kcal: number | null; move_goal: number | null; exercise_min: number | null; exercise_goal: number | null; stand_hours: number | null; stand_goal: number | null }>(
    'SELECT * FROM activity_summaries WHERE date >= ? AND date <= ? ORDER BY date', from, to);
}

// Per day, one music source wins: Apple export > Music app on this Mac > Last.fm (they'd double-count otherwise).
const PLAYS = `(SELECT * FROM music_plays p WHERE source = (
   SELECT source FROM music_plays q WHERE q.date = p.date
   ORDER BY CASE source WHEN 'apple' THEN 0 WHEN 'mac' THEN 1 WHEN 'lastfm' THEN 2 ELSE 3 END LIMIT 1))`;

export function music(from: string, to: string, lim = 10) {
  const W = `FROM ${PLAYS} p WHERE date >= ? AND date <= ?`;
  return {
    totals: one<{ plays: number; skips: number; minutes: number; artists: number; tracks: number; days: number }>(`SELECT COALESCE(SUM(play_count),0) plays, COALESCE(SUM(skip_count),0) skips,
      COALESCE(SUM(duration_ms),0)/60000.0 minutes, COUNT(DISTINCT artist) artists, COUNT(DISTINCT artist || char(1) || title) tracks, COUNT(DISTINCT date) days ${W}`, from, to)!,
    daily: all<{ date: string; plays: number; minutes: number }>(`SELECT date, SUM(play_count) plays, COALESCE(SUM(duration_ms),0)/60000.0 minutes ${W} GROUP BY date ORDER BY date`, from, to),
    topArtists: all<{ artist: string; plays: number; minutes: number }>(`SELECT artist, SUM(play_count) plays, COALESCE(SUM(duration_ms),0)/60000.0 minutes ${W} GROUP BY artist ORDER BY plays DESC LIMIT ?`, from, to, lim),
    topTracks: all<{ artist: string; title: string; plays: number }>(`SELECT artist, title, SUM(play_count) plays ${W} GROUP BY artist, title ORDER BY plays DESC LIMIT ?`, from, to, lim),
    hours: all<{ hour: number; plays: number }>(`SELECT hour, SUM(play_count) plays ${W} AND hour IS NOT NULL GROUP BY hour`, from, to),
    newArtists: all<{ artist: string; plays: number }>(`SELECT artist, plays FROM (SELECT artist, MIN(date) first, SUM(CASE WHEN date >= ? AND date <= ? THEN play_count ELSE 0 END) plays FROM ${PLAYS} GROUP BY artist)
      WHERE first >= ? AND first <= ? ORDER BY plays DESC LIMIT ?`, from, to, from, to, lim),
  };
}

export function screentime(from: string, to: string) {
  return {
    daily: all<{ date: string; minutes: number }>('SELECT date, SUM(minutes) minutes FROM screentime WHERE date >= ? AND date <= ? GROUP BY date ORDER BY date', from, to),
    apps: all<{ app: string; minutes: number }>('SELECT app, SUM(minutes) minutes FROM screentime WHERE date >= ? AND date <= ? GROUP BY app ORDER BY minutes DESC LIMIT 10', from, to),
  };
}

export function records() {
  const top = (type: string, dir: 'DESC' | 'ASC') => one<{ date: string; value: number }>(`SELECT date, value FROM q_daily WHERE type = ? ORDER BY value ${dir} LIMIT 1`, type) ?? null;
  const steps = all<{ date: string; value: number }>('SELECT date, value FROM q_daily WHERE type = ? ORDER BY date', T.steps);
  let best = 0, cur = 0, prev = '';
  for (const s of steps) {
    const consecutive = prev && Date.parse(s.date) - Date.parse(prev) === 86400000;
    cur = s.value >= 10000 ? (consecutive ? cur + 1 : 1) : 0;
    if (cur > best) best = cur;
    prev = s.date;
  }
  const sum = (type: string) => one<{ v: number | null }>('SELECT SUM(value) v FROM q_daily WHERE type = ?', type)!.v;
  return {
    maxSteps: top(T.steps, 'DESC'), maxDistance: top(T.distance, 'DESC'), maxActive: top(T.active, 'DESC'),
    minRhr: top(T.rhr, 'ASC'), maxHrv: top(T.hrv, 'DESC'),
    longestSleep: one<{ date: string; value: number }>('SELECT night date, asleep_min value FROM sleep_nights WHERE asleep_min IS NOT NULL ORDER BY asleep_min DESC LIMIT 1') ?? null,
    longestWorkout: one<{ date: string; value: number; activity: string }>('SELECT date, duration_min value, activity FROM workouts ORDER BY duration_min DESC LIMIT 1') ?? null,
    streak10k: { best, current: cur },
    totalSteps: sum(T.steps), totalKm: sum(T.distance),
    nights: one<{ n: number }>('SELECT COUNT(*) n FROM sleep_nights')!.n,
    workouts: one<{ n: number }>('SELECT COUNT(*) n FROM workouts')!.n,
    plays: one<{ n: number }>(`SELECT COALESCE(SUM(play_count),0) n FROM ${PLAYS}`)!.n,
  };
}

export function nowPlaying(): { artist: string; title: string } | null {
  const v = kvGet('music:nowplaying') || kvGet('lastfm:nowplaying');
  return v ? JSON.parse(v) : null;
}
export function lastPlay() {
  return one<{ artist: string; title: string; played_at: string }>('SELECT artist, title, played_at FROM music_plays ORDER BY played_at DESC LIMIT 1') ?? null;
}
export function syncTimes() {
  return { health: kvGet('hae:last') ?? null, music: [kvGet('macmusic:last'), kvGet('lastfm:last_sync')].filter(Boolean).sort().at(-1) ?? null, screentime: kvGet('screentime:last') ?? null };
}
