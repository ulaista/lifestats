// Watchdog: once a day (and on /status) checks that every feed and moving part is alive, and tells the owner
// in Telegram what broke and how to fix it — so nothing silently stops. It also repairs the one thing it can:
// a Groq model that was retired is swapped for an available one.
import { db, kvGet, kvSet } from '../db.ts';
import * as R from './routines.ts';
import { assistantEnabled, modelList, setModelList } from './assistant.ts';
import { lastfmEnabled } from '../import/lastfm.ts';
import { llm, authHeader } from './llm.ts';

export interface Check { key: string; ok: boolean; label: string; detail: string; fix?: string }

const hoursSince = (iso: string | undefined | null) => {
  if (!iso) return null;
  const ms = Date.parse(iso.length <= 19 ? iso + '+03:00' : iso);
  return Number.isFinite(ms) ? (Date.now() - ms) / 3600_000 : null;
};
const ago = (h: number | null) => (h === null ? 'никогда' : h < 1 ? `${Math.max(1, Math.round(h * 60))} мин назад` : h < 48 ? `${Math.round(h)} ч назад` : `${Math.round(h / 24)} дн назад`);

/** A feed is fine if it arrived within `maxH`; a feed that was never set up is skipped. */
function feed(key: string, label: string, kvKey: string, maxH: number, fix: string, required = false): Check | null {
  const h = hoursSince(kvGet(kvKey));
  if (h === null && !required) return null;
  return { key, ok: h !== null && h <= maxH, label, detail: `последние данные ${ago(h)}`, fix };
}

/** Groq: the key works and the configured models still exist; retired ones are replaced automatically. */
async function groqCheck(): Promise<Check | null> {
  if (!assistantEnabled()) return null;
  try {
    const res = await fetch(`${llm.base()}/models`, { headers: authHeader(llm.key()), signal: AbortSignal.timeout(10_000) });
    if (res.status === 401) return { key: 'groq', ok: false, label: 'Ассистент (ИИ)', detail: 'ключ ИИ-провайдера больше не принимается', fix: 'создай новый ключ у провайдера и обнови LLM_API_KEY (или GROQ_API_KEY) на сервере' };
    if (!res.ok) return { key: 'groq', ok: false, label: 'Ассистент (ИИ)', detail: `провайдер отвечает ${res.status}`, fix: 'обычно проходит само; если держится день — проверь статус провайдера' };
    const ids: string[] = ((await res.json()) as { data?: { id: string; active?: boolean }[] }).data?.filter((m) => m.active !== false).map((m) => m.id) ?? [];
    const have = new Set(ids), cur = modelList();
    const missing = cur.filter((m) => !have.has(m));
    if (!missing.length) return { key: 'groq', ok: true, label: 'Ассистент (ИИ)', detail: `модели на месте: ${cur.join(', ')}` };
    // Self-repair: keep the live ones, add the best available chat models as replacements.
    const prefer = [/gpt-oss-120b/, /qwen/, /gpt-oss-20b/, /llama-3\.3-70b/, /llama-4/, /kimi/, /deepseek/];
    const extra = prefer.flatMap((re) => ids.filter((id) => re.test(id) && !/guard|whisper|tts|safeguard/.test(id)));
    const next = [...new Set([...cur.filter((m) => have.has(m)), ...extra])].slice(0, 3);
    if (!next.length) return { key: 'groq', ok: false, label: 'Ассистент (ИИ)', detail: `пропали модели: ${missing.join(', ')}, замены не нашлось`, fix: 'задай рабочие модели в ASSISTANT_MODELS' };
    setModelList(next);
    return { key: 'groq', ok: true, label: 'Ассистент (ИИ)', detail: `провайдер убрал ${missing.join(', ')} — сам переключился на ${next.join(', ')}` };
  } catch (e) {
    return { key: 'groq', ok: false, label: 'Ассистент (ИИ)', detail: `провайдер недоступен: ${(e as Error).message}`, fix: 'обычно проходит само; если держится день — проверь статус провайдера' };
  }
}

/** Watch routines: the public channel pages still parse into posts. */
async function channelChecks(): Promise<Check[]> {
  const out: Check[] = [];
  for (const r of R.listRoutines().filter((x) => x.kind === 'watch' && x.enabled && x.channels)) {
    for (const ch of r.channels!.split(',')) {
      try {
        const posts = await R.fetchChannel(ch);
        out.push({ key: `ch:${ch}`, ok: posts.length > 0, label: `Канал @${ch}`, detail: posts.length ? `читается (${posts.length} постов на странице)` : 'страница открывается, но постов не видно', fix: 'Telegram мог поменять страницу канала — нужно обновить разбор в fetchChannel (server/plan/routines.ts)' });
      } catch (e) {
        out.push({ key: `ch:${ch}`, ok: false, label: `Канал @${ch}`, detail: `не открывается: ${(e as Error).message}`, fix: 'проверь, что канал публичный и не переименован' });
      }
    }
  }
  return out;
}

export async function runChecks(opts: { network?: boolean; fromCron?: boolean } = {}): Promise<Check[]> {
  const c: (Check | null)[] = [];
  if (opts.fromCron) {
    const h = hoursSince(kvGet('tick:last'));
    c.push({ key: 'tick', ok: h !== null && h < 0.25, label: 'Ежеминутный запуск (cron-job.org)', detail: `последний ${ago(h)}`, fix: 'зайди на cron-job.org и проверь, что задача включена (напоминания и план без неё не приходят)' });
  }
  c.push(feed('health', 'Здоровье с iPhone', 'hae:last', 30, 'запусти команду «lifestats» вручную и проверь её автоматизацию; iPhone должен быть разблокирован в момент запуска', true));
  c.push(feed('calendar', 'Календарь iPhone', 'calendar:icloud:last', 48, 'запусти команду календаря и проверь её автоматизацию'));
  c.push(feed('calendar_ics', 'Календари по ссылке', 'calendar:ics:last', 6, `не удаётся загрузить: ${kvGet('calendar:ics:error') || 'проверь ссылки командой /ical'}`));
  c.push(feed('reminders', '«Напоминания»', 'reminders:last', 48, 'запусти команду «lifestats reminders» и проверь её автоматизацию'));
  c.push(feed('screen', 'Экранное время', 'screentime:last', 72, 'проверь автоматизации «Приложение открыто/закрыто» в «Командах»'));
  c.push(feed('backup', 'Резервная копия базы', 'backup:last', 9 * 24, 'отправь боту /backup — копия придёт файлом в чат'));
  if (lastfmEnabled()) c.push(feed('lastfm', 'Музыка (Last.fm)', 'lastfm:last_sync', 36, 'проверь, что скробблинг в Last.fm включён'));

  for (const r of R.listRoutines().filter((x) => x.enabled)) {
    const failed = /^ошибка/i.test(r.last_result ?? '');
    const late = r.next_run ? hoursSince(r.next_run) : null;
    if (failed) c.push({ key: `r:${r.id}`, ok: false, label: `«${r.title}»`, detail: (r.last_result ?? '').slice(0, 160), fix: 'запусти её вручную в «Плане» (▶) и посмотри текст ошибки' });
    else if (late !== null && late > 2) c.push({ key: `r:${r.id}`, ok: false, label: `«${r.title}»`, detail: `должна была запуститься ${ago(late)}, но не запустилась`, fix: 'проверь ежеминутный запуск (/tick)' });
  }
  const failedOps = Number((db.prepare("SELECT COUNT(*) n FROM reminder_ops WHERE status = 'failed' AND created_at >= datetime('now', '-3 days')").get() as { n: number } | undefined)?.n ?? 0);
  if (failedOps) c.push({ key: 'remops', ok: false, label: 'Изменения «Напоминаний»', detail: `${failedOps} не применились на iPhone за неделю`, fix: 'проверь блоки в начале команды «lifestats reminders»' });
  for (const k of ['morning', 'evening'] as const) {
    try {
      const d = JSON.parse(kvGet(`digest:${k}`) || 'null');
      if (d?.error && (hoursSince(d.at) ?? 99) < 26) c.push({ key: `dg:${k}`, ok: false, label: k === 'morning' ? 'Утренний разбор' : 'Вечерний разбор', detail: `ИИ не ответил: ${String(d.error).slice(0, 120)}`, fix: 'обычно это разовый лимит провайдера ИИ; если повторяется — проверь ключ и модели' });
    } catch { /* ignore */ }
  }
  if (opts.network !== false) {
    c.push(await groqCheck());
    c.push(...(await channelChecks()));
  }
  return c.filter((x): x is Check => !!x);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function statusHtml(checks: Check[]): string {
  const bad = checks.filter((x) => !x.ok);
  return [
    bad.length ? `⚠️ <b>Проблем: ${bad.length}</b>` : '✅ <b>Всё работает</b>',
    '',
    ...checks.map((x) => `${x.ok ? '✅' : '⚠️'} <b>${esc(x.label)}</b> — ${esc(x.detail)}${!x.ok && x.fix ? `\n   → ${esc(x.fix)}` : ''}`),
  ].join('\n');
}

/**
 * Daily alert: only when something is broken, and only if the set of problems changed or 3 days passed
 * (no daily nagging about the same thing); one "all fixed" message when it recovers.
 */
export function alertFor(checks: Check[]): string | null {
  const bad = checks.filter((x) => !x.ok), keys = bad.map((x) => x.key).sort();
  let prev: { keys: string[]; sent: string } = { keys: [], sent: '' };
  try { prev = JSON.parse(kvGet('watchdog:state') || 'null') ?? prev; } catch { /* first run */ }
  const healed = checks.filter((x) => x.ok && /сам переключился/.test(x.detail));
  const changed = keys.join() !== prev.keys.join();
  const stale = (hoursSince(prev.sent) ?? 999) >= 72;
  let msg: string | null = null;
  if (bad.length && (changed || stale)) {
    msg = ['🛡 <b>Сторож lifestats: что-то сломалось</b>', '', ...bad.map((x) => `⚠️ <b>${esc(x.label)}</b> — ${esc(x.detail)}${x.fix ? `\n   → ${esc(x.fix)}` : ''}`), '', 'Полный список — /status'].join('\n');
  } else if (!bad.length && prev.keys.length) {
    msg = '🛡 <b>Сторож lifestats:</b> всё снова работает ✅';
  }
  if (healed.length) msg = [msg, ...healed.map((x) => `🔧 ${esc(x.label)}: ${esc(x.detail)}`)].filter(Boolean).join('\n\n');
  kvSet('watchdog:state', JSON.stringify({ keys, sent: msg ? new Date().toISOString() : prev.sent }));
  return msg;
}
