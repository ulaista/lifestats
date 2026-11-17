// iCalendar feed of the bot's own records, for "Add Subscribed Calendar" on the iPhone.
// The URL carries a secret derived from the bot token; events copied from iCloud are left out (no loops).
import crypto from 'node:crypto';
import * as P from './store.ts';

export const feedKey = (botToken: string) => crypto.createHash('sha256').update('lifestats-ics:' + botToken).digest('hex').slice(0, 32);

const TZ = process.env.APP_TZ || 'UTC';
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const dt = (local: string) => local.replace(/[-:]/g, '').slice(0, 13) + '00'; // 2026-11-17T15:00 → 20261117T150000
const d = (date: string) => date.replace(/-/g, '');
const plusMin = (local: string, m: number) => new Date(Date.parse(local + ':00Z') + m * 60000).toISOString().slice(0, 16);
const DAYS = ['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
function rrule(r: string | null): string | null {
  if (!r) return null;
  if (r === 'daily') return 'FREQ=DAILY';
  if (r === 'weekdays') return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  if (r === 'weekly') return 'FREQ=WEEKLY';
  if (r.startsWith('weekly:')) return 'FREQ=WEEKLY;BYDAY=' + r.slice(7).split(',').map((x) => DAYS[+x]).join(',');
  if (r === 'monthly') return 'FREQ=MONTHLY';
  if (r === 'yearly') return 'FREQ=YEARLY';
  return null;
}
/** RFC 5545 line folding (75 octets). */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 74) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

/** UTC offset of the owner's zone right now, e.g. +0300. */
function offset(): string {
  const now = new Date();
  const local = Date.parse(now.toLocaleString('sv-SE', { timeZone: TZ, hour12: false }).replace(' ', 'T') + 'Z');
  const min = Math.round((local - now.getTime()) / 60000);
  const sign = min >= 0 ? '+' : '-', a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`;
}

export function icsFeed(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const off = offset();
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//lifestats//planner//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:lifestats', `X-WR-TIMEZONE:${TZ}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M',
    'BEGIN:VTIMEZONE', `TZID:${TZ}`, 'BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${off}`, `TZOFFSETTO:${off}`, 'END:STANDARD', 'END:VTIMEZONE',
  ];
  for (const it of P.feedItems()) {
    const at = it.at!;
    const timed = at.length > 10;
    const title = `${it.status === 'done' ? '✅ ' : it.kind === 'task' ? '☑️ ' : ''}${it.title}`;
    const desc = [it.people ? `С кем: ${it.people}` : '', it.notes ?? '', 'Записано в lifestats'].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', `UID:lifestats-${it.id}@lifestats`, `DTSTAMP:${stamp}`);
    if (timed) {
      const end = it.end_at && it.end_at.length > 10 && it.end_at > at ? it.end_at : plusMin(at, it.kind === 'task' ? 15 : 60);
      lines.push(`DTSTART;TZID=${TZ}:${dt(at)}`, `DTEND;TZID=${TZ}:${dt(end)}`);
    } else {
      const next = new Date(Date.parse(at + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
      lines.push(`DTSTART;VALUE=DATE:${d(at)}`, `DTEND;VALUE=DATE:${d(next)}`, 'TRANSP:TRANSPARENT');
    }
    const rr = it.status === 'open' ? rrule(it.repeat) : null;
    if (rr) lines.push(`RRULE:${rr}`);
    lines.push(`SUMMARY:${esc(title)}`);
    if (it.place) lines.push(`LOCATION:${esc(it.place)}`);
    lines.push(`DESCRIPTION:${esc(desc)}`, `STATUS:${it.status === 'done' ? 'CONFIRMED' : 'CONFIRMED'}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
