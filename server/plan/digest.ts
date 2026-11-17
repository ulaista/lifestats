// Morning / evening digest: the facts are computed here (the free model mangles numbers), the model only
// writes a headline, a few observations and recommendations — and any of its lines quoting a number that is
// not in the facts is dropped. Stored in kv and shown at the top of the Mini App's Overview.
import { db, kvGet, kvSet } from '../db.ts';
import { addDays } from '../lib/time.ts';
import { num, hm, clock } from '../lib/format.ts';
import * as Q from '../stats/queries.ts';
import * as P from './store.ts';
import * as M from './money.ts';
import { completeJSON, assistantEnabled } from './assistant.ts';

export type DigestKind = 'morning' | 'evening';
export interface Fact { icon: string; label: string; value: string; note?: string; tone?: 'good' | 'bad' | null }
export interface Digest {
  kind: DigestKind; date: string; at: string;
  facts: Fact[]; headline: string | null; insights: string[]; recs: string[]; error?: string;
}

const T = Q.T;
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const minOfDay = (iso: string | null) => (iso ? Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)) : null);
/** Bedtime as minutes around midnight (23:30 → -30) so averages don't break across 00:00. */
const bedMin = (iso: string | null) => { const m = minOfDay(iso); return m === null ? null : m > 12 * 60 ? m - 1440 : m; };
const tone = (v: number | null, avg: number | null, upGood = true, slack = 0.1): Fact['tone'] =>
  v === null || avg === null || !avg ? null : v >= avg * (1 + slack) ? (upGood ? 'good' : 'bad') : v <= avg * (1 - slack) ? (upGood ? 'bad' : 'good') : null;

function dayVal(type: string, date: string) { return Q.daily(type, date, date)[0]?.value ?? null; }
function avgVal(type: string, from: string, to: string) { return mean(Q.daily(type, from, to).map((x) => x.value)); }

function sleepFact(night: string, label: string): Fact {
  const n = Q.nights(night, night)[0];
  const prev = Q.nights(addDays(night, -7), addDays(night, -1)).filter((x) => x.asleep_min);
  const avg = mean(prev.map((x) => x.asleep_min!));
  if (!n?.asleep_min) return { icon: '🛏', label, value: 'нет данных', note: 'ночь ещё не пришла с iPhone' };
  const stages = n.has_stages ? ` · глубокий ${hm(n.deep_min)}, REM ${hm(n.rem_min)}` : '';
  return { icon: '🛏', label, value: hm(n.asleep_min), note: `${clock(minOfDay(n.bedtime))} → ${clock(minOfDay(n.waketime))}${stages}${avg ? ` · в среднем ${hm(avg)}` : ''}`, tone: tone(n.asleep_min, avg) };
}

function activityFacts(date: string, label: string, sofar: boolean): Fact[] {
  const out: Fact[] = [];
  const from = addDays(date, -7), to = addDays(date, -1);
  const st = dayVal(T.steps, date), stAvg = avgVal(T.steps, from, to);
  if (st === null) return [{ icon: '🚶', label: `Шаги ${label}`, value: 'нет данных', note: 'ещё не пришли с iPhone' }];
  out.push(st === null
    ? { icon: '🚶', label: `Шаги ${label}`, value: 'нет данных' }
    : { icon: '🚶', label: `Шаги ${label}`, value: num(st, 0), note: stAvg ? `в среднем ${num(stAvg, 0)} в день` : undefined, tone: sofar ? null : tone(st, stAvg) });
  const act = dayVal(T.active, date), actAvg = avgVal(T.active, from, to);
  if (act !== null) out.push({ icon: '🔥', label: `Активность ${label}`, value: `${num(act, 0)} ккал`, note: actAvg ? `в среднем ${num(actAvg, 0)}` : undefined, tone: sofar ? null : tone(act, actAvg) });
  return out;
}

function planFact(date: string, label: string): Fact | null {
  const occ = P.occurrences(date, date).filter((o) => o.it.status !== 'cancelled');
  const timed = occ.filter((o) => o.it.at && o.it.at.length > 10).sort((a, b) => a.it.at!.slice(11).localeCompare(b.it.at!.slice(11)));
  if (!occ.length) return { icon: '🗓', label, value: 'свободно', note: 'событий нет' };
  const first = timed[0];
  const busy = timed.reduce((a, o) => a + (o.it.end_at ? Math.max(0, (Date.parse(o.it.end_at + ':00Z') - Date.parse(o.it.at! + ':00Z')) / 60000) : 60), 0);
  return { icon: '🗓', label, value: `${occ.length} ${occ.length === 1 ? 'дело' : occ.length < 5 ? 'дела' : 'дел'}`, note: [first ? `первое в ${first.it.at!.slice(11, 16)} — ${first.it.title}` : '', busy ? `занято ~${hm(busy)}` : ''].filter(Boolean).join(' · ') };
}

function spendFact(date: string, label: string): Fact | null {
  const rows = M.findExpenses({ from: date, to: date }, 200);
  if (!rows.length) return null;
  const byCur = new Map<string, number>();
  for (const e of rows) byCur.set(e.currency, (byCur.get(e.currency) ?? 0) + e.amount);
  return { icon: '💸', label, value: [...byCur].map(([c, v]) => M.money(v, c)).join(' + '), note: `${rows.length} ${rows.length === 1 ? 'трата' : rows.length < 5 ? 'траты' : 'трат'}` };
}

/** Bedtime that leaves ~8 h of sleep before tomorrow's first commitment (or the usual wake-up). */
function bedtimeFact(today: string): Fact | null {
  const tomorrow = addDays(today, 1);
  const recent = Q.nights(addDays(today, -7), today).filter((n) => n.waketime);
  const wakeAvg = mean(recent.map((n) => minOfDay(n.waketime)!));
  const first = P.occurrences(tomorrow, tomorrow).map((o) => o.it.at).filter((a): a is string => !!a && a.length > 10).sort((a, b) => a.slice(11).localeCompare(b.slice(11)))[0];
  const firstMin = minOfDay(first ?? null);
  let wake = wakeAvg ?? 8 * 60;
  if (firstMin !== null) wake = Math.min(wake, firstMin - 75);
  const bed = wake - 8 * 60 - 15;
  return { icon: '🌙', label: 'Лечь до', value: clock(bed), note: firstMin !== null ? `завтра первое дело в ${clock(firstMin)} — подъём ~${clock(wake)}` : `обычный подъём ~${clock(wake)}` };
}

export function buildFacts(kind: DigestKind, today = P.todayLocal()): Fact[] {
  const y = addDays(today, -1), f: (Fact | null)[] = [];
  if (kind === 'morning') {
    f.push(sleepFact(today, 'Сон этой ночью'));
    f.push(...activityFacts(y, 'вчера', false));
    f.push(planFact(today, 'Сегодня в плане'));
    const od = P.overdue();
    if (od.length) f.push({ icon: '⏳', label: 'Просрочено', value: String(od.length), note: od.slice(0, 2).map((x) => x.title).join(', '), tone: 'bad' });
    const fw = P.freeWindows(today).slice(0, 3);
    if (fw.length) f.push({ icon: '🪟', label: 'Свободные окна', value: fw[0], note: fw.slice(1).join(', ') || undefined });
    f.push(spendFact(y, 'Потрачено вчера'));
  } else {
    f.push(...activityFacts(today, 'сегодня', true));
    const done = db.prepare(`SELECT title FROM plan_items WHERE status = 'done' AND substr(done_at, 1, 10) = ?`).all(today) as { title: string }[];
    const left = P.dayItems(today).filter((it) => it.status === 'open' && it.kind === 'task');
    f.push({ icon: '✅', label: 'Сделано сегодня', value: String(done.length), note: left.length ? `осталось ${left.length}: ${left.slice(0, 2).map((x) => x.title).join(', ')}` : undefined, tone: left.length ? null : done.length ? 'good' : null });
    f.push(planFact(addDays(today, 1), `Завтра (${P.dayLabel(addDays(today, 1), '')})`));
    f.push(sleepFact(today, 'Сон прошлой ночью'));
    f.push(spendFact(today, 'Потрачено сегодня'));
    f.push(bedtimeFact(today));
  }
  return f.filter((x): x is Fact => !!x);
}

/** Last 7 days as a compact table for the model (gives it something to notice). */
function weekTable(today: string): string {
  const rows: string[] = [];
  for (let i = 7; i >= 1; i--) {
    const d = addDays(today, -i), n = Q.nights(d, d)[0];
    const st = dayVal(T.steps, d);
    rows.push(`${d}: сон ${n?.asleep_min ? hm(n.asleep_min) : '—'}, отбой ${n?.bedtime ? clock(minOfDay(n.bedtime)) : '—'}, шаги ${st !== null ? num(st, 0) : '—'}, дел ${P.occurrences(d, d).length}`);
  }
  return rows.join('\n');
}

/** Ready-made weekly aggregates the model may quote verbatim. */
function weekStats(today: string): string {
  const ns = Q.nights(addDays(today, -7), addDays(today, -1)).filter((n) => n.asleep_min);
  if (!ns.length) return '';
  const avgSleep = mean(ns.map((n) => n.asleep_min!))!;
  const bed = mean(ns.map((n) => bedMin(n.bedtime)).filter((x): x is number => x !== null));
  const short = ns.filter((n) => n.asleep_min! < 360), long = ns.filter((n) => n.asleep_min! >= 420);
  const stepsOn = (list: typeof ns) => mean(list.map((n) => dayVal(T.steps, n.night)).filter((x): x is number => x !== null));
  const a = stepsOn(short), b = stepsOn(long);
  return [
    `Итоги 7 дней: средний сон ${hm(avgSleep)}`,
    bed !== null ? `средний отбой ${clock(bed)}` : '',
    `ночей короче 6 ч: ${short.length} из ${ns.length}`,
    a !== null && b !== null ? `шаги в дни после ночи короче 6 ч — ${num(a, 0)}, после 7+ ч — ${num(b, 0)}` : '',
  ].filter(Boolean).join('; ') + '.';
}

const factLine = (x: Fact) => `${x.label}: ${x.value}${x.note ? ` (${x.note})` : ''}`;

/**
 * Numbers with 2+ digits (and clock times) the model may quote: only those present in the input.
 * Recommendations may also name round targets ("30 минут", "до 23:30", "8 000 шагов") — not statistics.
 */
const ROUND_MIN = new Set([10, 15, 20, 30, 40, 45, 60, 90, 120]);
function numbersOk(text: string, source: string, targets = false): boolean {
  const norm = (s: string) => s.replace(/(\d)[\s\u00a0\u202f](?=\d{3}\b)/g, '$1');
  const src = norm(source);
  const nums = norm(text).match(/\d+(?::\d{2}|[.,]\d+)?/g) ?? [];
  return nums.every((n) => {
    if (n.replace(/[.,]\d+$/, '').length < 2 || src.includes(n)) return true;
    if (!targets) return false;
    if (/^\d{1,2}:(00|30)$/.test(n)) return true;
    const v = Number(n.replace(',', '.'));
    return ROUND_MIN.has(v) || (v >= 500 && v % 500 === 0);
  });
}

const SYSTEM = [
  'Ты — личный аналитик дня. По фактам (сон, активность, расписание, траты) пишешь короткий разбор по-русски.',
  'Правила: опирайся только на данные; не выдумывай статистику (числа о прошлом — только из фактов, как есть); в советах можно ставить круглые цели (30 минут, 8 000 шагов, лечь до 23:30);',
  'не ставь диагнозов; советы — конкретные действия на сегодня/завтра, с привязкой к расписанию и свободным окнам;',
  'без воды и общих фраз вроде «пейте воду». Обращайся на «ты». Каждый пункт — одно предложение до 140 символов.',
  '«нет данных» значит, что iPhone ещё не прислал данные, а не что активности не было — так и не трактуй, просто не делай выводов по этому пункту.',
  'Ищи закономерности в таблице за 7 дней (поздний отбой, недосып, просадка шагов в дни с делами) и связывай их с планом на сегодня/завтра.',
  'Внимательно с днями: «сегодня» и «завтра» в фактах подписаны — не путай их.',
  'Траты не комментируй, если нечего сказать по делу; бюджеты не придумывай.',
  'Ответ — JSON: {"headline":"главная мысль до 80 символов","insights":["2–3 наблюдения"],"recs":["3 рекомендации"]}.',
].join(' ');

export async function makeDigest(kind: DigestKind): Promise<Digest> {
  const today = P.todayLocal();
  const facts = buildFacts(kind, today);
  const d: Digest = { kind, date: today, at: P.nowLocal(), facts, headline: null, insights: [], recs: [] };
  if (assistantEnabled()) {
    const input = [
      kind === 'morning' ? `Утро, ${P.dayLabel(today, '')} ${today}. Помоги спланировать день.` : `Вечер, ${P.dayLabel(today, '')} ${today}. Подведи итог дня и подготовь к завтра.`,
      'Факты:', ...facts.map(factLine),
      weekStats(today),
      'Последние 7 дней:', weekTable(today),
    ].join('\n');
    try {
      const j = await completeJSON(SYSTEM, input);
      if (process.env.DIGEST_DEBUG) console.log(JSON.stringify(j));
      const clean = (v: unknown, max: number, targets = false) => (Array.isArray(v) ? v : []).map((x) => String(x ?? '').trim()).filter((x) => x && x.length <= 220 && numbersOk(x, input, targets)).slice(0, max);
      const h = String(j.headline ?? '').trim();
      d.headline = h && h.length <= 120 && numbersOk(h, input) ? h : null;
      d.insights = clean(j.insights, 3);
      d.recs = clean(j.recs, 3, true);
    } catch (e) { d.error = (e as Error).message; }
  }
  kvSet(`digest:${kind}`, JSON.stringify(d));
  return d;
}

export function getDigest(kind: DigestKind): Digest | null {
  try { return JSON.parse(kvGet(`digest:${kind}`) || 'null'); } catch { return null; }
}

export const eveningHour = () => kvGet('digest:evening_hour') || '21:30';

/** Which digest is due now (once per day each); marks it as taken. */
export function dueDigest(now = P.nowLocal()): DigestKind | null {
  const today = now.slice(0, 10), t = now.slice(11, 16);
  if (kvGet('digest:evening_day') !== today && t >= eveningHour()) { kvSet('digest:evening_day', today); return 'evening'; }
  if (kvGet('digest:morning_day') !== today && t >= P.planHour() && t < '12:00') { kvSet('digest:morning_day', today); return 'morning'; }
  return null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function digestHtml(d: Digest): string {
  return [
    `${d.kind === 'morning' ? '🌅 <b>Утренний разбор</b>' : '🌙 <b>Вечерний разбор</b>'}`,
    d.headline ? `<b>${esc(d.headline)}</b>` : '',
    ...d.recs.map((r) => `• ${esc(r)}`),
    '<i>Подробно — в приложении, на «Обзоре».</i>',
  ].filter(Boolean).join('\n');
}
