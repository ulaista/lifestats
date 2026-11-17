// HealthExport (free iPhone app): once a day it writes iCloud~HealthExport/Documents/Health/health-*.json
// with *daily* totals: { date_range, export_date, sync_type, metrics: { steps:[{date,value}], active_calories,
// heart_rate:[{date,average_bpm,max_bpm}], sleep:[{date,bed_start,bed_end,stages:{awake_min,core_min,deep_min,rem_min}}],
// workouts:[{date,type,duration_min,distance_km,calories,source}], weight, blood_pressure } }.
// Daily rows are stored under source 'HealthExport' and only win on days no finer source (export.zip, HAE) covers.
import { db, tx } from '../db.ts';
import { T } from '../stats/queries.ts';
import { rebuildDaily, rebuildSleep } from '../derive.ts';
import { writeHourly, writeSleep, writeWorkouts, type SleepSeg, type Workout } from './store.ts';
import { addDays, nightKey } from '../lib/time.ts';

export const HX = 'HealthExport';

export function isHealthExport(body: any): boolean {
  return Boolean(body && typeof body === 'object' && body.metrics && !Array.isArray(body.metrics) && (body.date_range || body.export_date));
}

/** UTC ISO → local wall-clock "YYYY-MM-DDTHH:MM:SS" on this Mac. */
function local(ms: number): string {
  return new Date(ms).toLocaleString('sv-SE', { hour12: false }).replace(' ', 'T').slice(0, 19);
}
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isDate = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const camel = (s: string) => s.replace(/(^|[_\s-]+)([a-z])/g, (_, __, c: string) => c.toUpperCase());

export function ingestHealthExport(body: any): Record<string, number> {
  const m = body.metrics ?? {};
  const stats = { days: 0, nights: 0, workouts: 0 };
  const hourly: Parameters<typeof writeHourly>[0] = [];
  const dates = new Set<string>();

  const daily = (list: any[] | undefined, type: string, kind: 'cum' | 'disc', pick: (p: any) => { v: number | null; max?: number | null }) => {
    for (const p of list ?? []) {
      if (!isDate(p?.date)) continue;
      const { v, max } = pick(p);
      if (v === null || (kind === 'cum' && v <= 0)) continue;
      hourly.push({ type, hour: `${p.date}T00`, source: HX, kind, sum: v, min: v, max: max ?? v, count: 1 });
      dates.add(p.date);
    }
  };
  daily(m.steps, T.steps, 'cum', (p) => ({ v: n(p.value) }));
  daily(m.active_calories, T.active, 'cum', (p) => ({ v: n(p.value) }));
  daily(m.distance ?? m.walking_running_distance, T.distance, 'cum', (p) => ({ v: n(p.value) }));
  daily(m.heart_rate, T.hr, 'disc', (p) => ({ v: n(p.average_bpm) ?? n(p.value), max: n(p.max_bpm) }));
  daily(m.resting_heart_rate, T.rhr, 'disc', (p) => ({ v: n(p.value) ?? n(p.average_bpm) }));
  daily(m.weight, T.weight, 'disc', (p) => ({ v: n(p.value) ?? n(p.kg) }));

  // Sleep: only totals per stage are known → back-to-back segments from bedtime, REM anchored to wake-up.
  const sleep: SleepSeg[] = [];
  const nights = new Set<string>();
  for (const p of m.sleep ?? []) {
    const bs = Date.parse(p?.bed_start), be = Date.parse(p?.bed_end);
    if (!Number.isFinite(bs) || !Number.isFinite(be) || be <= bs) continue;
    const st = p.stages ?? {};
    const min = (k: string) => Math.max(0, n(st[k]) ?? 0) * 60000;
    const seg = (stage: string, a: number, b: number, source = HX) => { if (b > a) sleep.push({ source, stage, startMs: a, endMs: b, startLocal: local(a), endLocal: local(b) }); };
    seg('inbed', bs, be, `${HX} inbed`);
    const core = min('core_min'), deep = min('deep_min'), rem = min('rem_min'), awake = min('awake_min');
    if (core + deep + rem === 0) { const asleep = (n(p.asleep_min) ?? 0) * 60000; seg('asleep', bs, Math.min(be, bs + asleep)); }
    else {
      let t = bs;
      seg('core', t, (t += core)); seg('deep', t, (t += deep)); seg('awake', t, Math.min(be - rem, t + awake));
      seg('rem', be - rem, be);
    }
    nights.add(nightKey(local(bs)));
    stats.nights++;
  }

  // Workouts: only the date is known → place them at noon, a few minutes apart.
  const workouts: Workout[] = [];
  const perDay = new Map<string, number>();
  const realOnDay = db.prepare(`SELECT 1 FROM workouts WHERE date = ? AND source NOT LIKE '${HX}%' AND ABS(COALESCE(duration_min,0) - ?) < 1.5 LIMIT 1`);
  for (const w of m.workouts ?? []) {
    if (!isDate(w?.date)) continue;
    const dur = n(w.duration_min);
    if (realOnDay.get(w.date, dur ?? 0)) continue; // already known with the exact start time
    const i = perDay.get(w.date) ?? 0;
    perDay.set(w.date, i + 1);
    const startLocal = `${w.date}T12:${String(i * 5).padStart(2, '0')}:00`;
    const startMs = Date.parse(startLocal + 'Z');
    workouts.push({
      source: `${HX}`, activity: camel(String(w.type || 'Other')), startLocal, endLocal: startLocal, startMs,
      durationMin: dur, distanceKm: n(w.distance_km), energyKcal: n(w.calories), hrAvg: n(w.avg_heart_rate) ?? n(w.average_bpm), hrMax: n(w.max_heart_rate) ?? n(w.max_bpm),
    });
    stats.workouts++;
  }

  tx(() => {
    writeHourly(hourly);
    if (nights.size) db.prepare(`DELETE FROM sleep_segments WHERE source IN ('${HX}', '${HX} inbed') AND night IN (${[...nights].map(() => '?').join(',')})`).run(...nights);
    writeSleep(sleep);
    writeWorkouts(workouts);
  });
  stats.days = dates.size;
  if (dates.size) { const d = [...dates].sort(); rebuildDaily(d[0], d.at(-1)!); }
  if (nights.size) { const ns = [...nights].sort(); rebuildSleep(addDays(ns[0], -1), ns.at(-1)!); }
  return stats;
}
