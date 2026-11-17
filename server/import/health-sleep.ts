// Sleep straight from Apple Health via an iPhone Shortcut ("Find Health Samples → Sleep Analysis"),
// so last night shows up right away instead of waiting for HealthExport's once-a-day file.
// One sample per line: start|end|value|source (dates in ISO 8601 with time).
import { db, tx } from '../db.ts';
import { rebuildDaily, rebuildSleep } from '../derive.ts';
import { writeHourly, writeSleep, type SleepSeg } from './store.ts';
import { T } from '../stats/queries.ts';
import { addDays, nightKey } from '../lib/time.ts';

function local(ms: number): string {
  return new Date(ms).toLocaleString('sv-SE', { hour12: false }).replace(' ', 'T').slice(0, 19);
}

/** "Asleep Core" / "Deep" / "В кровати" … → our stage names; null for anything unknown. */
export function stageOf(v: string): string | null {
  const s = v.toLowerCase();
  if (/deep|глуб/.test(s)) return 'deep';
  if (/rem|быстр/.test(s)) return 'rem';
  if (/core|основ|ядр|light|легк|лёгк/.test(s)) return 'core';
  if (/awake|бодр|проб/.test(s)) return 'awake';
  if (/bed|кроват|постел/.test(s)) return 'inbed';
  if (/asleep|sleep|unspec|сон|сплю/.test(s)) return 'asleep';
  return null;
}

export function parseSleepText(text: string): SleepSeg[] {
  const out: SleepSeg[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [a, b, value = '', ...rest] = line.split('|').map((x) => x.trim());
    const startMs = Date.parse(a ?? ''), endMs = Date.parse(b ?? '');
    const stage = stageOf(value);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !stage) continue;
    if (endMs - startMs > 24 * 3600000) continue;
    const device = rest.join('|').trim() || 'iPhone';
    out.push({ source: `Health: ${device}`, stage, startMs, endMs, startLocal: local(startMs), endLocal: local(endMs) });
  }
  return out;
}

/** Replaces the posted sources' segments for the nights covered, then rebuilds those nights. */
export function syncSleep(segs: SleepSeg[]): { samples: number; nights: string[] } {
  if (!segs.length) return { samples: 0, nights: [] };
  const nights = [...new Set(segs.map((s) => nightKey(s.startLocal)))].sort();
  const sources = [...new Set(segs.map((s) => s.source))];
  tx(() => {
    db.prepare(`DELETE FROM sleep_segments WHERE source IN (${sources.map(() => '?').join(',')}) AND night IN (${nights.map(() => '?').join(',')})`)
      .run(...sources, ...nights);
    writeSleep(segs);
  });
  rebuildSleep(addDays(nights[0], -1), nights.at(-1)!);
  return { samples: segs.length, nights };
}

// ── Activity: steps / active energy / distance samples, same line format (start|end|value|source).
// Stored per hour and source; rebuildDaily keeps the biggest source per hour, which is how Health de-duplicates
// iPhone + Watch.
export const ACTIVITY: Record<string, string> = { steps: T.steps, energy: T.active, distance: T.distance };

/** "1 234", "1,234", "12,5", "0.8 km" → number. */
export function num(v: string): number | null {
  let s = v.replace(/[\s  ]/g, '').replace(/[^\d.,-]/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const n = Number(s);
  return s && Number.isFinite(n) ? n : null;
}

export function syncActivity(field: string, text: string): { samples: number; days: string[] } {
  const type = ACTIVITY[field];
  if (!type) return { samples: 0, days: [] };
  const agg = new Map<string, { hour: string; source: string; sum: number; count: number }>();
  let samples = 0;
  for (const line of text.split(/\r?\n/)) {
    const [a, b, value = '', ...rest] = line.split('|').map((x) => x.trim());
    const startMs = Date.parse(a ?? ''), endMs = Date.parse(b ?? '');
    const v = num(value);
    if (!Number.isFinite(startMs) || v === null || v <= 0) continue;
    if (Number.isFinite(endMs) && endMs - startMs > 2 * 3600000) continue; // day-level totals would break the hourly split
    const hour = local(startMs).slice(0, 13);
    const source = `Health: ${rest.join('|').trim() || 'iPhone'}`;
    const k = `${hour}|${source}`;
    const g = agg.get(k) ?? { hour, source, sum: 0, count: 0 };
    g.sum += v; g.count++; samples++;
    agg.set(k, g);
  }
  if (!agg.size) return { samples: 0, days: [] };
  const rows = [...agg.values()];
  const days = [...new Set(rows.map((r) => r.hour.slice(0, 10)))].sort();
  const sources = [...new Set(rows.map((r) => r.source))];
  tx(() => {
    // The posted window replaces what these sources sent before for those hours.
    const hours = [...new Set(rows.map((r) => r.hour))];
    db.prepare(`DELETE FROM q_hourly WHERE type = ? AND source IN (${sources.map(() => '?').join(',')}) AND hour IN (${hours.map(() => '?').join(',')})`)
      .run(type, ...sources, ...hours);
    writeHourly(rows.map((r) => ({ type, hour: r.hour, source: r.source, kind: 'cum', sum: r.sum, min: r.sum, max: r.sum, count: r.count })));
  });
  rebuildDaily(days[0], days.at(-1)!);
  return { samples, days };
}

/** POST /health body: { sleep?, steps?, energy?, distance? } — each a text of sample lines. */
export function syncHealth(data: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  if (typeof data.sleep === 'string') out.sleep = syncSleep(parseSleepText(data.sleep));
  for (const f of Object.keys(ACTIVITY)) if (typeof data[f] === 'string') out[f] = syncActivity(f, data[f] as string);
  return out;
}
