// Builds one "screen" (section × period) as text: a rich message (headings + tables) and an HTML fallback.
// Also exposes the same numbers as JSON for the Mini App and widgets.
import * as P from '../plan/store.ts';
import * as M from '../plan/money.ts';
import * as Q from './queries.ts';
import { screenStats } from '../import/screen-events.ts';
import { T } from './queries.ts';
import { db } from '../db.ts';
import { makePeriod, previous, addDays, daysBetween, fmtDate, WEEKDAYS, weekday, type Period, type PeriodKind } from '../lib/period.ts';
import { describe, mean, sum, sd, pctDelta } from '../lib/stats.ts';
import { num, hm, hmShort, clock, pct, plural } from '../lib/format.ts';

export type Section = 'home' | 'plan' | 'money' | 'sleep' | 'steps' | 'heart' | 'workouts' | 'music' | 'screen';
export const SECTIONS: [Section, string][] = [['home', '📊 Обзор'], ['plan', '🗓 План'], ['money', '💸 Деньги'], ['sleep', '😴 Сон'], ['steps', '🚶 Шаги'], ['heart', '❤️ Сердце'], ['workouts', '🏋️ Спорт'], ['music', '🎧 Музыка'], ['screen', '📱 Экран']];
export const KINDS: [PeriodKind, string][] = [['day', 'День'], ['week', 'Нед.'], ['month', 'Мес.'], ['year', 'Год'], ['all', 'Всё']];

export type RichBlock = Record<string, unknown>;
export interface Kpi { label: string; value: string; delta?: number | null; goodWhenUp?: boolean; note?: string; sheet?: string }
export interface Screen { title: string; period: Period; kpis: Kpi[]; blocks: RichBlock[]; html: string; empty?: string }

const h = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function periodFor(kind: PeriodKind, anchor?: string) {
  const b = Q.bounds();
  const today = new Date().toLocaleDateString('sv-SE');
  const bounds = { first: b.first ?? today, last: b.last && b.last > today ? b.last : today };
  const period = makePeriod(kind, anchor && anchor <= bounds.last ? anchor : bounds.last, bounds);
  let prev = previous(period, bounds);
  if (prev && daysBetween(prev.from > bounds.first ? prev.from : bounds.first, prev.to) < prev.days * 0.8) prev = null;
  if (prev && period.to > bounds.last) {
    const elapsed = Math.max(1, daysBetween(period.from, bounds.last));
    prev = { ...prev, to: addDays(prev.from, elapsed - 1), days: elapsed };
  }
  return { period, prev, bounds, hasData: Boolean(b.first) };
}

/** Sections with anything to show (others are hidden from the keyboard). */
// One query instead of eight, and remembered for half a minute (it was run for every tab on every screen).
let availCache: { at: number; v: Section[] } | null = null;
export function availableSections(): Section[] {
  if (availCache && Date.now() - availCache.at < 30_000) return availCache.v;
  const r = (db.prepare(`SELECT
    EXISTS(SELECT 1 FROM plan_items) OR EXISTS(SELECT 1 FROM routines) AS xa,
    EXISTS(SELECT 1 FROM expenses) AS xb,
    EXISTS(SELECT 1 FROM sleep_nights) AS xc,
    EXISTS(SELECT 1 FROM q_daily WHERE type = '${T.steps}') AS xd,
    EXISTS(SELECT 1 FROM q_daily WHERE type IN ('${T.rhr}', '${T.hr}')) AS xe,
    EXISTS(SELECT 1 FROM workouts) AS xf,
    EXISTS(SELECT 1 FROM screentime) AS xg`).get() ?? {}) as Record<string, number>;
  const out: Section[] = ['home'];
  if (r.xa) out.push('plan');
  if (r.xb) out.push('money');
  if (r.xc) out.push('sleep');
  if (r.xd) out.push('steps');
  if (r.xe) out.push('heart');
  if (r.xf) out.push('workouts');
  out.push('music');
  if (r.xg) out.push('screen');
  availCache = { at: Date.now(), v: out };
  return out;
}

// ---------- rich blocks
const cell = (t: string, header = false, align: 'left' | 'right' = 'left') => ({ text: t, ...(header ? { is_header: true } : {}), align });
export function table(head: string[], rows: string[][]): RichBlock {
  return { type: 'table', is_compact: true, is_striped: true, cells: [head.map((x, i) => cell(x, true, i ? 'right' : 'left')), ...rows.map((r) => r.map((x, i) => cell(x, false, i ? 'right' : 'left')))] };
}
const heading = (text: string, size = 2): RichBlock => ({ type: 'heading', text, size });
const para = (text: unknown): RichBlock => ({ type: 'paragraph', text });
const details = (summary: string, blocks: RichBlock[]): RichBlock => ({ type: 'details', summary, blocks });

export function deltaText(d: number | null | undefined, goodWhenUp?: boolean): string {
  if (d === null || d === undefined || !Number.isFinite(d)) return '';
  const arrow = Math.abs(d) < 0.005 ? '→' : d > 0 ? '↑' : '↓';
  const mark = goodWhenUp === undefined || Math.abs(d) < 0.005 ? '' : (d > 0) === goodWhenUp ? ' 🟢' : ' 🟠';
  return `${arrow} ${Math.abs(d * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0).replace('.', ',')}%${mark}`;
}
const kpiTable = (k: Kpi[]) => table(['Показатель', 'Значение', 'Δ'], k.map((x) => [x.label, x.note ? `${x.value} · ${x.note}` : x.value, deltaText(x.delta, x.goodWhenUp) || '—']));

function pre(rows: string[][]): string {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ')).join('\n');
}

/** Rich blocks → HTML (fallback when rich messages aren't accepted). */
export function blocksToHtml(blocks: RichBlock[]): string {
  const txt = (t: unknown): string => (typeof t === 'string' ? h(t) : Array.isArray(t) ? t.map(txt).join('') : t && typeof t === 'object' ? txt((t as { text: unknown }).text) : '');
  const out: string[] = [];
  for (const b of blocks as Record<string, any>[]) {
    if (b.type === 'heading') out.push(b.size === 1 ? `<b>${txt(b.text)}</b>` : `\n<b>${txt(b.text)}</b>`);
    else if (b.type === 'paragraph') out.push(txt(b.text));
    else if (b.type === 'table') out.push(`<pre>${h(pre(b.cells.map((r: any[]) => r.map((c) => (typeof c.text === 'string' ? c.text : '')))))}</pre>`);
    else if (b.type === 'details') out.push(`<blockquote expandable><b>${txt(b.summary)}</b>\n${blocksToHtml(b.blocks)}</blockquote>`);
  }
  return out.join('\n');
}

function values(type: string, from: string, to: string) { return Q.daily(type, from, to); }
function cmp(type: string, p: Period, prev: Period | null, how: 'mean' | 'sum' = 'mean') {
  const cur = values(type, p.from, p.to).map((x) => x.value);
  const pv = prev ? values(type, prev.from, prev.to).map((x) => x.value) : [];
  const agg = (a: number[]) => (a.length ? (how === 'sum' ? sum(a) : mean(a)) : null);
  const ok = pv.length >= Math.max(1, cur.length * 0.8);
  return { cur: agg(cur), prev: ok ? agg(pv) : null, values: cur, n: cur.length };
}
function dryRows(list: [string, number[], number][]): string[][] {
  return list.filter(([, v]) => v.length).map(([label, v, dg]) => { const s = describe(v); return [label, num(s.mean, dg), num(s.median, dg), num(s.sd, dg), num(s.min, dg), num(s.max, dg)]; });
}
const dry = (rows: string[][]) => (rows.length ? [details('Сухие цифры', [table(['', 'Ср', 'Мед', 'σ', 'Мин', 'Макс'], rows)])] : []);

interface Built { title: string; kpis: Kpi[]; extra: RichBlock[]; empty?: string }

// ---------------------------------------------------------------- sections

function home(p: Period, prev: Period | null, hasData: boolean): Built {
  const title = p.kind === 'day' ? (p.anchor === new Date().toLocaleDateString('sv-SE') ? 'Сегодня' : 'День') : 'Обзор';
  if (!hasData) return { title, kpis: [], extra: [], empty: 'Данных пока нет. Здоровье приходит с iPhone (HealthExport + команда), музыка — из Last.fm.' };
  const many = p.days > 1;
  const st = cmp(T.steps, p, prev), km = cmp(T.distance, p, prev, 'sum'), act = cmp(T.active, p, prev), rhr = cmp(T.rhr, p, prev), hrv = cmp(T.hrv, p, prev);
  const ns = Q.nights(p.from, p.to).filter((n) => n.asleep_min), pns = prev ? Q.nights(prev.from, prev.to).filter((n) => n.asleep_min) : [];
  const sl = mean(ns.map((n) => n.asleep_min!)), psl = pns.length && pns.length >= ns.length * 0.8 ? mean(pns.map((n) => n.asleep_min!)) : null;
  const ws = Q.workouts(p.from, p.to);
  const m = Q.music(p.from, p.to, 1);
  const kpis: Kpi[] = [
    { label: many ? '🚶 Шаги/день' : '🚶 Шаги', value: num(st.cur, 0), delta: pctDelta(st.cur, st.prev), goodWhenUp: true },
    { label: '📏 Дистанция', value: `${num(km.cur, 1)} км`, delta: pctDelta(km.cur, km.prev), goodWhenUp: true },
    { label: many ? '😴 Сон/ночь' : '😴 Сон', value: hm(sl), delta: pctDelta(sl, psl), goodWhenUp: true },
    { label: '❤️ Пульс покоя', value: `${num(rhr.cur, 0)} уд/мин`, delta: pctDelta(rhr.cur, rhr.prev), goodWhenUp: false },
    { label: '〰️ ВСР', value: `${num(hrv.cur, 0)} мс`, delta: pctDelta(hrv.cur, hrv.prev), goodWhenUp: true },
    { label: many ? '🔥 Активные ккал/день' : '🔥 Активные ккал', value: num(act.cur, 0), delta: pctDelta(act.cur, act.prev), goodWhenUp: true },
    { label: '🏋️ Тренировки', value: `${ws.length}`, note: ws.length ? hm(sum(ws.map((w) => w.duration_min ?? 0))) : '' },
    { label: '🎧 Музыка', value: `${num(m.totals.plays, 0)} ${plural(m.totals.plays, 'трек', 'трека', 'треков')}`, note: m.topArtists[0]?.artist ?? '' },
  ].filter((k) => k.value !== '—' && !k.value.startsWith('— '));
  const r = Q.records();
  const extra: RichBlock[] = [
    ...dry(dryRows([['Шаги', st.values, 0], ['Км', values(T.distance, p.from, p.to).map((x) => x.value), 1], ['Ккал', act.values, 0], ['Сон, ч', ns.map((n) => n.asleep_min! / 60), 1], ['Пульс покоя', rhr.values, 0], ['ВСР', hrv.values, 0]]).filter(() => many)),
    details('Рекорды за всё время', [table(['Рекорд', 'Значение', 'Когда'], [
      ['Шаги за день', num(r.maxSteps?.value ?? null, 0), r.maxSteps ? fmtDate(r.maxSteps.date) : '—'],
      ['Дистанция', r.maxDistance ? `${num(r.maxDistance.value, 1)} км` : '—', r.maxDistance ? fmtDate(r.maxDistance.date) : '—'],
      ['Самый долгий сон', hm(r.longestSleep?.value ?? null), r.longestSleep ? fmtDate(r.longestSleep.date) : '—'],
      ['Мин. пульс покоя', r.minRhr ? `${num(r.minRhr.value, 0)} уд/мин` : '—', r.minRhr ? fmtDate(r.minRhr.date) : '—'],
      ['Макс. ВСР', r.maxHrv ? `${num(r.maxHrv.value, 0)} мс` : '—', r.maxHrv ? fmtDate(r.maxHrv.date) : '—'],
      ['Серия 10 000+', `${r.streak10k.best} дн.`, `сейчас ${r.streak10k.current}`],
      ['Всего шагов', num(r.totalSteps, 0), ''],
      ['Всего пройдено', `${num(r.totalKm, 0)} км`, ''],
    ])]),
  ];
  return { title, kpis, extra };
}

function moneyView(p: Period, prev: Period | null): Built {
  const title = 'Деньги';
  const today = new Date().toLocaleDateString('sv-SE');
  const to = p.to < today ? p.to : today;
  const s = M.moneyStats(p.from, to);
  if (!s.count && !s.others.length) return { title, kpis: [], extra: [], empty: 'Трат за этот период нет. Напиши боту: «кофе 350», «такси 600 вчера», «обед 1200 и метро 70».' };
  const ps = prev ? M.moneyStats(prev.from, prev.to, s.currency) : null;
  const first = (db.prepare('SELECT MIN(date) AS d FROM expenses').get() as { d: string | null }).d ?? p.from;
  const days = Math.max(1, daysBetween(first > p.from ? first : p.from, to)); // tracking may have started mid-period
  const top = s.byCat[0];
  const kpis: Kpi[] = [
    { label: 'Потрачено', value: M.money(s.total, s.currency), delta: ps && ps.total ? pctDelta(s.total, ps.total) : null, goodWhenUp: false },
    ...(p.days > 1 ? [{ label: 'В среднем в день', value: M.money(s.total / days, s.currency) }] : []),
    { label: 'Покупок', value: `${s.count}` },
    ...(top ? [{ label: 'Больше всего', value: `${M.catIcon(top[0])} ${top[0]}`, note: `${Math.round((top[1] / (s.total || 1)) * 100)}%` }] : []),
    ...s.others.map((o) => ({ label: `Ещё в ${M.CURRENCIES[o.currency] ?? o.currency}`, value: M.money(o.s, o.currency), note: `${o.n} ${plural(o.n, 'покупка', 'покупки', 'покупок')}` })),
  ];
  const extra: RichBlock[] = [
    heading('По категориям', 3),
    table(['Категория', 'Сумма', 'Доля'], s.byCat.map(([c, v]) => [`${M.catIcon(c)} ${c}`, M.money(v, s.currency), `${Math.round((v / (s.total || 1)) * 100)}%`])),
    details(`Все траты (${s.count})`, [table(['Что', 'Сумма', 'Когда'], s.rows.slice(0, 100).map((e) => [`${M.catIcon(e.category)} ${e.note || e.category}`, M.money(e.amount, e.currency), P.dayLabel(e.date, today)]))]),
  ];
  return { title, kpis, extra };
}

function planView(p: Period): Built {
  const title = 'План';
  const today = P.todayLocal();
  const items = P.findItems({ status: 'all', from: p.from, to: p.to }, 300).filter((x) => x.kind !== 'note' && x.status !== 'cancelled');
  const st = P.stats(p.from, p.to < today ? p.to : today);
  const od = P.overdue(), nodate = P.undated();
  if (!items.length && !od.length && !nodate.length) return { title, kpis: [], extra: [], empty: 'За этот период дел нет. Напиши боту или надиктуй: «завтра в 15 созвон с Ромой».' };
  const kpis: Kpi[] = [
    { label: '📅 Встречи', value: `${items.filter((x) => x.kind === 'event').length}`, note: st.eventMin ? hm(st.eventMin) : '', sheet: 'events' },
    { label: '☑️ Задачи', value: `${items.filter((x) => x.kind === 'task').length}`, sheet: 'tasks' },
    { label: '✅ Сделано', value: `${st.done}`, sheet: 'done' },
    { label: '📌 Открыто', value: `${st.open}`, sheet: 'open' },
    ...(od.length ? [{ label: '⚠️ Просрочено', value: `${od.length}`, sheet: 'overdue' }] : []),
  ];
  const row = (it: P.Item) => [`${P.iconOf(it)} ${it.title}${it.status === 'done' ? ' ✅' : ''}${it.priority ? ' ❗️' : ''}`, P.timeOf(it) || 'весь день', [it.people, it.place].filter(Boolean).join(' · ') || ''];
  const days = [...new Set(items.filter((x) => x.at).map((x) => x.at!.slice(0, 10)))].sort();
  const extra: RichBlock[] = [];
  for (const d of days.slice(0, 31)) {
    const list = items.filter((x) => x.at?.startsWith(d));
    extra.push(heading(P.dayLabel(d, today).replace(/^./, (c) => c.toUpperCase()), 3), table(['Дело', 'Время', 'Где / с кем'], list.map(row)));
  }
  if (od.length) extra.push(details(`⚠️ Просрочено (${od.length})`, [table(['Задача', 'Срок', ''], od.map((it) => [it.title, P.dayLabel(it.at!.slice(0, 10), today), '']))]));
  if (nodate.length) extra.push(details(`📌 Без срока (${nodate.length})`, [table(['Задача', '', ''], nodate.map((it) => [it.title + (it.priority ? ' ❗️' : ''), '', '']))]));
  return { title, kpis, extra };
}

const minOfDay = (iso: string | null) => (iso ? +iso.slice(11, 13) * 60 + +iso.slice(14, 16) : null);
const bedMin = (n: Q.Night) => { const m = minOfDay(n.bedtime); return m === null ? null : m < 720 ? m + 1440 : m; };
const wakeMin = (n: Q.Night) => { const m = minOfDay(n.waketime); return m === null ? null : m > 1080 ? m - 1440 : m; };
const nn = (a: (number | null)[]) => a.filter((x): x is number => x !== null && Number.isFinite(x));
export function sleepSum(ns: Q.Night[]) {
  const s = ns.filter((n) => n.asleep_min);
  const st = s.filter((n) => n.has_stages);
  const tot = (k: keyof Q.Night) => st.reduce((a, n) => a + ((n[k] as number) || 0), 0);
  const all = tot('deep_min') + tot('core_min') + tot('rem_min');
  return {
    n: s.length, asleep: mean(s.map((n) => n.asleep_min!)), inbed: mean(nn(s.map((n) => n.inbed_min))),
    eff: mean(nn(s.map((n) => (n.inbed_min ? Math.min(1, n.asleep_min! / n.inbed_min) : null)))),
    bed: mean(nn(s.map(bedMin))), wake: mean(nn(s.map(wakeMin))), bedSd: sd(nn(s.map(bedMin))),
    ge7: s.length ? s.filter((n) => n.asleep_min! >= 420).length / s.length : null,
    deep: all ? tot('deep_min') / all : null, rem: all ? tot('rem_min') / all : null, core: all ? tot('core_min') / all : null,
    awake: mean(st.map((n) => n.awake_min)),
  };
}

function sleep(p: Period, prev: Period | null): Built {
  const cur = Q.nights(p.from, p.to), S = sleepSum(cur);
  if (!S.n) {
    const last = Q.lastNight();
    const hint = last && last.night < p.from ? ` Последняя ночь в базе — ${fmtDate(last.night, false)} (${hmShort(last.asleep_min)}).` : '';
    return { title: 'Сон', kpis: [], extra: [], empty: `За этот период данных о сне нет.${hint}` };
  }
  const P = prev ? sleepSum(Q.nights(prev.from, prev.to)) : null;
  const okP = P && P.n && P.n >= S.n * 0.8 ? P : null;
  const kpis: Kpi[] = [
    { label: p.days > 1 ? 'Сон за ночь' : 'Сон', value: hm(S.asleep), delta: pctDelta(S.asleep, okP?.asleep ?? null), goodWhenUp: true },
    { label: 'В кровати', value: hm(S.inbed) },
    { label: 'Эффективность', value: pct(S.eff) },
    { label: 'Отбой → подъём', value: `${clock(S.bed)} → ${clock(S.wake)}`, note: S.bedSd !== null && p.days > 1 ? `±${Math.round(S.bedSd)} мин` : '' },
    { label: 'Глубокий / REM', value: `${pct(S.deep)} / ${pct(S.rem)}` },
    ...(p.days > 1 ? [{ label: 'Ночей ≥ 7 ч', value: pct(S.ge7), note: `из ${S.n}` }] : []),
    { label: 'Пробуждения', value: `${num(S.awake, 0)} мин` },
  ];
  const wdRows = [1, 2, 3, 4, 5, 6, 0].map((wd) => { const s = sleepSum(cur.filter((n) => weekday(n.night) === wd)); return [WEEKDAYS[wd], String(s.n), hmShort(s.asleep), clock(s.bed), clock(s.wake)]; }).filter((r) => r[1] !== '0');
  const extra: RichBlock[] = [
    ...(p.days >= 7 && wdRows.length ? [details('По дням недели', [table(['День', 'Ночей', 'Сон', 'Отбой', 'Подъём'], wdRows)])] : []),
    ...(p.days > 1 && p.days <= 31 ? [details('Все ночи', [table(['Ночь', 'Сон', 'Отбой', 'Подъём'], cur.filter((n) => n.asleep_min).map((n) => [fmtDate(n.night, false), hmShort(n.asleep_min), clock(minOfDay(n.bedtime)), clock(minOfDay(n.waketime))]))])] : []),
  ];
  return { title: 'Сон', kpis, extra };
}

function stepsView(p: Period, prev: Period | null): Built {
  const many = p.days > 1;
  const st = cmp(T.steps, p, prev), km = cmp(T.distance, p, prev, 'sum'), act = cmp(T.active, p, prev), ex = cmp(T.exercise, p, prev), fl = cmp(T.flights, p, prev);
  if (!st.n) return { title: 'Активность', kpis: [], extra: [], empty: 'За этот период шагов нет.' };
  const ge10 = st.values.filter((v) => v >= 10000).length;
  const kpis: Kpi[] = [
    { label: many ? 'Шаги/день' : 'Шаги', value: num(st.cur, 0), delta: pctDelta(st.cur, st.prev), goodWhenUp: true },
    ...(many ? [{ label: 'Шагов всего', value: num(sum(st.values), 0) }, { label: 'Дней 10 000+', value: `${ge10} из ${st.n}` }] : []),
    { label: 'Дистанция', value: `${num(km.cur, 1)} км`, delta: pctDelta(km.cur, km.prev), goodWhenUp: true },
    { label: many ? 'Активные ккал/день' : 'Активные ккал', value: num(act.cur, 0), delta: pctDelta(act.cur, act.prev), goodWhenUp: true },
    { label: many ? 'Упражнения/день' : 'Упражнения', value: `${num(ex.cur, 0)} мин`, delta: pctDelta(ex.cur, ex.prev), goodWhenUp: true },
    { label: 'Пролёты', value: num(fl.cur, 0) },
  ];
  const rg = Q.rings(p.from, p.to);
  const closed = (a: number | null, b: number | null) => (a !== null && b ? a >= b : null);
  const share = (f: (x: (typeof rg)[number]) => boolean | null) => { const v = rg.map(f).filter((x) => x !== null); return v.length ? v.filter(Boolean).length / v.length : null; };
  const wd = [1, 2, 3, 4, 5, 6, 0].map((w) => { const v = values(T.steps, p.from, p.to).filter((x) => weekday(x.date) === w).map((x) => x.value); return [WEEKDAYS[w], num(mean(v), 0)]; });
  const extra: RichBlock[] = [
    ...(many ? dry(dryRows([['Шаги', st.values, 0], ['Км', values(T.distance, p.from, p.to).map((x) => x.value), 1], ['Ккал', act.values, 0], ['Упражнения', ex.values, 0]])) : []),
    ...(rg.length ? [details('Кольца активности', [table(['Кольцо', 'Закрыто'], [['Подвижность', pct(share((x) => closed(x.move_kcal, x.move_goal)))], ['Упражнения', pct(share((x) => closed(x.exercise_min, x.exercise_goal)))], ['С разминкой', pct(share((x) => closed(x.stand_hours, x.stand_goal)))]])])] : []),
    ...(p.days >= 7 ? [details('По дням недели', [table(['День', 'Шаги в среднем'], wd)])] : []),
  ];
  return { title: 'Активность', kpis, extra };
}

function heart(p: Period, prev: Period | null): Built {
  const rhr = cmp(T.rhr, p, prev), hrv = cmp(T.hrv, p, prev), walk = cmp(T.walkHr, p, prev), spo2 = cmp(T.spo2, p, prev), resp = cmp(T.resp, p, prev);
  const avg = cmp(T.hr, p, prev);
  const hr = values(T.hr, p.from, p.to);
  if (!rhr.n && !hr.length) return { title: 'Сердце', kpis: [], extra: [], empty: 'За этот период данных о пульсе нет.' };
  const vo2 = values(T.vo2, '0000-00-00', p.to).at(-1);
  const top = hr.length ? hr.reduce((a, b) => (b.max > a.max ? b : a)) : null;
  const calm = hr.length > 1 ? hr.reduce((a, b) => (b.value < a.value ? b : a)) : null;
  const lo = hr.length ? Math.min(...hr.map((x) => x.min)) : null;
  const many = p.days > 1;
  const kpis: Kpi[] = [
    ...(rhr.n ? [{ label: 'Пульс покоя', value: `${num(rhr.cur, 0)} уд/мин`, delta: pctDelta(rhr.cur, rhr.prev), goodWhenUp: false }] : []),
    ...(avg.n ? [{ label: many ? 'Средний пульс' : 'Пульс в среднем', value: `${num(avg.cur, 0)} уд/мин`, delta: pctDelta(avg.cur, avg.prev), goodWhenUp: false }] : []),
    ...(top ? [{ label: 'Максимум', value: `${num(top.max, 0)} уд/мин`, note: many ? fmtDate(top.date, false) : '' }] : []),
    ...(lo !== null && avg.cur !== null && lo < avg.cur - 1 ? [{ label: 'Минимум', value: `${num(lo, 0)} уд/мин` }] : []),
    ...(calm && many ? [{ label: 'Самый спокойный день', value: `${num(calm.value, 0)} уд/мин`, note: fmtDate(calm.date, false) }] : []),
    ...(hrv.n ? [{ label: 'ВСР (SDNN)', value: `${num(hrv.cur, 0)} мс`, delta: pctDelta(hrv.cur, hrv.prev), goodWhenUp: true }] : []),
    ...(walk.n ? [{ label: 'Пульс при ходьбе', value: `${num(walk.cur, 0)} уд/мин` }] : []),
    ...(vo2 ? [{ label: 'VO₂ max', value: num(vo2.value, 1), note: fmtDate(vo2.date, false) }] : []),
    ...(spo2.n ? [{ label: 'SpO₂', value: `${num(spo2.cur, 1)}%` }] : []),
    ...(resp.n ? [{ label: 'Дыхание', value: `${num(resp.cur, 1)} вд/мин` }] : []),
  ];
  const wd = [1, 2, 3, 4, 5, 6, 0].map((w) => { const v = hr.filter((x) => weekday(x.date) === w); return [WEEKDAYS[w], num(mean(v.map((x) => x.value)), 0), v.length ? num(Math.max(...v.map((x) => x.max)), 0) : '—']; }).filter((r) => r[1] !== '—');
  const extra: RichBlock[] = [
    ...(many && hr.length > 1 && p.days <= 62 ? [details('Пульс по дням', [table(['День', 'Средний', 'Макс'], [...hr].reverse().map((x) => [fmtDate(x.date, false), num(x.value, 0), num(x.max, 0)]))])] : []),
    ...(p.days >= 7 && wd.length ? [details('По дням недели', [table(['День', 'Средний', 'Макс'], wd)])] : []),
    ...(many ? dry(dryRows([['Пульс покоя', rhr.values, 1], ['ВСР', hrv.values, 1], ['При ходьбе', walk.values, 0], ['Средний за день', hr.map((x) => x.value), 0], ['Макс за день', hr.map((x) => x.max), 0]])) : []),
  ];
  return { title: 'Сердце', kpis, extra };
}

const ACT: Record<string, string> = { Running: 'Бег', Walking: 'Ходьба', Cycling: 'Велосипед', Swimming: 'Плавание', Yoga: 'Йога', Hiking: 'Хайкинг', TraditionalStrengthTraining: 'Силовая', FunctionalStrengthTraining: 'Функциональная', HighIntensityIntervalTraining: 'ВИИТ', CoreTraining: 'Кор', Pilates: 'Пилатес', Dance: 'Танцы', Elliptical: 'Эллипс', Rowing: 'Гребля', Boxing: 'Бокс', Soccer: 'Футбол', Basketball: 'Баскетбол', Tennis: 'Теннис', MixedCardio: 'Кардио', Cooldown: 'Заминка', Flexibility: 'Растяжка', Other: 'Другое' };
export const actName = (a: string) => ACT[a] ?? a.replace(/([a-z])([A-Z])/g, '$1 $2');

function workoutsView(p: Period, prev: Period | null): Built {
  const ws = Q.workouts(p.from, p.to), pw = prev ? Q.workouts(prev.from, prev.to) : [];
  if (!ws.length) return { title: 'Тренировки', kpis: [], extra: [], empty: 'За этот период тренировок нет.' };
  const tot = (a: Q.Workout[], k: keyof Q.Workout) => sum(a.map((w) => (w[k] as number) || 0));
  const types = new Map<string, Q.Workout[]>();
  for (const w of ws) (types.get(w.activity) ?? types.set(w.activity, []).get(w.activity)!).push(w);
  const tl = [...types].sort((a, b) => tot(b[1], 'duration_min') - tot(a[1], 'duration_min'));
  const kpis: Kpi[] = [
    { label: 'Тренировок', value: String(ws.length), delta: pw.length ? pctDelta(ws.length, pw.length) : null, goodWhenUp: true, note: p.days >= 7 ? `${num(ws.length / (p.days / 7), 1)}/нед` : '' },
    { label: 'Время', value: hm(tot(ws, 'duration_min')), delta: pw.length ? pctDelta(tot(ws, 'duration_min'), tot(pw, 'duration_min')) : null, goodWhenUp: true },
    { label: 'Дистанция', value: `${num(tot(ws, 'distance_km'), 1)} км` },
    { label: 'Калории', value: `${num(tot(ws, 'energy_kcal'), 0)} ккал` },
    { label: 'Средний пульс', value: num(mean(ws.filter((w) => w.hr_avg).map((w) => w.hr_avg!)), 0) },
  ];
  const extra: RichBlock[] = [
    heading('По видам', 3),
    table(['Вид', 'Раз', 'Время', 'Км'], tl.map(([a, x]) => [actName(a), String(x.length), hm(tot(x, 'duration_min')), tot(x, 'distance_km') ? num(tot(x, 'distance_km'), 1) : '—'])),
    details('Журнал', [table(['Дата', 'Вид', 'Время', 'Пульс'], [...ws].reverse().slice(0, 60).map((w) => [fmtDate(w.date, false), actName(w.activity), hm(w.duration_min), w.hr_avg ? `${num(w.hr_avg, 0)}/${num(w.hr_max, 0)}` : '—']))]),
  ];
  return { title: 'Тренировки', kpis, extra };
}

function musicView(p: Period, prev: Period | null): Built {
  const m = Q.music(p.from, p.to, 10), pm = prev ? Q.music(prev.from, prev.to, 1) : null;
  const t = m.totals;
  const now = Q.nowPlaying();
  const nowBlock = now ? [para(['▶️ Сейчас играет: ', { type: 'bold', text: now.artist }, ` — ${now.title}`])] : [];
  if (!t.plays) return { title: 'Музыка', kpis: [], extra: nowBlock, empty: 'Прослушиваний за этот период нет. Новые треки подтянутся из Last.fm сами.' };
  const okP = pm && pm.totals.days >= t.days * 0.8 ? pm.totals : null;
  const kpis: Kpi[] = [
    { label: 'Прослушиваний', value: num(t.plays, 0), delta: okP?.plays ? pctDelta(t.plays, okP.plays) : null },
    { label: 'Время', value: hm(t.minutes), delta: okP?.minutes ? pctDelta(t.minutes, okP.minutes) : null },
    { label: 'Исполнителей', value: num(t.artists, 0), note: m.newArtists.length ? `новых ${m.newArtists.length}` : '' },
    { label: 'Треков', value: num(t.tracks, 0) },
    { label: 'Пропуски', value: pct(t.skips / t.plays) },
  ];
  const extra: RichBlock[] = [
    ...nowBlock,
    heading('Топ исполнителей', 3), table(['#', 'Исполнитель', 'Раз'], m.topArtists.map((a, i) => [String(i + 1), a.artist, String(a.plays)])),
    details('Топ треков', [table(['#', 'Трек', 'Раз'], m.topTracks.map((x, i) => [String(i + 1), `${x.title} — ${x.artist}`, String(x.plays)]))]),
    ...(m.newArtists.length ? [details(`Новые исполнители (${m.newArtists.length})`, [table(['Исполнитель', 'Раз'], m.newArtists.map((a) => [a.artist, String(a.plays)]))])] : []),
  ];
  return { title: 'Музыка', kpis, extra };
}

function screen(p: Period): Built {
  const s = Q.screentime(p.from, p.to);
  if (!s.daily.length) return { title: 'Экранное время', kpis: [], extra: [], empty: 'За этот период данных нет. Время в приложениях iPhone приходит из автоматизаций «Команд» (открыто / закрыто).' };
  const days = s.daily.length, many = p.days > 1;
  const x = screenStats(p.from, p.to);
  const total = sum(s.daily.map((d) => d.minutes));
  const kpis: Kpi[] = [
    { label: many ? 'В среднем за день' : 'За день', value: hm(total / days) },
    ...(many ? [{ label: 'Всего', value: hm(total), note: `${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}` }] : []),
    ...(x.sessions ? [{ label: 'Открытий', value: num(x.sessions / (many ? days : 1), 0), note: many ? 'в день' : `в среднем по ${hm(total / x.sessions)}` }] : []),
    ...(x.longest ? [{ label: 'Самая длинная сессия', value: hm(x.longest.min), note: `${x.longest.app} · ${many ? fmtDate(x.longest.at.slice(0, 10), false) + ' ' : ''}${x.longest.at.slice(11, 16)}` }] : []),
  ];
  const peak = x.byHour.reduce((b, m, h) => (m > x.byHour[b] ? h : b), 0);
  if (x.sessions && x.byHour[peak] > 0) kpis.push({ label: 'Пик', value: `${String(peak).padStart(2, '0')}:00`, note: `${hm(x.byHour[peak] / (many ? days : 1))} в этот час` });
  const extra: RichBlock[] = [
    heading('Приложения', 3),
    table(['Приложение', 'Время', 'Открытий', 'Сессия'], s.apps.map((a) => {
      const st = x.byApp.get(a.app);
      return [a.app, hm(a.minutes / (many ? days : 1)) + (many ? '/д' : ''), st ? num(st.opens, 0) : '—', st ? hm(st.ms / st.opens / 60000) : '—'];
    })),
  ];
  const hours = x.byHour.map((m, h) => [h, m] as const).filter(([, m]) => m >= 0.5);
  if (hours.length) extra.push(details(`По часам (${hours.length})`, [table(['Час', 'Время', ''], hours.map(([h, m]) => [`${String(h).padStart(2, '0')}:00`, hm(m / (many ? days : 1)), '▇'.repeat(Math.max(1, Math.round((m / Math.max(...x.byHour)) * 10)))]))]));
  return { title: 'Экранное время', kpis, extra };
}

export function buildScreen(section: Section, kind: PeriodKind, anchor?: string): Screen {
  const { period, prev, hasData } = periodFor(kind, anchor);
  const b = section === 'home' ? home(period, prev, hasData)
    : section === 'plan' ? planView(period)
    : section === 'money' ? moneyView(period, prev)
    : section === 'sleep' ? sleep(period, prev)
    : section === 'steps' ? stepsView(period, prev)
    : section === 'heart' ? heart(period, prev)
    : section === 'workouts' ? workoutsView(period, prev)
    : section === 'music' ? musicView(period, prev)
    : screen(period);
  const blocks: RichBlock[] = [
    heading(`${b.title} · ${period.label}`, 2),
    ...(b.empty ? [para(b.empty)] : [kpiTable(b.kpis)]),
    ...b.extra,
  ];
  return { title: b.title, period, kpis: b.kpis, blocks, html: blocksToHtml(blocks), empty: b.empty };
}
