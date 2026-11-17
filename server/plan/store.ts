// Personal planner: tasks, meetings/events and notes, with reminders and repeats.
// Times are local wall-clock strings in the owner's time zone: 'YYYY-MM-DD' (all day) or 'YYYY-MM-DDTHH:MM'.
import { db, kvGet, kvSet } from '../db.ts';
import { wallMs, wallIso, addDays } from '../lib/time.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS plan_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,              -- task | event | note
  title         TEXT NOT NULL,
  notes         TEXT,
  at            TEXT,                       -- event start / task deadline (local)
  end_at        TEXT,                       -- event end (local)
  remind_before INTEGER,                    -- minutes before 'at'; NULL = no reminder
  repeat        TEXT,                       -- daily | weekdays | weekly | weekly:1,3 | monthly | yearly
  people        TEXT,
  place         TEXT,
  priority      INTEGER NOT NULL DEFAULT 0, -- 0 normal, 1 important, 2 urgent
  status        TEXT NOT NULL DEFAULT 'open', -- open | done | cancelled
  next_remind   TEXT,                       -- local time of the next reminder
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  done_at       TEXT
);
CREATE INDEX IF NOT EXISTS plan_items_remind ON plan_items(status, next_remind);
CREATE INDEX IF NOT EXISTS plan_items_at ON plan_items(status, at);
CREATE TABLE IF NOT EXISTS plan_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  action  TEXT NOT NULL,                    -- created | done | cancelled | reminded | moved
  at      TEXT NOT NULL,
  title   TEXT
);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS reminder_ops (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  op         TEXT NOT NULL,                -- done | due | new
  title      TEXT NOT NULL,
  due        TEXT,                         -- local 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM'
  tries      INTEGER NOT NULL DEFAULT 0,   -- times handed to the Shortcut
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | applied | failed
  created_at TEXT NOT NULL,
  done_at    TEXT
);
`);
// Events copied from the iPhone's calendars (read-only here) carry their source.
if (!db.prepare("SELECT 1 FROM pragma_table_info('plan_items') WHERE name = 'source'").get()) db.exec('ALTER TABLE plan_items ADD COLUMN source TEXT');

export type Kind = 'task' | 'event' | 'note';
export type Status = 'open' | 'done' | 'cancelled';
export interface Item {
  id: number; kind: Kind; title: string; notes: string | null; at: string | null; end_at: string | null;
  remind_before: number | null; repeat: string | null; people: string | null; place: string | null;
  priority: number; status: Status; next_remind: string | null; created_at: string; updated_at: string | null; done_at: string | null;
  source?: string | null; // 'icloud' = copied from the iPhone calendar, read-only
}
const readOnly = (it: Item, reminderOk = false) => {
  if (it.source === 'reminders' && !reminderOk) throw new Error(`«${it.title}» — из приложения «Напоминания»: из бота его можно только отметить сделанным или перенести, остальное — в самом приложении.`);
  if (it.source === 'reminders') return;
  if (it.source) throw new Error(`«${it.title}» — событие из календаря iPhone, его меняют в приложении «Календарь».`);
};
export type Fields = Partial<Pick<Item, 'kind' | 'title' | 'notes' | 'at' | 'end_at' | 'remind_before' | 'repeat' | 'people' | 'place' | 'priority' | 'status'>>;

// ---------------------------------------------------------------- time

/** Local wall-clock now, 'YYYY-MM-DDTHH:MM'. */
export const nowLocal = () => new Date().toLocaleString('sv-SE', { hour12: false }).replace(' ', 'T').slice(0, 16);
export const todayLocal = () => nowLocal().slice(0, 10);
const hasTime = (s: string | null): s is string => Boolean(s && s.length >= 16);
const plusMin = (local: string, min: number) => wallIso(wallMs(local) + min * 60000).slice(0, 16);
const dow = (date: string) => ((new Date(wallMs(date + 'T00:00')).getUTCDay() + 6) % 7) + 1; // 1 = Mon … 7 = Sun

/** Normalises what the model sends: 'YYYY-MM-DD', 'YYYY-MM-DD HH:MM', ISO with seconds/zone → local form. */
export function normTime(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(v.trim());
  if (!m) throw new Error(`Не понял время «${v}». Нужен формат YYYY-MM-DD или YYYY-MM-DDTHH:MM.`);
  return m[2] ? `${m[1]}T${m[2].padStart(2, '0')}:${m[3]}` : m[1];
}

const REPEAT = /^(daily|weekdays|weekly(:[1-7](,[1-7])*)?|monthly|yearly)$/;
export function normRepeat(v: unknown): string | null {
  if (v === null || v === undefined || v === '' || v === 'none') return null;
  if (typeof v !== 'string' || !REPEAT.test(v)) throw new Error(`Неизвестный повтор «${v}». Варианты: daily, weekdays, weekly, weekly:1,3 (1=пн), monthly, yearly.`);
  return v;
}

/** Next occurrence strictly after `at` for a repeat rule (keeps the time of day). */
export function nextOccurrence(at: string, repeat: string): string {
  const date = at.slice(0, 10), time = at.slice(10);
  let d = date;
  if (repeat === 'daily') d = addDays(date, 1);
  else if (repeat === 'weekly') d = addDays(date, 7);
  else if (repeat === 'monthly' || repeat === 'yearly') {
    const [y, mo, day] = date.split('-').map(Number);
    const ny = repeat === 'yearly' ? y + 1 : y + Math.floor(mo / 12), nm = repeat === 'yearly' ? mo : (mo % 12) + 1;
    const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    d = `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
  } else {
    const days = repeat === 'weekdays' ? [1, 2, 3, 4, 5] : repeat.slice(7).split(',').map(Number);
    d = addDays(date, 1);
    for (let i = 0; i < 7 && !days.includes(dow(d)); i++) d = addDays(d, 1);
  }
  return d + time;
}

/** When the next reminder for the current occurrence is due (null = none). */
export function computeRemind(it: Pick<Item, 'status' | 'at' | 'remind_before'>, now = nowLocal()): string | null {
  if (it.status !== 'open' || !it.at || it.remind_before === null || it.remind_before === undefined) return null;
  const at = hasTime(it.at) ? it.at : `${it.at}T09:00`; // all-day: in the morning
  if (at <= now) return null;
  const r = plusMin(at, -Math.max(0, it.remind_before));
  return r < now ? now : r;
}

// ---------------------------------------------------------------- CRUD

const log = (id: number, action: string, title: string) =>
  db.prepare('INSERT INTO plan_log(item_id, action, at, title) VALUES(?, ?, ?, ?)').run(id, action, nowLocal(), title);

export const getItem = (id: number) => (db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id) as Item | undefined) ?? null;

function clean(f: Fields): Fields {
  const out: Fields = { ...f };
  if ('at' in f) out.at = normTime(f.at);
  if ('end_at' in f) out.end_at = normTime(f.end_at);
  if ('repeat' in f) out.repeat = normRepeat(f.repeat);
  if ('remind_before' in f) out.remind_before = f.remind_before === null || f.remind_before === undefined ? null : Math.max(0, Math.round(Number(f.remind_before)));
  if ('priority' in f) out.priority = Math.max(0, Math.min(2, Math.round(Number(f.priority) || 0)));
  if ('kind' in f && !['task', 'event', 'note'].includes(String(f.kind))) throw new Error('kind: task | event | note');
  if ('status' in f && !['open', 'done', 'cancelled'].includes(String(f.status))) throw new Error('status: open | done | cancelled');
  if ('title' in f && !String(f.title ?? '').trim()) throw new Error('Пустое название');
  return out;
}

export function addItem(f: Fields & { kind: Kind; title: string }): Item {
  const c = clean(f);
  const it = { kind: c.kind!, title: c.title!.trim(), notes: c.notes ?? null, at: c.at ?? null, end_at: c.end_at ?? null, remind_before: c.remind_before ?? null, repeat: c.repeat ?? null, people: c.people ?? null, place: c.place ?? null, priority: c.priority ?? 0, status: 'open' as Status };
  if (it.kind === 'event' && hasTime(it.at) && !it.end_at) it.end_at = plusMin(it.at, 60);
  const r = db.prepare(`INSERT INTO plan_items(kind, title, notes, at, end_at, remind_before, repeat, people, place, priority, status, next_remind, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(it.kind, it.title, it.notes, it.at, it.end_at, it.remind_before, it.repeat, it.people, it.place, it.priority, computeRemind(it), nowLocal());
  const id = Number(r.lastInsertRowid);
  log(id, 'created', it.title);
  if (it.repeat && it.at) advance(getItem(id)!); // "every weekday at 10" said at 11: first one is tomorrow
  return getItem(id)!;
}

export function updateItem(id: number, f: Fields): Item {
  const old = getItem(id);
  if (!old) throw new Error(`Нет записи #${id}`);
  readOnly(old, true);
  const c = clean(f);
  if (old.source === 'reminders') return updateReminder(old, c);
  const it = { ...old, ...c } as Item;
  // Moving an event keeps its duration.
  if ('at' in c && !('end_at' in c) && hasTime(old.at) && hasTime(old.end_at) && hasTime(it.at)) it.end_at = plusMin(it.at, (wallMs(old.end_at) - wallMs(old.at)) / 60000);
  if (c.status === 'done' && old.repeat && old.status === 'open') return completeItem(id);
  if (c.status && c.status !== old.status) { it.done_at = c.status === 'open' ? null : nowLocal(); log(id, c.status, it.title); }
  else if ('at' in c && c.at !== old.at) log(id, 'moved', it.title);
  it.next_remind = computeRemind(it);
  db.prepare(`UPDATE plan_items SET kind=?, title=?, notes=?, at=?, end_at=?, remind_before=?, repeat=?, people=?, place=?, priority=?, status=?, next_remind=?, done_at=?, updated_at=? WHERE id=?`)
    .run(it.kind, it.title, it.notes, it.at, it.end_at, it.remind_before, it.repeat, it.people, it.place, it.priority, it.status, it.next_remind, it.done_at, nowLocal(), id);
  return getItem(id)!;
}

/** Done: a one-off item closes; a repeating one logs the completion and moves to its next occurrence. */
export function completeItem(id: number): Item {
  const it = getItem(id);
  if (!it) throw new Error(`Нет записи #${id}`);
  readOnly(it, true);
  if (!it.repeat || !it.at) return it.status === 'done' ? it : updateItem(id, { status: 'done' });
  log(id, 'done', it.title);
  advance(it, true);
  return getItem(id)!;
}

export function deleteItem(id: number) {
  const it = getItem(id);
  if (!it) throw new Error(`Нет записи #${id}`);
  readOnly(it);
  db.prepare('DELETE FROM plan_items WHERE id = ?').run(id);
  log(id, 'deleted', it.title);
  return it;
}

export function snooze(id: number, minutes: number): Item {
  const it = getItem(id);
  if (!it) throw new Error(`Нет записи #${id}`);
  db.prepare('UPDATE plan_items SET next_remind = ?, updated_at = ? WHERE id = ?').run(plusMin(nowLocal(), minutes), nowLocal(), id);
  return getItem(id)!;
}

/** Moves a repeating item to its next occurrence after now (or after the current one when `force`). */
function advance(it: Item, force = false) {
  const now = nowLocal();
  const passed = (a: string) => (a.length > 10 ? a <= now : a < now.slice(0, 10));
  let at = it.at!, end = it.end_at;
  const dur = hasTime(at) && hasTime(end) ? (wallMs(end) - wallMs(at)) / 60000 : null;
  if (force) at = nextOccurrence(at, it.repeat!);
  for (let i = 0; i < 1000 && passed(at); i++) at = nextOccurrence(at, it.repeat!);
  if (dur !== null) end = plusMin(at, dur);
  const next = computeRemind({ status: 'open', at, remind_before: it.remind_before });
  db.prepare('UPDATE plan_items SET at = ?, end_at = ?, next_remind = ?, updated_at = ? WHERE id = ?').run(at, end, next, now, it.id);
}

// ---------------------------------------------------------------- queries

export const dueReminders = (now = nowLocal()) =>
  db.prepare("SELECT * FROM plan_items WHERE status = 'open' AND next_remind IS NOT NULL AND next_remind <= ? ORDER BY next_remind").all(now) as Item[];

export function markReminded(it: Item) {
  db.prepare('UPDATE plan_items SET next_remind = NULL WHERE id = ?').run(it.id);
  log(it.id, 'reminded', it.title);
}

/** Repeating items whose occurrence has passed move on to the next one. */
export function rollRepeats() {
  const now = nowLocal();
  const rows = db.prepare("SELECT * FROM plan_items WHERE status = 'open' AND repeat IS NOT NULL AND at IS NOT NULL AND ((length(at) > 10 AND at <= ?) OR (length(at) = 10 AND at < ?))").all(now, now.slice(0, 10)) as Item[];
  for (const it of rows) advance(it);
  return rows.length;
}

export interface Find { query?: string; from?: string; to?: string; status?: Status | 'all'; kind?: Kind }
export function findItems(f: Find = {}, limit = 60): Item[] {
  const where: string[] = [], args: unknown[] = [];
  const status = f.status ?? 'open';
  if (status !== 'all') { where.push('status = ?'); args.push(status); }
  if (f.kind) { where.push('kind = ?'); args.push(f.kind); }
  if (f.from) { where.push('at >= ?'); args.push(normTime(f.from)); }
  if (f.to) { const t = normTime(f.to)!; where.push('at <= ?'); args.push(t.length === 10 ? t + 'T99' : t); }
  const order = status === 'open' ? "ORDER BY at IS NULL, at, priority DESC, id" : 'ORDER BY COALESCE(done_at, at, created_at) DESC';
  const rows = db.prepare(`SELECT * FROM plan_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ${order} LIMIT ${f.query ? 2000 : limit}`).all(...args) as Item[];
  if (!f.query) return rows;
  // SQLite's lower() is ASCII-only, so words are matched here (Cyrillic, any case; "ромой" finds "Рома" by stem).
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5).map((w) => (w.length > 4 ? w.slice(0, -2) : w));
  return rows.filter((it) => { const hay = [it.title, it.notes, it.people, it.place].join(' ').toLowerCase(); return words.every((w) => hay.includes(w)); }).slice(0, limit);
}

/** Open items: overdue, the next `days` days, and undated tasks. */
export function agenda(days = 14): Item[] {
  const today = todayLocal(), to = addDays(today, days);
  return db.prepare(`SELECT * FROM plan_items WHERE status = 'open' AND kind != 'note' AND (at IS NULL OR at <= ?) ORDER BY at IS NULL, at, priority DESC, id LIMIT 80`).all(to + 'T99') as Item[];
}

export function dayItems(date: string): Item[] {
  return db.prepare(`SELECT * FROM plan_items WHERE status != 'cancelled' AND kind != 'note' AND substr(at, 1, 10) = ? ORDER BY length(at), at, priority DESC`).all(date) as Item[];
}

export function overdue(): Item[] {
  const now = nowLocal();
  return db.prepare(`SELECT * FROM plan_items WHERE status = 'open' AND kind = 'task' AND at IS NOT NULL AND repeat IS NULL AND ((length(at) > 10 AND at < ?) OR (length(at) = 10 AND at < ?)) ORDER BY at`).all(now, now.slice(0, 10)) as Item[];
}

export const undated = () => db.prepare(`SELECT * FROM plan_items WHERE status = 'open' AND kind = 'task' AND at IS NULL ORDER BY priority DESC, id`).all() as Item[];

export function stats(from: string, to: string) {
  const one = (sql: string, ...a: unknown[]) => Number((db.prepare(sql).get(...a) as { n: number } | undefined)?.n ?? 0);
  return {
    // Every completion is logged (repeats included); counting done_at as well counted one-off items twice.
    done: one("SELECT COUNT(DISTINCT item_id || '|' || substr(at, 1, 10)) n FROM plan_log WHERE action = 'done' AND substr(at, 1, 10) BETWEEN ? AND ?", from, to),
    created: one("SELECT COUNT(*) n FROM plan_log WHERE action = 'created' AND substr(at, 1, 10) BETWEEN ? AND ?", from, to),
    events: one("SELECT COUNT(*) n FROM plan_items WHERE kind = 'event' AND status != 'cancelled' AND substr(at, 1, 10) BETWEEN ? AND ?", from, to),
    eventMin: one("SELECT COALESCE(SUM((julianday(end_at) - julianday(at)) * 1440), 0) n FROM plan_items WHERE kind = 'event' AND status != 'cancelled' AND length(at) > 10 AND length(end_at) > 10 AND substr(at, 1, 10) BETWEEN ? AND ?", from, to),
    open: one("SELECT COUNT(*) n FROM plan_items WHERE status = 'open' AND kind = 'task'"),
    overdue: overdue().length,
  };
}

/** Completions in [from, to] (one per item per day), newest first. */
export function doneIn(from: string, to: string): { item_id: number; title: string; at: string }[] {
  return db.prepare("SELECT item_id, title, MAX(at) at FROM plan_log WHERE action = 'done' AND substr(at, 1, 10) BETWEEN ? AND ? GROUP BY item_id, substr(at, 1, 10) ORDER BY at DESC").all(from, to) as { item_id: number; title: string; at: string }[];
}

/** Every open task, dated first. */
export const openTasks = () => db.prepare(`SELECT * FROM plan_items WHERE status = 'open' AND kind = 'task' ORDER BY at IS NULL, at, priority DESC, id`).all() as Item[];

export const hasPlan = () => Boolean(db.prepare('SELECT 1 FROM plan_items LIMIT 1').get());

// ---------------------------------------------------------------- formatting

const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
/** 'сегодня' / 'завтра' / 'вчера' / 'ср, 18 ноября'; pass today = '' for the full form. */
export function dayLabel(date: string, today = todayLocal()) {
  if (!today) today = '0000-01-01';
  if (date === today) return 'сегодня';
  if (date === addDays(today, 1)) return 'завтра';
  if (date === addDays(today, -1)) return 'вчера';
  const d = new Date(wallMs(date + 'T00:00'));
  return `${WD[d.getUTCDay()]}, ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}
export const timeOf = (it: Pick<Item, 'at' | 'end_at'>) => (hasTime(it.at) ? it.at.slice(11) + (hasTime(it.end_at) && it.end_at.slice(0, 10) === it.at.slice(0, 10) ? '–' + it.end_at.slice(11) : '') : '');
export const ICON: Record<Kind, string> = { task: '☑️', event: '📅', note: '📝' };
export const iconOf = (it: Pick<Item, 'kind' | 'source'>) => (it.source === 'reminders' ? '🔔' : it.source ? '🗓' : ICON[it.kind]);
const REPEAT_RU: Record<string, string> = { daily: 'каждый день', weekdays: 'по будням', weekly: 'каждую неделю', monthly: 'каждый месяц', yearly: 'каждый год' };
export function repeatLabel(r: string | null) {
  if (!r) return '';
  if (REPEAT_RU[r]) return REPEAT_RU[r];
  const names = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
  return 'по ' + r.slice(7).split(',').map((d) => names[+d]).join(', ');
}
export function remindLabel(min: number | null) {
  if (min === null) return '';
  if (min === 0) return 'напомню в момент';
  if (min % 1440 === 0) return `напомню за ${min / 1440} дн.`;
  if (min % 60 === 0) return `напомню за ${min / 60} ч`;
  return `напомню за ${min} мин`;
}

/** One line for the model's context: everything it needs to refer to an item. */
export function lineForModel(it: Item): string {
  const parts = [`#${it.id}`, it.kind, it.at ? it.at.replace('T', ' ') + (it.end_at ? '–' + it.end_at.replace('T', ' ').slice(it.end_at.slice(0, 10) === it.at.slice(0, 10) ? 11 : 0) : '') : 'без даты', JSON.stringify(it.title)];
  if (it.status !== 'open') parts.push(`[${it.status}${it.done_at ? ' ' + it.done_at.replace('T', ' ') : ''}]`);
  if (it.priority) parts.push(it.priority === 2 ? '!!срочно' : '!важно');
  if (it.repeat) parts.push(`повтор=${it.repeat}`);
  if (it.remind_before !== null) parts.push(`напомнить_за=${it.remind_before}мин`);
  if (it.people) parts.push(`с=${it.people}`);
  if (it.place) parts.push(`где=${it.place}`);
  if (it.notes) parts.push(`заметка=${JSON.stringify(it.notes.slice(0, 200))}`);
  if (it.source) parts.push(it.source === 'reminders' ? '[из «Напоминаний» iPhone, только чтение]' : '[из календаря iPhone, только чтение]');
  return parts.join(' ');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Telegram HTML card for one item. */
export function cardHtml(it: Item): string {
  const when = it.at ? `${dayLabel(it.at.slice(0, 10))}${timeOf(it) ? ', ' + timeOf(it) : ''}` : 'без срока';
  const meta = [repeatLabel(it.repeat), remindLabel(it.remind_before)].filter(Boolean).join(' · ');
  return [
    `${iconOf(it)} <b>${esc(it.title)}</b>${it.priority ? (it.priority === 2 ? ' ‼️' : ' ❗️') : ''}${it.status === 'done' ? ' ✅' : ''}`,
    it.kind !== 'note' ? `🕒 ${when}` : '',
    it.people ? `👥 ${esc(it.people)}` : '',
    it.place ? `📍 ${esc(it.place)}` : '',
    meta ? `🔔 ${meta}` : '',
    it.notes ? `<i>${esc(it.notes)}</i>` : '',
  ].filter(Boolean).join('\n');
}

/** The day's plan as Telegram HTML (null when there is nothing to say). */
export function dayPlanHtml(date = todayLocal()): string | null {
  const items = dayItems(date).filter((x) => x.status === 'open' || x.kind === 'event');
  const od = date === todayLocal() ? overdue() : [];
  const nodate = date === todayLocal() ? undated().slice(0, 7) : [];
  if (!items.length && !od.length && !nodate.length) return null;
  const line = (it: Item) => `${timeOf(it) ? `<b>${timeOf(it)}</b> ` : ''}${iconOf(it)} ${esc(it.title)}${it.place ? ` · ${esc(it.place)}` : ''}${it.priority ? ' ❗️' : ''}`;
  const out = [`🗓 <b>План на ${dayLabel(date)}</b>`];
  if (items.length) out.push('', ...items.map(line));
  else out.push('', 'Встреч и задач на этот день нет.');
  if (od.length) out.push('', `⚠️ <b>Просрочено</b>`, ...od.map((it) => `${iconOf(it)} ${esc(it.title)} <i>(${dayLabel(it.at!.slice(0, 10))})</i>`));
  if (nodate.length) out.push('', '📌 <b>Без срока</b>', ...nodate.map((it) => `${iconOf(it)} ${esc(it.title)}`));
  return out.join('\n');
}

/** Every occurrence in [from, to] (repeats expanded), for schedule answers. */
export function occurrences(from: string, to: string): { date: string; it: Item }[] {
  const rows = db.prepare(`SELECT * FROM plan_items WHERE status != 'cancelled' AND kind != 'note' AND at IS NOT NULL AND (substr(at, 1, 10) BETWEEN ? AND ? OR (repeat IS NOT NULL AND status = 'open' AND substr(at, 1, 10) <= ?))`).all(from, to, to) as Item[];
  const out: { date: string; it: Item }[] = [];
  for (const it of rows) {
    let at = it.at!;
    for (let i = 0; i < 400 && at.slice(0, 10) <= to; i++) {
      if (at.slice(0, 10) >= from) out.push({ date: at.slice(0, 10), it: { ...it, at, end_at: hasTime(it.end_at) && hasTime(it.at) ? plusMin(at, (wallMs(it.end_at) - wallMs(it.at)) / 60000) : it.end_at } });
      if (!it.repeat || it.status !== 'open') break;
      at = nextOccurrence(at, it.repeat);
    }
  }
  return out.sort((a, b) => (a.it.at!.length - b.it.at!.length) || a.it.at!.localeCompare(b.it.at!));
}

/** Plain-text schedule for [from, to], grouped by day (what the assistant sends for "что у меня…"). */
export function planText(from: string, to: string, opts: { overdue?: boolean; tasks?: boolean } = {}): string {
  const today = todayLocal();
  const occ = occurrences(from, to).filter((o) => opts.tasks !== false || o.it.kind === 'event');
  const days = [...new Set(occ.map((o) => o.date))].sort();
  const out: string[] = [];
  for (const d of days) {
    out.push(`${dayLabel(d, today).replace(/^./, (c) => c.toUpperCase())}${d === today || d === addDays(today, 1) ? `, ${dayLabel(d, '')}` : ''}:`);
    for (const { it } of occ.filter((o) => o.date === d)) out.push(`${timeOf(it) || 'весь день'} ${iconOf(it)} ${it.title}${it.place ? ` · ${it.place}` : ''}${it.repeat ? ' 🔁' : ''}${it.status === 'done' ? ' ✅' : ''}`);
    out.push('');
  }
  const od = from <= today && opts.overdue !== false ? overdue() : [];
  if (od.length) out.push('⚠️ Просрочено:', ...od.map((it) => `${iconOf(it)} ${it.title} (${dayLabel(it.at!.slice(0, 10), today)})`), '');
  return out.join('\n').trim() || 'Ничего не запланировано.';
}

// ---------------------------------------------------------------- iPhone calendar

export interface ExtEvent { title: string; start: string; end?: string | null; allDay?: boolean; location?: string | null; calendar?: string | null; notes?: string | null }

/** Any date the Shortcut sends (ISO 8601 with offset, or plain) → local wall clock. */
function toLocal(v: string, allDay: boolean): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  const local = new Date(ms).toLocaleString('sv-SE', { hour12: false }).replace(' ', 'T').slice(0, 16);
  return allDay ? local.slice(0, 10) : local;
}

/** Parses the Shortcut's text, one event per line: start|end|all-day|calendar|location|title (title last, may contain "|"). */
export function parseCalendarText(text: string): ExtEvent[] {
  return text.split(/\r?\n/).map((l) => l.split('|')).filter((f) => f.length >= 6 && f.slice(5).join('|').trim())
    .map(([start, end, allDay, calendar, location, ...title]) => ({
      start: start.trim(), end: end.trim(), allDay: /^(yes|true|1|да)$/i.test(allDay.trim()),
      title: title.join('|').trim(), location: location.trim() || null, calendar: calendar.trim() || null,
    }));
}

/** Replaces the copied upcoming events with a fresh snapshot (past ones stay for statistics). */
export function syncCalendar(events: ExtEvent[], source = 'icloud') {
  const today = todayLocal(), now = nowLocal();
  const rows = events
    .filter((e) => e && e.title && !/lifestats/i.test(e.calendar ?? ''))
    .map((e) => {
      const at = toLocal(e.start, Boolean(e.allDay));
      let end = e.end ? toLocal(e.end, Boolean(e.allDay)) : null;
      if (e.allDay) end = null; // all-day: shown as a date
      return at && at.slice(0, 10) >= today ? { title: String(e.title).slice(0, 300), at, end, place: e.location || null, notes: e.calendar ? `Календарь: ${e.calendar}` : null } : null;
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
  const seen = new Set<string>();
  const uniq = rows.filter((r) => { const k = `${r.at}|${r.title}`; if (seen.has(k)) return false; seen.add(k); return true; });
  db.prepare('DELETE FROM plan_items WHERE source = ? AND substr(at, 1, 10) >= ?').run(source, today);
  for (const r of uniq) {
    db.prepare(`INSERT INTO plan_items(kind, title, notes, at, end_at, remind_before, place, priority, status, next_remind, created_at, source)
      VALUES('event', ?, ?, ?, ?, NULL, ?, 0, 'open', NULL, ?, ?)`).run(r.title, r.notes, r.at, r.end, r.place, now, source);
  }
  kvSet(`calendar:${source}:last`, new Date().toISOString());
  return { events: uniq.length };
}

/**
 * Apple Reminders snapshot from the Shortcut, one per line: due|list|priority|title (title last).
 * Due "…T00:00:00" counts as a date without time; priority None/Low → 0, Medium → 1, High → 2.
 */
export function parseRemindersText(text: string) {
  return text.split(/\r?\n/).map((l) => l.split('|')).filter((f) => f.length >= 4 && f.slice(3).join('|').trim())
    .map(([due, list, prio, ...title]) => ({ due: due.trim(), list: list.trim() || null, priority: /high|высок/i.test(prio) ? 2 : /medium|средн/i.test(prio) ? 1 : 0, title: title.join('|').trim() }));
}

// ---------------------------------------------------------------- Apple Reminders write-back
// The server can't touch the iPhone: changes are queued here, and the "lifestats reminders" Shortcut
// fetches them (GET /reminders/ops), applies them with Edit Reminder / New Reminder, then sends a fresh snapshot.

function queueOp(op: 'done' | 'due' | 'new', title: string, due: string | null = null) {
  const same = db.prepare("SELECT id FROM reminder_ops WHERE status = 'pending' AND op = ? AND title = ?").get(op, title) as { id: number } | undefined;
  if (same) db.prepare('UPDATE reminder_ops SET due = ?, tries = 0 WHERE id = ?').run(due, same.id);
  else db.prepare('INSERT INTO reminder_ops(op, title, due, created_at) VALUES(?, ?, ?, ?)').run(op, title, due, nowLocal());
}

/** Bot edits of a copied reminder: only "done" and a new due date can go back to the iPhone. */
function updateReminder(old: Item, c: Fields): Item {
  const keys = Object.keys(c).filter((k) => (c as Record<string, unknown>)[k] !== undefined);
  if (keys.some((k) => k !== 'status' && k !== 'at')) throw new Error(`«${old.title}» — из приложения «Напоминания»: из бота его можно только отметить сделанным или перенести.`);
  if (c.status && c.status !== 'done' && c.status !== old.status) throw new Error('Отменять напоминания можно только в приложении «Напоминания».');
  if ('at' in c && c.at !== old.at) { queueOp('due', old.title, c.at ?? null); db.prepare('UPDATE plan_items SET at = ?, updated_at = ? WHERE id = ?').run(c.at ?? null, nowLocal(), old.id); log(old.id, 'moved', old.title); }
  if (c.status === 'done' && old.status !== 'done') { queueOp('done', old.title); db.prepare("UPDATE plan_items SET status = 'done', done_at = ?, updated_at = ? WHERE id = ?").run(nowLocal(), nowLocal(), old.id); log(old.id, 'done', old.title); }
  return getItem(old.id)!;
}

/** "Add to Reminders" from the bot: shows up here at once, on the iPhone after the next Shortcut run. */
export function addReminder(title: string, due: string | null): Item {
  const at = normTime(due);
  queueOp('new', title.trim(), at);
  const r = db.prepare(`INSERT INTO plan_items(kind, title, notes, at, remind_before, priority, status, next_remind, created_at, source)
    VALUES('task', ?, 'Добавится в «Напоминания» при следующей синхронизации', ?, NULL, 0, 'open', NULL, ?, 'reminders')`).run(title.trim(), at, nowLocal());
  log(Number(r.lastInsertRowid), 'created', title.trim());
  return getItem(Number(r.lastInsertRowid))!;
}

/** What the Shortcut should do now (each call counts as one delivery attempt). */
export function reminderOps() {
  db.prepare("UPDATE reminder_ops SET status = 'failed', done_at = ? WHERE status = 'pending' AND (tries >= 6 OR created_at < ?)").run(nowLocal(), wallIso(wallMs(nowLocal()) - 7 * 86400000).slice(0, 16));
  const ops = db.prepare("SELECT * FROM reminder_ops WHERE status = 'pending' ORDER BY id").all() as { id: number; op: string; title: string; due: string | null }[];
  if (ops.length) db.prepare(`UPDATE reminder_ops SET tries = tries + 1 WHERE id IN (${ops.map(() => '?').join(',')})`).run(...ops.map((o) => o.id));
  const due = (d: string | null) => (d ? (d.length > 10 ? `${d}:00` : d) : '');
  return {
    done: ops.filter((o) => o.op === 'done').map((o) => o.title),
    due: ops.filter((o) => o.op === 'due' && o.due).map((o) => ({ title: o.title, due: due(o.due) })),
    new: ops.filter((o) => o.op === 'new').map((o) => ({ title: o.title, due: due(o.due) })),
  };
}

/** Replaces all copied open reminders, keeping changes the iPhone hasn't applied yet. */
export function syncReminders(items: ReturnType<typeof parseRemindersText>) {
  const now = nowLocal();
  const rows = items.filter((r) => r.title).map((r) => {
    let at: string | null = null;
    if (r.due) {
      const ms = Date.parse(r.due);
      if (/^\d{4}-\d{2}-\d{2}$/.test(r.due)) at = r.due;
      else if (Number.isFinite(ms)) { const l = new Date(ms).toLocaleString('sv-SE', { hour12: false }).replace(' ', 'T').slice(0, 16); at = l.endsWith('T00:00') ? l.slice(0, 10) : l; }
    }
    return { ...r, at };
  });
  // Reconcile with queued changes: applied ones are confirmed, pending ones stay visible as the bot shows them.
  const pending = db.prepare("SELECT * FROM reminder_ops WHERE status = 'pending'").all() as { id: number; op: string; title: string; due: string | null }[];
  const applied = (id: number) => db.prepare("UPDATE reminder_ops SET status = 'applied', done_at = ? WHERE id = ?").run(nowLocal(), id);
  const byTitle = new Map(rows.map((r) => [r.title, r]));
  const hidden = new Set<string>();
  for (const o of pending) {
    const row = byTitle.get(o.title);
    if (o.op === 'done') { if (!row) applied(o.id); else hidden.add(o.title); }
    else if (o.op === 'due') { if (!row || row.at === o.due) applied(o.id); else row.at = o.due; }
    else if (o.op === 'new') { if (row) applied(o.id); else rows.push({ due: '', list: null, priority: 0, title: o.title, at: o.due }); }
  }
  db.prepare("DELETE FROM plan_items WHERE source = 'reminders'").run();
  for (const r of rows.filter((x) => !hidden.has(x.title)).slice(0, 500)) {
    db.prepare(`INSERT INTO plan_items(kind, title, notes, at, remind_before, priority, status, next_remind, created_at, source)
      VALUES('task', ?, ?, ?, NULL, ?, 'open', NULL, ?, 'reminders')`).run(r.title.slice(0, 300), r.list ? `Список: ${r.list}` : null, r.at, r.priority, now);
  }
  kvSet('reminders:last', new Date().toISOString());
  return { reminders: Math.min(rows.length, 500) };
}

/** Bot records only (no copied calendar events), for the subscribed calendar feed. */
export const feedItems = () => db.prepare("SELECT * FROM plan_items WHERE source IS NULL AND kind != 'note' AND status != 'cancelled' AND at IS NOT NULL ORDER BY at").all() as Item[];

/** Free windows between `from`–`to` o'clock on a date (timed events only), e.g. "09:00–12:00". */
export function freeWindows(date: string, dayStart = '09:00', dayEnd = '22:00'): string[] {
  const busy = occurrences(date, date).map((o) => o.it).filter((it) => it.at!.length > 10 && it.kind === 'event')
    .map((it) => [it.at!.slice(11), it.end_at && it.end_at.length > 10 && it.end_at.slice(0, 10) === date ? it.end_at.slice(11) : it.at!.slice(11)] as [string, string])
    .sort((a, b) => a[0].localeCompare(b[0]));
  let cur = date === todayLocal() && nowLocal().slice(11) > dayStart ? nowLocal().slice(11) : dayStart;
  const out: string[] = [];
  for (const [a, b] of busy) {
    if (a > cur && a <= dayEnd) out.push(`${cur}–${a}`);
    if (b > cur) cur = b;
  }
  if (cur < dayEnd) out.push(`${cur}–${dayEnd}`);
  return out.filter((w) => { const [a, b] = w.split('–'); return wallMs(`${date}T${b}`) - wallMs(`${date}T${a}`) >= 30 * 60000; });
}

export const planHour = () => kvGet('plan:hour') || '08:00';
export const setPlanHour = (hhmm: string) => kvSet('plan:hour', hhmm);
