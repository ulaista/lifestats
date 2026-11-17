export type PeriodKind = 'day' | 'week' | 'month' | 'year' | 'all';

export interface Period {
  kind: PeriodKind;
  anchor: string; // YYYY-MM-DD
  from: string;
  to: string;
  label: string;
  days: number;
}

const DAY = 86400000;
export const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const ms = (d: string) => Date.parse(d + 'T00:00:00Z');
export const addDays = (d: string, n: number) => iso(ms(d) + n * DAY);
export const daysBetween = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY) + 1;

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const fmtDate = (d: string, withYear = true) => `${+d.slice(8, 10)} ${MONTHS_GEN[+d.slice(5, 7) - 1]}${withYear ? ' ' + d.slice(0, 4) : ''}`;
export const fmtShort = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
export const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
export const weekday = (d: string) => new Date(ms(d)).getUTCDay();

export function makePeriod(kind: PeriodKind, anchor: string, bounds: { first: string; last: string }): Period {
  let from: string, to: string, label: string;
  const y = anchor.slice(0, 4), m = +anchor.slice(5, 7);
  switch (kind) {
    case 'day':
      from = to = anchor;
      label = `${WEEKDAYS[weekday(anchor)]}, ${fmtDate(anchor)}`;
      break;
    case 'week': {
      const wd = (weekday(anchor) + 6) % 7; // Monday = 0
      from = addDays(anchor, -wd); to = addDays(from, 6);
      label = `${fmtDate(from, from.slice(0, 4) !== to.slice(0, 4))} — ${fmtDate(to)}`;
      break;
    }
    case 'month':
      from = `${y}-${String(m).padStart(2, '0')}-01`;
      to = addDays(iso(Date.UTC(+y, m, 1)), -1);
      label = `${MONTHS[m - 1]} ${y}`;
      break;
    case 'year':
      from = `${y}-01-01`; to = `${y}-12-31`; label = `${y} год`;
      break;
    default:
      from = bounds.first; to = bounds.last; label = from === to ? `всё время · ${fmtDate(from)}` : `всё время · с ${fmtDate(from)}`;
  }
  return { kind, anchor, from, to, label, days: daysBetween(from, to) };
}

export function shift(p: Period, dir: -1 | 1): string {
  switch (p.kind) {
    case 'day': return addDays(p.anchor, dir);
    case 'week': return addDays(p.anchor, 7 * dir);
    case 'month': { const d = new Date(ms(p.from)); d.setUTCMonth(d.getUTCMonth() + dir); return iso(d.getTime()); }
    case 'year': return `${+p.anchor.slice(0, 4) + dir}${p.anchor.slice(4)}`;
    default: return p.anchor;
  }
}

/** The equal-length period right before p (for deltas). */
export function previous(p: Period, bounds: { first: string; last: string }): Period | null {
  if (p.kind === 'all') return null;
  return makePeriod(p.kind, shift(p, -1), bounds);
}

/** Chart granularity for the period. */
export function grain(p: Period): 'day' | 'week' | 'month' {
  if (p.days > 800) return 'month';
  if (p.days > 120) return 'week';
  return 'day';
}

/** For a single-day period, charts show this much context. */
export function chartRange(p: Period): { from: string; to: string } {
  if (p.kind === 'day') return { from: addDays(p.anchor, -29), to: p.anchor };
  return { from: p.from, to: p.to };
}

export function bucketKey(d: string, g: 'day' | 'week' | 'month'): string {
  if (g === 'day') return d;
  if (g === 'month') return d.slice(0, 7) + '-01';
  return addDays(d, -((weekday(d) + 6) % 7));
}
