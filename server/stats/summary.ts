// Health-app style "Summary": one card per category with its colour, the key number and a small trend.
import * as Q from './queries.ts';
import { T } from './queries.ts';
import { series } from './series.ts';
import type { Section } from './views.ts';
import { addDays, type Period } from '../lib/period.ts';
import { mean, sum, pctDelta } from '../lib/stats.ts';
import { num, hm, plural } from '../lib/format.ts';

/** Category colours, as in Apple Health / Fitness / Music. */
export const COLORS: Record<Section, string> = {
  home: '#007AFF', plan: '#AF52DE', money: '#A2845E', steps: '#FF9500', sleep: '#30B0C7', heart: '#FF2D55', workouts: '#34C759', music: '#FA2D48', screen: '#5856D6',
};

export interface SummaryItem { s: Section; name: string; icon: string; color: string; value: string; sub: string; delta: number | null; good: boolean | null; spark: number[] }

export function summary(p: Period, prev: Period | null): SummaryItem[] {
  const many = p.days > 1;
  const out: SummaryItem[] = [];
  const spark = (s: Section) => series(s, p, { maxBars: 14, dayContext: 6 }).y;
  const avgOf = (type: string, from: string, to: string, how: 'mean' | 'sum' = 'mean') => {
    const v = Q.daily(type, from, to).map((x) => x.value);
    return v.length ? (how === 'sum' ? sum(v) : mean(v)) : null;
  };
  const delta = (type: string) => (prev ? pctDelta(avgOf(type, p.from, p.to), avgOf(type, prev.from, prev.to)) : null);
  const per = many ? ' в день' : '';

  const steps = avgOf(T.steps, p.from, p.to);
  if (steps !== null) {
    const km = avgOf(T.distance, p.from, p.to);
    out.push({ s: 'steps', name: 'Шаги', icon: '🔥', color: COLORS.steps, value: `${num(steps, 0)} ${plural(Math.round(steps), 'шаг', 'шага', 'шагов')}`, sub: many ? 'в среднем за день' + (km ? ` · ${num(km, 1)} км` : '') : (km ? `${num(km, 1)} км` : ''), delta: delta(T.steps), good: true, spark: spark('steps') });
  }
  const act = avgOf(T.active, p.from, p.to);
  if (act !== null) out.push({ s: 'steps', name: 'Активная энергия', icon: '🔥', color: '#FF3B30', value: `${num(act, 0)} ккал`, sub: many ? 'в среднем за день' : '', delta: delta(T.active), good: true, spark: Q.daily(T.active, p.kind === 'day' ? addDays(p.anchor, -6) : p.from, p.to).map((x) => Math.round(x.value)).slice(-14) });

  const ns = Q.nights(p.from, p.to).filter((n) => n.asleep_min);
  if (ns.length) {
    const sl = mean(ns.map((n) => n.asleep_min!));
    const pns = prev ? Q.nights(prev.from, prev.to).filter((n) => n.asleep_min) : [];
    out.push({ s: 'sleep', name: 'Сон', icon: '🛏', color: COLORS.sleep, value: hm(sl), sub: many ? 'в среднем за ночь' : 'время сна', delta: pns.length >= ns.length * 0.8 ? pctDelta(sl, mean(pns.map((n) => n.asleep_min!))) : null, good: true, spark: spark('sleep') });
  }

  const rhr = avgOf(T.rhr, p.from, p.to), hr = Q.daily(T.hr, p.from, p.to);
  if (rhr !== null || hr.length) {
    const avg = rhr ?? mean(hr.map((x) => x.value));
    const max = hr.length ? Math.max(...hr.map((x) => x.max)) : null;
    out.push({ s: 'heart', name: rhr !== null ? 'Пульс покоя' : 'Пульс', icon: '❤️', color: COLORS.heart, value: `${num(avg, 0)} уд/мин`, sub: (many ? 'в среднем' : 'средний') + (max ? ` · макс ${num(max, 0)}` : ''), delta: delta(rhr !== null ? T.rhr : T.hr), good: false, spark: spark('heart') });
  }

  const ws = Q.workouts(p.from, p.to);
  if (ws.length) {
    const mins = sum(ws.map((w) => w.duration_min ?? 0));
    out.push({ s: 'workouts', name: 'Тренировки', icon: '🏃', color: COLORS.workouts, value: `${ws.length} · ${hm(mins)}`, sub: `${ws.length} ${plural(ws.length, 'тренировка', 'тренировки', 'тренировок')}` + (sum(ws.map((w) => w.distance_km ?? 0)) ? ` · ${num(sum(ws.map((w) => w.distance_km ?? 0)), 1)} км` : ''), delta: null, good: null, spark: spark('workouts') });
  }

  const m = Q.music(p.from, p.to, 1);
  if (m.totals.plays) out.push({ s: 'music', name: 'Музыка', icon: '🎵', color: COLORS.music, value: `${num(m.totals.plays, 0)} ${plural(m.totals.plays, 'трек', 'трека', 'треков')}`, sub: m.topArtists[0] ? `чаще всего ${m.topArtists[0].artist}` : '', delta: null, good: null, spark: spark('music') });

  const st = Q.screentime(p.from, p.to);
  if (st.daily.length) out.push({ s: 'screen', name: 'Экранное время', icon: '📱', color: COLORS.screen, value: hm(mean(st.daily.map((d) => d.minutes))), sub: per ? 'в среднем за день' : '', delta: null, good: null, spark: spark('screen') });
  return out;
}
