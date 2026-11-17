// "Plans ↔ health": compares days by what was scheduled (evening events, busy days, finished tasks)
// with sleep the following night and steps that day. Plain arithmetic, no model: only differences
// backed by at least MIN days on each side are reported.
import { db } from '../db.ts';
import * as Q from '../stats/queries.ts';
import { addDays } from '../lib/time.ts';
import { todayLocal } from './store.ts';
import { hm, num } from '../lib/format.ts';

const MIN = 3;

interface Day { date: string; evening: boolean; busyMin: number; done: number; sleep: number | null; bed: number | null; steps: number | null }

/** Bedtime as minutes after 18:00 (so 01:30 > 23:00). */
const bedMin = (iso: string | null) => { if (!iso) return null; const m = +iso.slice(11, 13) * 60 + +iso.slice(14, 16); return m < 18 * 60 ? m + 6 * 60 : m - 18 * 60; };
const clock = (m: number) => { const t = Math.round(m + 18 * 60) % 1440; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function days(weeks: number): Day[] {
  const to = addDays(todayLocal(), -1), from = addDays(to, -weeks * 7 + 1);
  const ev = db.prepare(`SELECT substr(at, 1, 10) AS d, at, end_at FROM plan_items WHERE kind = 'event' AND status != 'cancelled' AND length(at) > 10 AND substr(at, 1, 10) BETWEEN ? AND ?`).all(from, to) as { d: string; at: string; end_at: string | null }[];
  const done = db.prepare(`SELECT substr(at, 1, 10) AS d, COUNT(*) AS n FROM plan_log WHERE action = 'done' AND substr(at, 1, 10) BETWEEN ? AND ? GROUP BY d`).all(from, to) as { d: string; n: number }[];
  const doneOne = db.prepare(`SELECT substr(done_at, 1, 10) AS d, COUNT(*) AS n FROM plan_items WHERE status = 'done' AND repeat IS NULL AND substr(done_at, 1, 10) BETWEEN ? AND ? GROUP BY d`).all(from, to) as { d: string; n: number }[];
  const nights = new Map(Q.nights(addDays(from, 1), addDays(to, 1)).filter((n) => n.asleep_min).map((n) => [n.night, n]));
  const steps = new Map(Q.daily(Q.T.steps, from, to).map((p) => [p.date, p.value]));
  const out: Day[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const mine = ev.filter((e) => e.d === d);
    const end = (e: { at: string; end_at: string | null }) => (e.end_at && e.end_at.length > 10 ? e.end_at : e.at);
    const n = nights.get(addDays(d, 1)); // the night after day d is keyed by the wake-up date
    out.push({
      date: d,
      evening: mine.some((e) => end(e).slice(0, 10) > d || end(e).slice(11) >= '20:00'),
      busyMin: mine.reduce((a, e) => a + Math.max(0, (Date.parse(end(e) + ':00Z') - Date.parse(e.at + ':00Z')) / 60000), 0),
      done: (done.find((x) => x.d === d)?.n ?? 0) + (doneOne.find((x) => x.d === d)?.n ?? 0),
      sleep: n?.asleep_min ?? null, bed: bedMin(n?.bedtime ?? null), steps: steps.get(d) ?? null,
    });
  }
  return out;
}

function compare(label: string, a: Day[], b: Day[], aName: string, bName: string, out: string[]) {
  const pick = (xs: Day[], f: (d: Day) => number | null) => xs.map(f).filter((v): v is number => v !== null);
  const sa = pick(a, (d) => d.sleep), sb = pick(b, (d) => d.sleep);
  const ba = pick(a, (d) => d.bed), bb = pick(b, (d) => d.bed);
  const ta = pick(a, (d) => d.steps), tb = pick(b, (d) => d.steps);
  const lines: string[] = [];
  if (ba.length >= MIN && bb.length >= MIN && Math.abs(avg(ba)! - avg(bb)!) >= 20) lines.push(`ложишься в ~${clock(avg(ba)!)} против ~${clock(avg(bb)!)} (${aName}: ${ba.length} дн., ${bName}: ${bb.length} дн.)`);
  if (sa.length >= MIN && sb.length >= MIN && Math.abs(avg(sa)! - avg(sb)!) >= 15) lines.push(`спишь ${hm(avg(sa)!)} против ${hm(avg(sb)!)}`);
  if (ta.length >= MIN && tb.length >= MIN && Math.abs(avg(ta)! - avg(tb)!) / Math.max(1, avg(tb)!) >= 0.12) lines.push(`проходишь ${num(avg(ta)!, 0)} шагов против ${num(avg(tb)!, 0)}`);
  if (lines.length) out.push(`• ${label}: ${lines.join('; ')}.`);
}

export function insightsText(weeks = 6): string {
  const ds = days(weeks);
  const withPlans = ds.filter((d) => d.busyMin > 0 || d.done > 0);
  const out = [`🔍 Дела ↔ здоровье · последние ${weeks} нед.`];
  compare('В дни с вечерними делами (после 20:00)', ds.filter((d) => d.evening), ds.filter((d) => !d.evening && d.busyMin > 0), 'вечерние', 'обычные', out);
  compare('В загруженные дни (встречи ≥ 3 ч)', ds.filter((d) => d.busyMin >= 180), ds.filter((d) => d.busyMin < 60), 'загруженные', 'свободные', out);
  // Did a short night change how much got done the next day?
  const prevSleep = (d: Day) => ds.find((x) => x.date === addDays(d.date, -1))?.sleep ?? null;
  const rested = ds.filter((d) => (prevSleep(d) ?? 0) >= 420), tired = ds.filter((d) => { const s = prevSleep(d); return s !== null && s < 360; });
  if (rested.length >= MIN && tired.length >= MIN) {
    const a = avg(rested.map((d) => d.done))!, b = avg(tired.map((d) => d.done))!;
    if (Math.abs(a - b) >= 0.5) out.push(`• После ночи ≥ 7 ч ты закрываешь в среднем ${num(a, 1)} задач в день, после ночи < 6 ч — ${num(b, 1)}.`);
  }
  if (out.length === 1) {
    const ev = ds.filter((d) => d.evening).length;
    out.push(`Пока мало данных для выводов: дни с делами — ${withPlans.length}, с вечерними — ${ev}. Нужно хотя бы по ${MIN} дня в каждой группе со сном и шагами. Календарь и задачи копятся с 16 ноября — первые наблюдения появятся через 1–2 недели.`);
  }
  return out.join('\n');
}
