import { db, tx, insertMany } from './db.ts';

/** Rebuild q_daily for [from, to] dates (inclusive). No args = everything. */
export function rebuildDaily(from = '0000-00-00', to = '9999-99-99') {
  tx(() => {
    db.prepare('DELETE FROM q_daily WHERE date >= ? AND date <= ?').run(from, to);
    db.prepare(`
      INSERT INTO q_daily(type, date, value, min, max, count)
      SELECT type, substr(hour, 1, 10) AS d,
             CASE WHEN kind = 'cum' THEN SUM(sum) ELSE SUM(sum) / SUM(count) END,
             MIN(min), MAX(max), SUM(count)
      FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY type, hour
          ORDER BY CASE WHEN kind = 'cum' THEN sum ELSE count END DESC, source
        ) AS rn
        FROM q_hourly h WHERE hour >= ? AND hour < ?
          -- daily totals from HealthExport only count on days nothing finer-grained covers
          AND NOT (source = 'HealthExport' AND EXISTS (SELECT 1 FROM q_hourly o WHERE o.type = h.type
            AND o.hour >= substr(h.hour, 1, 10) AND o.hour < substr(h.hour, 1, 10) || 'T99' AND o.source <> 'HealthExport'))
      )
      WHERE rn = 1
      GROUP BY type, d
    `).run(from, to + 'T99');
    // A day only partly covered by finer data (a Shortcut run mid-day) must not hide HealthExport's full-day total.
    db.prepare(`
      UPDATE q_daily SET value = (SELECT h.sum FROM q_hourly h WHERE h.type = q_daily.type AND h.source = 'HealthExport' AND h.hour = q_daily.date || 'T00' AND h.kind = 'cum')
      WHERE date >= ? AND date <= ? AND EXISTS (SELECT 1 FROM q_hourly h WHERE h.type = q_daily.type AND h.source = 'HealthExport'
        AND h.hour = q_daily.date || 'T00' AND h.kind = 'cum' AND h.sum > q_daily.value)
    `).run(from, to);
  });
}

type Iv = [number, number];

function unionMinutes(ivs: Iv[]): number {
  if (!ivs.length) return 0;
  ivs.sort((a, b) => a[0] - b[0]);
  let total = 0, [s, e] = ivs[0];
  for (let i = 1; i < ivs.length; i++) {
    const [a, b] = ivs[i];
    if (a > e) { total += e - s; s = a; e = b; } else if (b > e) e = b;
  }
  total += e - s;
  return total / 60000;
}

const ASLEEP = new Set(['asleep', 'core', 'deep', 'rem']);
const STAGED = new Set(['core', 'deep', 'rem']);

interface Seg { source: string; start_local: string; end_local: string; start_ms: number; end_ms: number; stage: string; night: string }

/** Rebuild sleep_nights for the given nights (or all). */
export function rebuildSleep(from = '0000-00-00', to = '9999-99-99') {
  const segs = db.prepare('SELECT * FROM sleep_segments WHERE night >= ? AND night <= ? ORDER BY night, start_ms').all(from, to) as unknown as Seg[];
  const byNight = new Map<string, Seg[]>();
  for (const s of segs) {
    let a = byNight.get(s.night);
    if (!a) byNight.set(s.night, (a = []));
    a.push(s);
  }
  const rows: unknown[][] = [];
  tx(() => {
    db.prepare('DELETE FROM sleep_nights WHERE night >= ? AND night <= ?').run(from, to);
    for (const [night, list] of byNight) {
      const bySource = new Map<string, Seg[]>();
      for (const s of list) {
        let a = bySource.get(s.source);
        if (!a) bySource.set(s.source, (a = []));
        a.push(s);
      }
      // Pick the source: one with sleep stages first, then the most asleep time.
      // Real samples beat HealthExport's per-night totals laid out as synthetic segments.
      let best: { source: string; segs: Seg[]; asleep: number; stages: boolean; real: boolean } | null = null;
      for (const [source, ss] of bySource) {
        const stages = ss.some((s) => s.stage === 'core' || s.stage === 'deep' || s.stage === 'rem');
        // Like Health: when a source has stages, its unstaged "asleep" samples (sleep schedule etc.) don't add up.
        const asleep = unionMinutes(ss.filter((s) => (stages ? STAGED : ASLEEP).has(s.stage)).map((s) => [s.start_ms, s.end_ms] as Iv));
        const real = !source.startsWith('HealthExport') && asleep > 0;
        const better = !best || (stages !== best.stages ? stages : real !== best.real ? real : asleep > best.asleep);
        if (better) best = { source, segs: ss, asleep, stages, real };
      }
      if (!best) continue;
      const of = (st: string) => unionMinutes(best!.segs.filter((s) => s.stage === st).map((s) => [s.start_ms, s.end_ms] as Iv));
      const sleepSegs = best.segs.filter((s) => (best!.stages ? STAGED : ASLEEP).has(s.stage));
      const inbedAll = list.filter((s) => s.stage === 'inbed').map((s) => [s.start_ms, s.end_ms] as Iv);
      let inbed = unionMinutes(inbedAll);
      const span = best.segs.length ? (Math.max(...best.segs.map((s) => s.end_ms)) - Math.min(...best.segs.map((s) => s.start_ms))) / 60000 : 0;
      if (!inbed) inbed = span;
      const first = sleepSegs.length ? sleepSegs.reduce((a, b) => (a.start_ms <= b.start_ms ? a : b)) : null;
      const last = sleepSegs.length ? sleepSegs.reduce((a, b) => (a.end_ms >= b.end_ms ? a : b)) : null;
      rows.push([
        night, best.source,
        first?.start_local ?? null, last?.end_local ?? null,
        sleepSegs.length ? best.asleep : null, inbed || null, of('awake'),
        of('core'), of('deep'), of('rem'), of('asleep'),
        best.stages ? 1 : 0,
      ]);
    }
    insertMany(`INSERT OR REPLACE INTO sleep_nights
      (night, source, bedtime, waketime, asleep_min, inbed_min, awake_min, core_min, deep_min, rem_min, unspecified_min, has_stages)`, rows);
  });
}
