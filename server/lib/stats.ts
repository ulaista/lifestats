import { bucketKey, ms } from './period.ts';

export const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
export const mean = (a: number[]) => (a.length ? sum(a) / a.length : null);
export function median(a: number[]): number | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function sd(a: number[]): number | null {
  if (a.length < 2) return null;
  const m = mean(a)!;
  return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1));
}
export function quantile(a: number[], q: number): number | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
export function describe(a: number[]) {
  return {
    n: a.length, sum: sum(a), mean: mean(a), median: median(a), sd: sd(a),
    min: a.length ? Math.min(...a) : null, max: a.length ? Math.max(...a) : null,
    p10: quantile(a, 0.1), p90: quantile(a, 0.9),
  };
}

/** Least-squares slope per day (trend). */
export function slopePerDay(pts: { date: string; value: number }[]): number | null {
  if (pts.length < 5) return null;
  const xs = pts.map((p) => ms(p.date) / 86400000), ys = pts.map((p) => p.value);
  const mx = mean(xs)!, my = mean(ys)!;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? num / den : null;
}

export function rolling<T extends { date: string }>(pts: T[], get: (p: T) => number, n = 7) {
  const out: { date: string; value: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const w = pts.slice(Math.max(0, i - n + 1), i + 1).map(get);
    if (w.length >= Math.min(n, 3)) out.push({ date: pts[i].date, value: sum(w) / w.length });
  }
  return out;
}

/** Group daily points into buckets; aggregate = mean of daily values (or sum). */
export function bucketize<T extends { date: string }>(pts: T[], g: 'day' | 'week' | 'month', get: (p: T) => number, how: 'mean' | 'sum' = 'mean') {
  if (g === 'day') return pts.map((p) => ({ date: p.date, value: get(p) }));
  const m = new Map<string, number[]>();
  for (const p of pts) {
    const k = bucketKey(p.date, g);
    let a = m.get(k);
    if (!a) m.set(k, (a = []));
    a.push(get(p));
  }
  return [...m].map(([date, a]) => ({ date, value: how === 'sum' ? sum(a) : sum(a) / a.length }));
}

export function pctDelta(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}
