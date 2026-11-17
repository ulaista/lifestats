// Routines: things the assistant does on its own on a schedule.
//   prompt — runs an instruction ("каждый вечер в 21:30 итоги дня") and sends the answer;
//   watch  — reads public Telegram channels (t.me/s/<name>) and reports new posts that match the task;
//   search — searches the web (Groq's built-in browser search) and reports only findings not sent before.
import { db, kvGet, kvSet } from '../db.ts';
import { nowLocal, nextOccurrence, normTime, normRepeat } from './store.ts';
import { wallMs, wallIso, addDays } from '../lib/time.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS routines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,               -- prompt | watch
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,               -- what to do / what to look for
  channels    TEXT,                        -- watch: comma-separated public channel usernames
  next_run    TEXT,                        -- local 'YYYY-MM-DDTHH:MM'
  repeat      TEXT,                        -- daily | weekdays | weekly[:1,3] | monthly | yearly | every:N (minutes) | NULL = once
  enabled     INTEGER NOT NULL DEFAULT 1,
  state       TEXT,                        -- JSON: watch → last seen post id per channel
  last_run    TEXT,
  last_result TEXT,
  created_at  TEXT NOT NULL
);
`);

export type RoutineKind = 'prompt' | 'watch' | 'search';
export interface Routine {
  id: number; kind: RoutineKind; title: string; prompt: string; channels: string | null; next_run: string | null;
  repeat: string | null; enabled: number; state: string | null; last_run: string | null; last_result: string | null; created_at: string;
}

const plusMin = (local: string, m: number) => wallIso(wallMs(local) + m * 60000).slice(0, 16);
const every = (r: string | null) => (r && /^every:\d+$/.test(r) ? Math.max(5, Number(r.slice(6))) : null);

function cleanRepeat(v: unknown): string | null {
  if (typeof v === 'string' && /^every:\d+$/.test(v)) return `every:${Math.max(5, Number(v.slice(6)))}`;
  return normRepeat(v);
}
function cleanChannels(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const list = String(v).split(/[\s,]+/).map((c) => c.replace(/^https?:\/\/t\.me\/(s\/)?/i, '').replace(/^@/, '').replace(/\/.*$/, '')).filter((c) => /^[A-Za-z0-9_]{4,64}$/.test(c));
  if (!list.length) throw new Error('Нужны публичные каналы: @name или t.me/name');
  return [...new Set(list)].join(',');
}

/** First run on a day the rule allows ("по воскресеньям" never starts on a Friday). */
function align(at: string, repeat: string | null): string {
  if (!repeat || !/^(weekdays|weekly:)/.test(repeat)) return at;
  return nextOccurrence(addDays(at.slice(0, 10), -1) + at.slice(10), repeat);
}

/** After a run: the next time, or null for a one-off. */
function following(r: Pick<Routine, 'next_run' | 'repeat'>, now = nowLocal()): string | null {
  const n = every(r.repeat);
  if (n) return plusMin(now, n);
  if (!r.repeat || !r.next_run) return null;
  let at = r.next_run.length > 10 ? r.next_run : r.next_run + 'T09:00';
  for (let i = 0; i < 2000 && at <= now; i++) at = nextOccurrence(at, r.repeat);
  return at;
}

export const getRoutine = (id: number) => (db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as Routine | undefined) ?? null;
export const listRoutines = () => db.prepare('SELECT * FROM routines ORDER BY id').all() as Routine[];
export const dueRoutines = (now = nowLocal()) => {
  const forced = new Set((kvGet('routines:now') || '').split(',').filter(Boolean).map(Number));
  return (db.prepare('SELECT * FROM routines WHERE enabled = 1 ORDER BY next_run').all() as Routine[])
    .filter((r) => forced.has(r.id) || (r.next_run !== null && r.next_run <= now)).slice(0, 3);
};

export interface RoutineFields { kind?: RoutineKind; title?: string; prompt?: string; channels?: string | null; at?: string | null; repeat?: string | null; enabled?: boolean }

export function addRoutine(f: RoutineFields & { kind: RoutineKind; title: string; prompt: string }): Routine {
  if (!['prompt', 'watch', 'search'].includes(f.kind)) throw new Error('kind: prompt | watch | search');
  const channels = f.kind === 'watch' ? cleanChannels(f.channels) : null;
  if (f.kind === 'watch' && !channels) throw new Error('Для слежения нужны каналы');
  let repeat = cleanRepeat(f.repeat ?? (f.kind === 'watch' ? 'every:30' : f.kind === 'search' ? 'daily' : null));
  const at = normTime(f.at) ?? nowLocal();
  const next = align(at.length > 10 ? at : at + 'T09:00', repeat);
  const r = db.prepare('INSERT INTO routines(kind, title, prompt, channels, next_run, repeat, enabled, created_at) VALUES(?, ?, ?, ?, ?, ?, 1, ?)')
    .run(f.kind, f.title.trim(), f.prompt.trim(), channels, next, repeat, nowLocal());
  return getRoutine(Number(r.lastInsertRowid))!;
}

export function updateRoutine(id: number, f: RoutineFields): Routine {
  const old = getRoutine(id);
  if (!old) throw new Error(`Нет регулярного действия #${id}`);
  const it = { ...old };
  if (f.title) it.title = f.title.trim();
  if (f.prompt) it.prompt = f.prompt.trim();
  if (f.channels !== undefined && it.kind === 'watch') it.channels = cleanChannels(f.channels);
  if (f.repeat !== undefined) it.repeat = cleanRepeat(f.repeat);
  if (f.at || f.repeat !== undefined) { const a = f.at ? normTime(f.at)! : it.next_run ?? nowLocal(); it.next_run = align(a.length > 10 ? a : a + 'T09:00', it.repeat); }
  if (f.enabled !== undefined) {
    it.enabled = f.enabled ? 1 : 0;
    if (f.enabled && (!it.next_run || it.next_run < nowLocal())) it.next_run = every(it.repeat) ? nowLocal() : following(it) ?? nowLocal();
  }
  db.prepare('UPDATE routines SET title=?, prompt=?, channels=?, next_run=?, repeat=?, enabled=? WHERE id=?').run(it.title, it.prompt, it.channels, it.next_run, it.repeat, it.enabled, id);
  return getRoutine(id)!;
}

export function deleteRoutine(id: number): Routine {
  const it = getRoutine(id);
  if (!it) throw new Error(`Нет регулярного действия #${id}`);
  db.prepare('DELETE FROM routines WHERE id = ?').run(id);
  return it;
}

/** Book the next run before working, so a failure never makes it fire every minute. */
export function claim(r: Routine) {
  // A manual run (▶) keeps the schedule: it only marks the run, the next regular time stays as it was.
  const forced = (kvGet('routines:now') || '').split(',').filter(Boolean);
  if (forced.includes(String(r.id)) && !(r.next_run && r.next_run <= nowLocal())) {
    kvSet('routines:now', forced.filter((x) => x !== String(r.id)).join(','));
    db.prepare('UPDATE routines SET last_run = ? WHERE id = ?').run(nowLocal(), r.id);
    return;
  }
  if (forced.includes(String(r.id))) kvSet('routines:now', forced.filter((x) => x !== String(r.id)).join(','));
  const next = following(r);
  db.prepare('UPDATE routines SET next_run = ?, enabled = ?, last_run = ? WHERE id = ?').run(next, next ? r.enabled : 0, nowLocal(), r.id);
}
export const saveResult = (id: number, result: string, state?: unknown) =>
  db.prepare(`UPDATE routines SET last_result = ?${state === undefined ? '' : ', state = ?'} WHERE id = ?`).run(...(state === undefined ? [result.slice(0, 2000), id] : [result.slice(0, 2000), JSON.stringify(state), id]));
/** Run on the next tick without moving the regular schedule. */
export function runNow(id: number) {
  const r = getRoutine(id);
  if (!r) throw new Error(`Нет регулярного действия #${id}`);
  if (!r.enabled) updateRoutine(id, { enabled: true });
  const forced = new Set((kvGet('routines:now') || '').split(',').filter(Boolean));
  forced.add(String(id));
  kvSet('routines:now', [...forced].join(','));
}

// ---------------------------------------------------------------- labels

const REPEAT_RU: Record<string, string> = { daily: 'каждый день', weekdays: 'по будням', weekly: 'каждую неделю', monthly: 'каждый месяц', yearly: 'каждый год' };
export function scheduleLabel(r: Pick<Routine, 'repeat' | 'next_run'>): string {
  const n = every(r.repeat);
  const time = r.next_run && r.next_run.length > 10 ? r.next_run.slice(11) : '';
  if (n) return n % 60 === 0 ? `каждые ${n / 60} ч` : `каждые ${n} мин`;
  if (!r.repeat) return r.next_run ? `один раз, ${r.next_run.replace('T', ' ')}` : 'один раз';
  if (REPEAT_RU[r.repeat]) return `${REPEAT_RU[r.repeat]}${time ? ' в ' + time : ''}`;
  const names = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
  return `по ${r.repeat.slice(7).split(',').map((d) => names[+d]).join(', ')}${time ? ' в ' + time : ''}`;
}
export function lineForModel(r: Routine): string {
  return `R#${r.id} ${r.kind} ${JSON.stringify(r.title)} ${scheduleLabel(r)}${r.channels ? ` каналы=${r.channels}` : ''}${r.enabled ? '' : ' [на паузе]'} задание=${JSON.stringify(r.prompt.slice(0, 300))}`;
}

// ---------------------------------------------------------------- Telegram channels

export interface Post { channel: string; id: number; date: string; text: string; url: string }

const decode = (s: string) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&').trim();

/** Latest ~20 posts of a public channel from its web preview. */
export async function fetchChannel(channel: string): Promise<Post[]> {
  const res = await fetch(`https://t.me/s/${channel}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; lifestats)', 'accept-language': 'ru' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`t.me/s/${channel}: ${res.status}`);
  const html = await res.text();
  const posts: Post[] = [];
  for (const chunk of html.split('tgme_widget_message_wrap').slice(1)) {
    const m = /data-post="([^"/]+)\/(\d+)"/.exec(chunk);
    if (!m) continue;
    const text = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(chunk)?.[1];
    const date = /<time[^>]*datetime="([^"]+)"/.exec(chunk)?.[1] ?? '';
    posts.push({ channel: m[1], id: Number(m[2]), date, text: text ? decode(text) : '', url: `https://t.me/${m[1]}/${m[2]}` });
  }
  return posts;
}
