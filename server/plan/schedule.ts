// "Распредели задачи на завтра": the code finds free windows (around events, timed tasks and the
// calendar) and the candidate tasks; the model only chooses order and durations, and the code checks
// every slot before writing it.
import * as P from './store.ts';
import { wallMs, wallIso } from '../lib/time.ts';

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Busy intervals of a day in minutes: events and timed tasks (30 min if no end), never-moving sources included. */
function busy(date: string, skip = new Set<number>()): [number, number][] {
  return P.occurrences(date, date).map((o) => o.it)
    .filter((it) => it.at && it.at.length > 10 && it.status !== 'cancelled' && !skip.has(it.id))
    .map((it) => {
      const a = toMin(it.at!.slice(11));
      const b = it.end_at && it.end_at.length > 10 && it.end_at.slice(0, 10) === date ? toMin(it.end_at.slice(11)) : a + (it.kind === 'event' ? 60 : 30);
      return [a, Math.max(b, a + 5)] as [number, number];
    }).sort((x, y) => x[0] - y[0]);
}

/** Free windows of at least 20 minutes between `from` and `to` (today: from now, rounded up to 5 min). */
export function windows(date: string, from = '09:00', to = '22:00', skip = new Set<number>()): [number, number][] {
  let cur = toMin(from);
  if (date === P.todayLocal()) cur = Math.max(cur, Math.ceil((toMin(P.nowLocal().slice(11)) + 10) / 5) * 5);
  const end = toMin(to), out: [number, number][] = [];
  for (const [a, b] of busy(date, skip)) {
    if (a - cur >= 20 && cur < end) out.push([cur, Math.min(a, end)]);
    cur = Math.max(cur, b + 10); // 10 min buffer after anything
  }
  if (end - cur >= 20) out.push([cur, end]);
  return out;
}

/** Open tasks worth placing on `date`: due that day without a time, overdue, then undated (priority first). */
export function candidates(date: string): P.Item[] {
  const all = P.openTasks().filter((t) => t.source !== 'icloud');
  const due = all.filter((t) => t.at && t.at.slice(0, 10) === date && t.at.length === 10);
  const late = all.filter((t) => t.at && t.at.slice(0, 10) < date && !t.repeat);
  const undated = all.filter((t) => !t.at).sort((a, b) => b.priority - a.priority);
  return [...due, ...late, ...undated].slice(0, 20);
}

export function freeTimeText(date: string, from = '09:00', to = '22:00'): string {
  const w = windows(date, from, to), c = candidates(date);
  return [
    `Свободные окна ${date} (${from}–${to}, с запасом 10 мин после дел): ${w.length ? w.map(([a, b]) => `${hm(a)}–${hm(b)} (${b - a} мин)`).join(', ') : 'нет'}.`,
    'Задачи-кандидаты (#id, приоритет, срок):',
    ...(c.length ? c.map((t) => `#${t.id} ${t.title}${t.priority ? ' [важно]' : ''}${t.at ? ` срок ${t.at}` : ' без срока'}${t.source === 'reminders' ? ' (Напоминания)' : ''}`) : ['(нет открытых задач)']),
    'Дальше вызови schedule_tasks: каждой выбранной задаче — start (HH:MM внутри окна) и minutes (реалистичная оценка 15–120). Важные и просроченные — раньше, тяжёлое — утром, мелочи — в короткие окна; оставь 1–2 окна свободными.',
  ].join('\n');
}

export interface Slot { id: number; start: string; minutes: number }

/** Validates and writes the slots; returns a report line per task. */
export function scheduleTasks(date: string, slots: Slot[]): { ok: string[]; errors: string[]; ids: number[] } {
  const ok: string[] = [], errors: string[] = [], ids: number[] = [];
  const placed: [number, number][] = [];
  const allowed = new Map(candidates(date).map((t) => [t.id, t]));
  for (const s of slots) {
    const t = allowed.get(Number(s.id)) ?? P.getItem(Number(s.id));
    if (!t || t.kind !== 'task' || t.status !== 'open' || t.source === 'icloud') { errors.push(`#${s.id}: не открытая задача`); continue; }
    if (!/^\d{1,2}:\d{2}$/.test(String(s.start))) { errors.push(`#${s.id}: время ${s.start}?`); continue; }
    const a = toMin(String(s.start).padStart(5, '0')), m = Math.max(10, Math.min(240, Math.round(Number(s.minutes) || 30))), b = a + m;
    const free = windows(date, '06:00', '23:59', new Set([t.id])).some(([x, y]) => a >= x && b <= y);
    const clash = placed.some(([x, y]) => a < y && b > x);
    if (!free || clash) { errors.push(`#${t.id} «${t.title}» ${hm(a)}–${hm(b)}: пересекается с делами`); continue; }
    const at = `${date}T${hm(a)}`;
    P.updateItem(t.id, t.source === 'reminders' ? { at } : { at, end_at: wallIso(wallMs(at) + m * 60000).slice(0, 16), remind_before: 5 });
    placed.push([a, b]); ids.push(t.id);
    ok.push(`${hm(a)}–${hm(b)} ${t.title}`);
  }
  return { ok, errors, ids };
}
