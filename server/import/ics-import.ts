// Calendars by iCal link (Google Calendar "secret address in iCal format", iCloud public calendar, Outlook ICS…):
// the server fetches them itself every hour — no phone automation needed, works on Android and iPhone alike.
// Links come from CALENDAR_ICS_URLS (env) and/or the /ical bot command (stored in the database; they are secrets).
import { kvGet, kvSet } from '../db.ts';
import { syncCalendar, todayLocal, type ExtEvent } from '../plan/store.ts';
import { addDays } from '../lib/time.ts';

// ---------------------------------------------------------------- links

const norm = (u: string) => u.trim().replace(/^webcals?:\/\//i, 'https://');
export function icsUrls(): string[] {
  const env = (process.env.CALENDAR_ICS_URLS || '').split(/[\s,]+/).filter(Boolean);
  let saved: string[] = [];
  try { saved = JSON.parse(kvGet('calendar:ics_urls') || '[]'); } catch { /* none */ }
  return [...new Set([...env, ...saved].map(norm).filter((u) => /^https:\/\//i.test(u)))];
}
export function addIcsUrl(u: string): string[] {
  const url = norm(u);
  if (!/^https:\/\/\S+$/i.test(url)) throw new Error('Нужна ссылка вида https://… или webcal://…');
  let saved: string[] = [];
  try { saved = JSON.parse(kvGet('calendar:ics_urls') || '[]'); } catch { /* none */ }
  if (!saved.includes(url)) saved.push(url);
  kvSet('calendar:ics_urls', JSON.stringify(saved));
  return icsUrls();
}
export function removeIcsUrl(n: number): string[] {
  let saved: string[] = [];
  try { saved = JSON.parse(kvGet('calendar:ics_urls') || '[]'); } catch { /* none */ }
  const url = icsUrls()[n - 1];
  if (!url || !saved.includes(url)) throw new Error('Нет такой ссылки (ссылки из CALENDAR_ICS_URLS меняются в настройках сервера)');
  kvSet('calendar:ics_urls', JSON.stringify(saved.filter((x) => x !== url)));
  return icsUrls();
}
/** "calendar.google.com/…/basic.ics" → "calendar.google.com/…ics" — never show the secret part. */
export const maskUrl = (u: string) => { try { const x = new URL(u); return `${x.host}/…${x.pathname.slice(-4)}`; } catch { return '…'; } };

// ---------------------------------------------------------------- time zones

function tzOffsetMs(ms: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number }
/** Wall-clock time in `tz` (IANA name; unknown or floating → the server's own zone) → UTC ms. */
function wallToMs(w: Wall, tz: string | null): number {
  if (tz) {
    try {
      const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
      let ms = guess - tzOffsetMs(guess, tz);
      ms = guess - tzOffsetMs(ms, tz); // second pass settles DST edges
      return ms;
    } catch { /* not an IANA zone (e.g. Outlook "Russian Standard Time") — fall through */ }
  }
  return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime();
}
const plusDays = (w: Wall, n: number): Wall => { const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + n)); return { ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const plusMonths = (w: Wall, n: number): Wall | null => {
  const t = new Date(Date.UTC(w.y, w.mo - 1 + n, 1)), last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return w.d > last ? null : { ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1 }; // 31st in a short month: no occurrence (RFC 5545)
};
const weekday = (w: Wall) => new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
const dateKey = (w: Wall) => `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;

// ---------------------------------------------------------------- parsing

interface Prop { name: string; params: Record<string, string>; value: string }
function props(block: string[]): Prop[] {
  return block.map((line) => {
    const i = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const head = line.slice(0, i), value = line.slice(i + 1);
    const [name, ...ps] = head.split(';');
    const params: Record<string, string> = {};
    for (const p of ps) { const [k, v = ''] = p.split('='); params[k.toUpperCase()] = v.replace(/^"|"$/g, ''); }
    return { name: name.toUpperCase(), params, value };
  });
}
const unescape = (s: string) => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

interface When { wall: Wall; tz: string | null; utc: boolean; allDay: boolean }
function when(p: Prop | undefined): When | null {
  if (!p) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(p.value.trim());
  if (!m) return null;
  const allDay = p.params.VALUE === 'DATE' || !m[4];
  return { wall: { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) }, tz: m[7] ? 'UTC' : p.params.TZID ?? null, utc: Boolean(m[7]), allDay };
}
const durationMs = (v: string) => {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
};
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Occurrence starts (wall clock in the event's zone) of a recurring event within [from, to] dates. */
function expand(start: Wall, rrule: string, from: string, to: string): Wall[] {
  const r = Object.fromEntries(rrule.split(';').map((kv) => kv.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
  const freq = r.FREQ, interval = Math.max(1, Number(r.INTERVAL) || 1), count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = r.UNTIL ? r.UNTIL.slice(0, 4) + '-' + r.UNTIL.slice(4, 6) + '-' + r.UNTIL.slice(6, 8) : '9999-12-31';
  const byday = (r.BYDAY || '').split(',').map((d: string) => DAYS.indexOf(d.replace(/^[+-]?\d+/, ''))).filter((d: number) => d >= 0);
  const out: Wall[] = [];
  let n = 0;
  const take = (w: Wall) => { if (dateKey(w) < dateKey(start)) return true; n++; if (n > count || dateKey(w) > until) return false; if (dateKey(w) >= from && dateKey(w) <= to) out.push(w); return true; };
  for (let i = 0; i < 3000; i++) {
    if (freq === 'DAILY') { if (!take(plusDays(start, i * interval))) break; }
    else if (freq === 'WEEKLY') {
      const weekStart = plusDays(start, i * 7 * interval - ((weekday(start) + 6) % 7)); // Monday of that week
      const days = byday.length ? byday : [weekday(start)];
      let stop = false;
      for (const d of [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))) { if (!take(plusDays(weekStart, (d + 6) % 7))) { stop = true; break; } }
      if (stop) break;
    } else if (freq === 'MONTHLY') { const w = plusMonths(start, i * interval); if (w && !take(w)) break; }
    else if (freq === 'YEARLY') { const w = plusMonths(start, i * 12 * interval); if (w && !take(w)) break; }
    else break;
    if (dateKey(plusDays(start, i * (freq === 'DAILY' ? interval : freq === 'WEEKLY' ? 7 * interval : 28 * interval))) > to) break;
  }
  return out;
}

/** Events of one .ics file that fall in [today − 1 day, today + 31 days], recurring ones expanded. */
export function parseIcs(text: string, from = addDays(todayLocal(), -1), to = addDays(todayLocal(), 31)): ExtEvent[] {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const calName = unescape(lines.find((l) => l.startsWith('X-WR-CALNAME:'))?.slice(13) ?? '') || null;
  const blocks: Prop[][] = [];
  let cur: string[] | null = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') cur = [];
    else if (l === 'END:VEVENT' && cur) { blocks.push(props(cur)); cur = null; }
    else if (cur) cur.push(l);
  }
  const get = (b: Prop[], n: string) => b.find((p) => p.name === n);
  // Moved/edited single occurrences (RECURRENCE-ID) replace the generated ones.
  const overridden = new Set(blocks.filter((b) => get(b, 'RECURRENCE-ID')).map((b) => `${get(b, 'UID')?.value}|${get(b, 'RECURRENCE-ID')!.value.slice(0, 8)}`));
  const out: ExtEvent[] = [];
  for (const b of blocks) {
    if (/cancel/i.test(get(b, 'STATUS')?.value ?? '')) continue;
    const st = when(get(b, 'DTSTART'));
    if (!st) continue;
    const en = when(get(b, 'DTEND'));
    const startMs0 = st.allDay ? 0 : wallToMs(st.wall, st.tz);
    const dur = en ? (st.allDay ? 0 : wallToMs(en.wall, en.tz) - startMs0) : durationMs(get(b, 'DURATION')?.value ?? '') || (st.allDay ? 0 : 3600_000);
    const title = unescape(get(b, 'SUMMARY')?.value ?? '') || 'Без названия';
    const location = unescape(get(b, 'LOCATION')?.value ?? '') || null;
    const uid = get(b, 'UID')?.value ?? '';
    const ex = new Set(b.filter((p) => p.name === 'EXDATE').flatMap((p) => p.value.split(',')).map((v) => v.slice(0, 8)));
    const rrule = get(b, 'RRULE')?.value;
    const starts = rrule && !get(b, 'RECURRENCE-ID') ? expand(st.wall, rrule, from, to) : [st.wall].filter((w) => dateKey(w) >= from && dateKey(w) <= to);
    for (const w of starts) {
      const ymd = dateKey(w).replace(/-/g, '');
      if (ex.has(ymd) || (rrule && overridden.has(`${uid}|${ymd}`))) continue;
      if (st.allDay) { out.push({ title, start: dateKey(w), allDay: true, location, calendar: calName }); continue; }
      const ms = wallToMs(w, st.tz);
      out.push({ title, start: new Date(ms).toISOString(), end: new Date(ms + Math.max(0, dur)).toISOString(), allDay: false, location, calendar: calName });
    }
  }
  return out;
}

/** Fetches every linked calendar and replaces the copied upcoming events (source 'ics', read-only in the bot). */
export async function syncIcs(): Promise<{ events: number; errors: string[] }> {
  const urls = icsUrls();
  if (!urls.length) return { events: 0, errors: [] };
  const all: ExtEvent[] = [], errors: string[] = [];
  for (const u of urls) {
    try {
      const res = await fetch(u, { headers: { 'user-agent': 'lifestats (calendar sync)', accept: 'text/calendar' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('это не календарь .ics');
      all.push(...parseIcs(text));
    } catch (e) { errors.push(`${maskUrl(u)}: ${(e as Error).message}`); }
  }
  if (errors.length === urls.length) { kvSet('calendar:ics:error', errors.join('; ')); return { events: 0, errors }; } // keep old events if every fetch failed
  const r = syncCalendar(all, 'ics');
  kvSet('calendar:ics:error', errors.join('; '));
  return { events: r.events, errors };
}
