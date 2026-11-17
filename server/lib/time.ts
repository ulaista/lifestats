// Apple Health dates look like "2024-01-15 23:12:00 +0300".
// We keep the *local wall-clock* (where the sample was recorded) for grouping
// by day/hour, and a UTC epoch (ms) for durations and ordering.

export interface ParsedTs {
  local: string; // "2024-01-15T23:12:00"
  epoch: number; // ms UTC
}

export function parseHkDate(s: string): ParsedTs | null {
  if (!s || s.length < 19) return null;
  const y = +s.slice(0, 4), mo = +s.slice(5, 7), d = +s.slice(8, 10);
  const h = +s.slice(11, 13), mi = +s.slice(14, 16), se = +s.slice(17, 19);
  if (Number.isNaN(y + mo + d + h + mi + se)) return null;
  let offMin = 0;
  const tz = s.slice(19).trim();
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
  if (m) offMin = (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
  else if (tz === 'Z' || tz === '') offMin = 0;
  const wall = Date.UTC(y, mo - 1, d, h, mi, se);
  return { local: `${s.slice(0, 10)}T${s.slice(11, 19)}`, epoch: wall - offMin * 60000 };
}

/** Wall-clock string → pseudo-epoch (treating wall clock as UTC); handy for date math on local times. */
export function wallMs(local: string): number {
  return Date.UTC(+local.slice(0, 4), +local.slice(5, 7) - 1, +local.slice(8, 10), +local.slice(11, 13) || 0, +local.slice(14, 16) || 0, +local.slice(17, 19) || 0);
}

export function wallIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

export function addDays(date: string, n: number): string {
  return wallIso(wallMs(date + 'T00:00:00') + n * 86400000).slice(0, 10);
}

/** Night key: a sleep segment belongs to the date of (start + 6h) — i.e. the morning you wake up. */
export function nightKey(localStart: string): string {
  return wallIso(wallMs(localStart) + 6 * 3600000).slice(0, 10);
}
