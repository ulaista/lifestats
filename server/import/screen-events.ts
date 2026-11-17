// iPhone screen time from Shortcuts automations: "App is opened / is closed" → POST /screen {app[, event]}.
// iOS has no Screen Time API, so sessions are rebuilt from these events:
//   • one automation per app with both "Opened" and "Closed" ticked sends just the app name — the event is
//     inferred (open if the app isn't running, close if it is);
//   • only one app is in the foreground, so opening another app ends the current session;
//   • a session never longer than 3 h; one left open (missed "closed") counts as 30 min.
// Daily totals land in the `screentime` table (device 'iPhone'), which the Screen tab already reads.
import { db, kvGet, kvSet, tx } from '../db.ts';
import { addDays } from '../lib/time.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS screen_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  start_local TEXT NOT NULL,
  ended_by TEXT NOT NULL            -- close | switch | timeout
);
CREATE INDEX IF NOT EXISTS screen_sessions_start ON screen_sessions(start_local);
`);

const MAX_MS = 3 * 3600_000, STALE_MS = 30 * 60_000, LATE_CLOSE_MS = 15_000;
const DEVICE = 'iPhone';

function local(ms: number): string {
  return new Date(ms).toLocaleString('sv-SE', { hour12: false }).replace(' ', 'T').slice(0, 19);
}
interface Open { app: string; start: number }
const getJson = <T>(k: string): T | null => { try { return JSON.parse(kvGet(k) || 'null'); } catch { return null; } };

export function cleanApp(s: unknown): string {
  return String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
}

/** Splits [a, b) at local midnights → minutes per date. (A date-time without offset parses as local time.) */
function perDate(a: number, b: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let t = a; t < b;) {
    const d = local(t).slice(0, 10), end = Math.min(b, Date.parse(addDays(d, 1) + 'T00:00:00'));
    out.set(d, (out.get(d) ?? 0) + (end - t) / 60000);
    t = Math.max(end, t + 1);
  }
  return out;
}

/** Recomputes the iPhone rows of `screentime` for these dates from the sessions. */
function rebuild(dates: string[]) {
  if (!dates.length) return;
  const rows = db.prepare(`SELECT app, start_ms, end_ms FROM screen_sessions WHERE substr(start_local, 1, 10) BETWEEN ? AND ?`)
    .all(addDays(dates[0], -1), dates.at(-1)!) as { app: string; start_ms: number; end_ms: number }[];
  const want = new Set(dates), tot = new Map<string, number>();
  for (const s of rows) for (const [d, m] of perDate(s.start_ms, s.end_ms)) if (want.has(d)) tot.set(`${d}|${s.app}`, (tot.get(`${d}|${s.app}`) ?? 0) + m);
  tx(() => {
    db.prepare(`DELETE FROM screentime WHERE device = ? AND date IN (${dates.map(() => '?').join(',')})`).run(DEVICE, ...dates);
    const ins = db.prepare('INSERT OR REPLACE INTO screentime (date, device, app, category, minutes) VALUES (?,?,?,?,?)');
    for (const [k, m] of tot) { const i = k.indexOf('|'); ins.run(k.slice(0, i), DEVICE, k.slice(i + 1), null, Math.round(m * 10) / 10); }
  });
}

function endSession(o: Open, endMs: number, by: string): string[] {
  const end = Math.max(o.start, Math.min(endMs, o.start + MAX_MS));
  if (end - o.start < 1000) return [];
  db.prepare('INSERT INTO screen_sessions (app, start_ms, end_ms, start_local, ended_by) VALUES (?,?,?,?,?)').run(o.app, o.start, end, local(o.start), by);
  return [...perDate(o.start, end).keys()];
}

export function screenEvent(appRaw: unknown, eventRaw?: unknown, now = Date.now()) {
  const app = cleanApp(appRaw);
  if (!app) throw new Error('app is required');
  const ev = String(eventRaw ?? '').toLowerCase();
  const open = getJson<Open>('screen:open');
  const auto = getJson<{ app: string; at: number }>('screen:auto');
  const isOpen = open && open.app === app && now - open.start < MAX_MS;
  let event: 'open' | 'close' | 'ignored';
  if (/clos|закр|end|stop/.test(ev)) event = isOpen ? 'close' : 'ignored';
  else if (/open|откр|start/.test(ev)) event = isOpen ? 'ignored' : 'open';
  else if (isOpen) event = 'close';
  else if (auto && auto.app === app && now - auto.at < LATE_CLOSE_MS) event = 'ignored'; // its "closed" after we switched away
  else event = 'open';

  const dates: string[] = [];
  if (event === 'close') { dates.push(...endSession(open!, now, 'close')); kvSet('screen:open', 'null'); }
  if (event === 'open') {
    if (open) {
      const stale = now - open.start >= MAX_MS;
      dates.push(...endSession(open, stale ? open.start + STALE_MS : now, stale ? 'timeout' : 'switch'));
      if (!stale && open.app !== app) kvSet('screen:auto', JSON.stringify({ app: open.app, at: now }));
    }
    kvSet('screen:open', JSON.stringify({ app, start: now }));
  }
  if (event !== 'ignored') kvSet('screentime:last', new Date(now).toISOString());
  rebuild([...new Set(dates)].sort());
  return { app, event };
}

/** Per-period details for the Screen tab: opens, sessions, hours of the day. */
export function screenStats(from: string, to: string) {
  const ss = db.prepare(`SELECT app, start_ms, end_ms, start_local FROM screen_sessions WHERE substr(start_local, 1, 10) BETWEEN ? AND ? ORDER BY start_ms`)
    .all(from, to) as { app: string; start_ms: number; end_ms: number; start_local: string }[];
  const byApp = new Map<string, { opens: number; ms: number; longest: number }>();
  const byHour = new Array(24).fill(0);
  let longest: { app: string; min: number; at: string } | null = null;
  for (const s of ss) {
    const a = byApp.get(s.app) ?? { opens: 0, ms: 0, longest: 0 };
    a.opens++; a.ms += s.end_ms - s.start_ms; a.longest = Math.max(a.longest, s.end_ms - s.start_ms);
    byApp.set(s.app, a);
    for (let t = s.start_ms; t < s.end_ms;) {
      const l = local(t), next = Math.min(s.end_ms, Date.parse(l.slice(0, 13) + ':00:00') + 3600_000);
      byHour[Number(l.slice(11, 13))] += (next - t) / 60000;
      t = Math.max(next, t + 1);
    }
    const min = (s.end_ms - s.start_ms) / 60000;
    if (!longest || min > longest.min) longest = { app: s.app, min, at: s.start_local };
  }
  return { sessions: ss.length, byApp, byHour, longest, open: getJson<Open>('screen:open') };
}
