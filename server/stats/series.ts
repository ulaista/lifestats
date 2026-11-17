// The daily series behind a section's chart (used by the Mini App and the widget).
import * as M from '../plan/money.ts';
import * as Q from './queries.ts';
import { T } from './queries.ts';
import type { Section } from './views.ts';
import { addDays, bucketKey, fmtDate, type Period } from '../lib/period.ts';
import { bucketize } from '../lib/stats.ts';
import { num, hm } from '../lib/format.ts';

const MON = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

export interface Series {
  name: string;
  /** Bar values (0 = no data). */ y: number[];
  /** Short axis labels. */ x: string[];
  /** Full bucket labels for tooltips. */ d: string[];
  /** Formatted values for tooltips. */ f: string[];
  /** Index of the bar for the selected day, or -1. */ hi: number;
  /** Mean of non-empty bars, formatted. */ avg: string | null;
  avgY: number | null;
  /** Sleep: per bar [deep, core, rem, awake] in hours (stacked like the Health app). */
  stack?: number[][];
  /** Heart rate: per bar daily minimum and maximum (range capsules). */
  lo?: number[];
  hiv?: number[];
}

export function series(section: Section, p: Period, opts: { maxBars?: number; dayContext?: number } = {}): Series {
  const maxBars = opts.maxBars ?? 31;
  const today = new Date().toLocaleDateString('sv-SE');
  const span = p.kind === 'day' ? { from: addDays(p.anchor, -(opts.dayContext ?? 13)), to: p.anchor } : { from: p.from, to: p.to < today ? p.to : today };
  const g: 'day' | 'month' = p.days > 62 ? 'month' : 'day';
  let pts: { date: string; value: number }[] = [];
  let name = '';
  let fmt = (v: number) => num(v, 0);
  if (section === 'sleep') { name = 'Сон за ночь'; fmt = (v) => hm(v * 60); pts = Q.nights(span.from, span.to).filter((n) => n.asleep_min).map((n) => ({ date: n.night, value: n.asleep_min! / 60 })); }
  else if (section === 'heart') {
    const rhr = Q.daily(T.rhr, span.from, span.to);
    if (rhr.length) { name = 'Пульс покоя, уд/мин'; fmt = (v) => num(v, 0); pts = rhr; }
    else { name = 'Пульс, уд/мин'; fmt = (v) => num(v, 0); pts = Q.daily(T.hr, span.from, span.to); }
  }
  else if (section === 'music') { name = 'Прослушивания'; pts = Q.music(span.from, span.to, 1).daily.map((d) => ({ date: d.date, value: d.plays })); }
  else if (section === 'workouts') { name = 'Минуты тренировок'; fmt = (v) => hm(v); const m = new Map<string, number>(); for (const w of Q.workouts(span.from, span.to)) m.set(w.date, (m.get(w.date) ?? 0) + (w.duration_min ?? 0)); pts = [...m].map(([date, value]) => ({ date, value })); }
  else if (section === 'money') { const cur = M.mainCurrency(span.from, span.to); name = `Расходы, ${M.CURRENCIES[cur] ?? cur}`; fmt = (v) => M.money(v, cur); pts = [...M.moneyStats(span.from, span.to, cur).byDay].map(([date, value]) => ({ date, value })); }
  else if (section === 'screen') { name = 'Экранное время'; fmt = (v) => hm(v); pts = Q.screentime(span.from, span.to).daily.map((d) => ({ date: d.date, value: d.minutes })); }
  else { name = g === 'month' ? 'Шаги в день (среднее за месяц)' : 'Шаги'; pts = Q.daily(T.steps, span.from, span.to); }
  if (g === 'month' && section !== 'steps' && section !== 'home') name += section === 'workouts' || section === 'music' || section === 'money' ? ' за месяц' : ' (среднее за месяц)';

  // Fill the whole domain so gaps show as gaps.
  const keys: string[] = [];
  for (let k = bucketKey(span.from, g); k <= span.to; ) {
    keys.push(k);
    if (g === 'day') k = addDays(k, 1);
    else { const d = new Date(k + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); k = d.toISOString().slice(0, 10); }
  }
  const sumUp = section === 'workouts' || section === 'music' || section === 'money';
  const agg = new Map(bucketize(pts, g, (x) => x.value, sumUp ? 'sum' : 'mean').map((b) => [b.date, b.value]));
  const sliced = keys.slice(-maxBars);
  const round = (v: number) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
  const y = sliced.map((k) => round(agg.get(k) ?? 0));
  // Extra shapes the Health app uses: stacked sleep stages, heart-rate ranges.
  let stack: number[][] | undefined, lo: number[] | undefined, hiv: number[] | undefined;
  if (section === 'sleep') {
    const acc = new Map<string, { n: number; v: number[] }>();
    for (const n of Q.nights(span.from, span.to)) {
      if (!n.asleep_min) continue;
      const k = bucketKey(n.night, g), a = acc.get(k) ?? { n: 0, v: [0, 0, 0, 0] };
      const staged = n.has_stages ? [n.deep_min, n.core_min, n.rem_min, n.awake_min] : [0, n.asleep_min, 0, n.awake_min];
      staged.forEach((x, i) => (a.v[i] += (x || 0) / 60));
      a.n++; acc.set(k, a);
    }
    stack = sliced.map((k) => { const a = acc.get(k); return a ? a.v.map((x) => Math.round((x / a.n) * 100) / 100) : [0, 0, 0, 0]; });
  }
  if (section === 'heart' && !pts.some((p) => (p as { min?: number }).min === undefined)) {
    const mins = new Map<string, number>(), maxs = new Map<string, number>();
    for (const p of pts as unknown as { date: string; min: number; max: number }[]) {
      const k = bucketKey(p.date, g);
      mins.set(k, Math.min(mins.get(k) ?? Infinity, p.min)); maxs.set(k, Math.max(maxs.get(k) ?? -Infinity, p.max));
    }
    lo = sliced.map((k) => Math.round(mins.get(k) ?? 0)); hiv = sliced.map((k) => Math.round(maxs.get(k) ?? 0));
  }
  const filled = y.filter((v) => v > 0);
  const avgY = filled.length ? filled.reduce((a, b) => a + b, 0) / filled.length : null;
  return {
    name,
    y,
    x: sliced.map((k) => (g === 'month' ? MON[+k.slice(5, 7) - 1] : String(+k.slice(8, 10)))),
    d: sliced.map((k) => (g === 'month' ? `${MONTHS[+k.slice(5, 7) - 1]} ${k.slice(0, 4)}` : fmtDate(k))),
    f: y.map((v) => (v > 0 ? fmt(v) : 'нет данных')),
    hi: p.kind === 'day' ? sliced.length - 1 : -1,
    avg: avgY === null ? null : fmt(avgY),
    avgY,
    ...(stack ? { stack } : {}),
    ...(lo ? { lo, hiv } : {}),
  };
}
