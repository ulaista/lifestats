// Mini App backend: one static page + a tiny JSON API, bound to 127.0.0.1 only.
// Every API request must carry Telegram's signed initData from the bot's owner.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { checkInitData } from './auth.ts';
import { kvGet } from '../db.ts';
import { onUpdate } from '../events.ts';
import { buildScreen, periodFor, availableSections, SECTIONS, KINDS, type Section } from '../stats/views.ts';
import { series } from '../stats/series.ts';
import { summary, COLORS } from '../stats/summary.ts';
import * as Q from '../stats/queries.ts';
import { shift, type PeriodKind } from '../lib/period.ts';
import * as R from '../plan/routines.ts';
import { dayLabel } from '../plan/store.ts';
import * as P from '../plan/store.ts';
import * as B from '../plan/budget.ts';
import * as M from '../plan/money.ts';
import { addDays } from '../lib/time.ts';
import { getDigest } from '../plan/digest.ts';

const PAGE = path.join(import.meta.dirname, 'index.html');
const VALID_SECTIONS = new Set(SECTIONS.map(([s]) => s));
const VALID_KINDS = new Set(KINDS.map(([k]) => k));

let version = 1;
const waiters = new Set<() => void>();
onUpdate(() => { version++; for (const w of waiters) w(); waiters.clear(); });

const NOW_PREV: Record<string, [string, string]> = { day: ['Сегодня', 'вчера'], week: ['На этой неделе', 'прошлую неделю'], month: ['В этом месяце', 'прошлый месяц'], year: ['В этом году', 'прошлый год'] };

/** With fallback, an empty current period opens the previous one (with a notice) instead of a blank page. */
export function view(section: Section, kind: PeriodKind, offset: number, ver = version, fallback = false): ReturnType<typeof viewExact> & { notice?: string } {
  const v = viewExact(section, kind, offset, ver);
  if (!fallback || offset !== 0 || !v.empty || !NOW_PREV[kind] || !v.hasOlder) return v;
  const pv = viewExact(section, kind, 1, ver);
  if (pv.empty) return v;
  return { ...pv, notice: `${NOW_PREV[kind][0]} данных пока нет — показываю ${NOW_PREV[kind][1]}.` };
}

function viewExact(section: Section, kind: PeriodKind, offset: number, ver = version) {
  let anchor: string | undefined;
  let p = periodFor(kind).period;
  for (let i = 0; i < offset; i++) { anchor = shift(p, -1); p = periodFor(kind, anchor).period; }
  const sc = buildScreen(section, kind, anchor);
  const pv = periodFor(kind, anchor).prev;
  const sync = Q.syncTimes();
  const np = Q.nowPlaying();
  const earliest = periodFor(kind).bounds.first;
  return {
    v: { s: section, k: kind, o: offset },
    ver,
    title: sc.title,
    period: sc.period.label,
    from: sc.period.from, to: sc.period.to, days: sc.period.days,
    hasOlder: kind !== 'all' && sc.period.from > earliest,
    sections: ((avail) => SECTIONS.filter(([s]) => avail.includes(s)))(availableSections()),
    kinds: KINDS,
    kpis: sc.kpis.map((k) => ({ l: k.label, v: k.value, d: k.delta == null || !Number.isFinite(k.delta) ? null : k.delta, g: k.goodWhenUp ?? null, n: k.note || null, s: k.sheet || null })),
    color: COLORS[section],
    summary: section === 'home' && !sc.empty ? summary(sc.period, pv) : null,
    hyp: section === 'sleep' && kind === 'day' ? hypnogram(sc.period.anchor) : null,
    chart: sc.empty || section === 'home' || section === 'plan' ? null : series(section, sc.period, { maxBars: 62, dayContext: 29 }),
    blocks: section === 'plan' ? [] : sc.blocks.slice(2), // heading + KPI table are rendered as cards; the plan comes as lists
    plan: section === 'plan' && !sc.empty ? planLists(sc.period.from, sc.period.to) : null,
    empty: sc.empty ?? null,
    routines: section === 'plan' ? routinesView() : null,
    money: section === 'money' && offset === 0 ? moneyExtras() : null,
    digests: section === 'home' && offset === 0 ? { morning: getDigest('morning'), evening: getDigest('evening') } : null,
    np: np ? `${np.artist} — ${np.title}` : null,
    sync,
  };
}

const when = (local: string) => `${dayLabel(local.slice(0, 10))}${local.length > 10 ? ' ' + local.slice(11, 16) : ''}`;

/** The assistant's routines for the Plan tab (with controls in the Mini App). */
export function routinesView() {
  return R.listRoutines().map((r) => ({
    id: r.id, kind: r.kind, title: r.title, on: Boolean(r.enabled),
    when: R.scheduleLabel(r), channels: r.channels ? r.channels.split(',').map((c) => '@' + c).join(', ') : null,
    next: r.enabled && r.next_run ? when(r.next_run) : null,
    last: r.last_run ? when(r.last_run) : null, result: r.last_result ? r.last_result.split('\n')[0].slice(0, 240) : null,
  }));
}

/** Mini App buttons: run now, pause, resume, delete. */
export function routineAction(id: number, action: string) {
  if (action === 'run') R.runNow(id);
  else if (action === 'off') R.updateRoutine(id, { enabled: false });
  else if (action === 'on') R.updateRoutine(id, { enabled: true });
  else if (action === 'del') R.deleteRoutine(id);
  else throw new Error('bad action');
  return routinesView();
}

/** The Plan tab as native lists: the agenda on the page, one list per KPI in a sheet. */
function planLists(from: string, to: string) {
  const today = P.todayLocal();
  const src = (it: P.Item) => (it.source === 'reminders' ? 'Напоминания' : it.source === 'icloud' || it.source === 'ics' ? 'Календарь' : '');
  const row = (it: P.Item) => ({
    id: it.id, ic: P.iconOf(it), t: it.title, done: it.status === 'done', pr: it.priority > 0, kind: it.kind, src: it.source ?? '', at: it.at ?? '', rep: it.repeat ? 1 : 0,
    date: it.at ? it.at.slice(0, 10) : '', day: it.at ? dayLabel(it.at.slice(0, 10), today) : 'Без срока',
    time: P.timeOf(it) || (it.at ? 'весь день' : ''), sub: [it.people, it.place, src(it)].filter(Boolean).join(' · '),
  });
  const items = P.findItems({ status: 'all', from, to }, 300).filter((x) => x.kind !== 'note' && x.status !== 'cancelled')
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  const done = P.doneIn(from, to).map((d) => {
    const it = P.getItem(d.item_id);
    return { id: d.item_id, ic: it ? P.iconOf(it) : '✅', t: d.title, done: true, pr: false, date: d.at.slice(0, 10), day: dayLabel(d.at.slice(0, 10), today), time: d.at.slice(11, 16), sub: 'отмечено' };
  });
  return {
    agenda: items.map(row),
    events: items.filter((x) => x.kind === 'event').map(row),
    tasks: items.filter((x) => x.kind === 'task').map(row),
    done,
    open: P.openTasks().map(row),
    overdue: P.overdue().map(row),
  };
}

/** Mini App buttons on a plan item: done / undo / move / delete. */
export function itemAction(id: number, action: string, to?: string | null) {
  const it = P.getItem(id);
  if (!it) throw new Error('Запись не найдена');
  if (action === 'done') return P.updateItem(id, { status: 'done' });
  if (action === 'undo') return P.updateItem(id, { status: 'open' });
  if (action === 'del') { P.deleteItem(id); return null; }
  if (action === 'move') {
    const today = P.todayLocal();
    const day = to === 'today' ? today : to === 'tomorrow' ? addDays(today, 1) : to === 'after' ? addDays(today, 2) : to === 'week' ? addDays(it.at && it.at.slice(0, 10) > today ? it.at.slice(0, 10) : today, 7)
      : /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(String(to)) ? String(to) : null;
    if (!day) throw new Error('Куда перенести?');
    // A date alone keeps the item's time of day.
    const at = day.length > 10 ? day : it.at && it.at.length > 10 ? `${day}T${it.at.slice(11)}` : day;
    return P.updateItem(id, { at });
  }
  throw new Error('bad action');
}

/** Money tab extras: budgets of this month and subscriptions. */
function moneyExtras() {
  const subs = B.subsView(), monthly = B.subsMonthly();
  return {
    budgets: B.budgetStatus().map((b) => ({ c: b.category, ic: b.icon, spent: M.money(b.spent, b.currency), limit: M.money(b.amount, b.currency), left: M.money(Math.max(0, b.left), b.currency), pct: b.pct })),
    subs, subsTotal: Object.entries(monthly).map(([c, v]) => M.money(Math.round(v), c)).join(' + '),
  };
}

/** One night's stages as minutes from bedtime (for the Health-style hypnogram). */
function hypnogram(night: string) {
  const segs = Q.sleepSegments(night).filter((x) => x.stage !== 'inbed');
  if (!segs.length) return null;
  const ms = (t: string) => Date.parse(t + 'Z');
  const t0 = Math.min(...segs.map((x) => ms(x.start_local)));
  return {
    start: segs.reduce((a, b) => (a.start_local < b.start_local ? a : b)).start_local.slice(11, 16),
    end: segs.reduce((a, b) => (a.end_local > b.end_local ? a : b)).end_local.slice(11, 16),
    segs: segs.map((x) => ({ st: x.stage === 'asleep' ? 'core' : x.stage, a: Math.round((ms(x.start_local) - t0) / 60000), b: Math.round((ms(x.end_local) - t0) / 60000) })),
  };
}

export const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org",
};

export function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Only the bot's owner, with a fresh Telegram signature, may read the API. */
export function authorize(header: string | undefined, botToken: string): { code: number; error: string } | null {
  const auth = header ?? '';
  const user = auth.startsWith('tma ') ? checkInitData(auth.slice(4), botToken) : null;
  if (!user) return { code: 401, error: 'Открой дашборд из Telegram-бота.' };
  const owner = Number(kvGet('tg:owner') || 0);
  if (!owner || user.id !== owner) return { code: 403, error: 'Это личный дашборд.' };
  return null;
}

/** Parses and validates /api/view parameters. */
export function viewParams(url: URL): { s: Section; k: PeriodKind; o: number } | null {
  const s = url.searchParams.get('s') as Section, k = url.searchParams.get('k') as PeriodKind;
  const o = Math.max(0, Math.min(500, Number(url.searchParams.get('o')) || 0));
  return VALID_SECTIONS.has(s) && VALID_KINDS.has(k) ? { s, k, o } : null;
}

export function startAppServer(port: number, botToken: string): Promise<void> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method !== 'GET') return json(res, 405, { error: 'method' });
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(PAGE));
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    const denied = authorize(req.headers.authorization, botToken);
    if (denied) return json(res, denied.code, { error: denied.error });

    try {
      if (url.pathname === '/api/view') {
        const v = viewParams(url);
        if (!v) return json(res, 400, { error: 'bad view' });
        return json(res, 200, view(v.s, v.k, v.o));
      }
      if (url.pathname === '/api/wait') {
        // Long poll: answers as soon as new data lands, or after 25 s.
        if (Number(url.searchParams.get('ver')) !== version) return json(res, 200, { ver: version });
        let done = false;
        const finish = () => { if (done) return; done = true; waiters.delete(finish); clearTimeout(t); json(res, 200, { ver: version }); };
        const t = setTimeout(finish, 25_000);
        waiters.add(finish);
        req.on('close', () => { if (!done) { done = true; waiters.delete(finish); clearTimeout(t); } });
        return;
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[app]', e);
      return json(res, 500, { error: 'Ошибка на сервере' });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { console.log(`[app] Mini App: http://127.0.0.1:${port}`); resolve(); });
  });
}
