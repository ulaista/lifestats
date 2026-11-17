const nf = (d: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: 0 });
const cache = [0, 1, 2, 3].map(nf);

export function num(v: number | null | undefined, digits?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const d = digits ?? (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2);
  return cache[Math.min(3, d)].format(v);
}

/** Minutes → "7 ч 32 мин" */
export function hm(min: number | null | undefined): string {
  if (min === null || min === undefined || !Number.isFinite(min)) return '—';
  const t = Math.round(min), h = Math.floor(t / 60), m = t - h * 60;
  return h ? `${h} ч ${String(m).padStart(2, '0')} мин` : `${m} мин`;
}
/** Minutes → "7:32" */
export function hmShort(min: number | null | undefined): string {
  if (min === null || min === undefined || !Number.isFinite(min)) return '—';
  const t = Math.round(min), h = Math.floor(t / 60), m = t - h * 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
/** Minutes-of-day (may exceed 1440 or be negative) → "23:41" */
export function clock(minOfDay: number | null | undefined): string {
  if (minOfDay === null || minOfDay === undefined || !Number.isFinite(minOfDay)) return '—';
  const m = ((Math.round(minOfDay) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
export function pct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits).replace('.', ',')}%`;
}
export function signedPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '';
  const s = (v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0).replace('.', ',');
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${s.replace('-', '')}%`;
}
export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
