// lifestats Telegram bot. The main screen is a live HTML widget (Bot API 10.4) that asks the bot
// for numbers; details and scheduled summaries are rich messages (tables). Answers only its owner.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Telegram, TgError } from './telegram.ts';
import { WIDGET_HTML, widgetPayload } from './widget.ts';
import { kvGet, kvSet } from '../db.ts';
import { config } from '../config.ts';
import { onUpdate } from '../events.ts';
import { buildScreen, periodFor, availableSections, SECTIONS, KINDS, type Section, type RichBlock } from '../stats/views.ts';
import { addDays, shift, type PeriodKind } from '../lib/period.ts';
import * as Q from '../stats/queries.ts';
import { num, plural } from '../lib/format.ts';
import { importAny } from '../import/index.ts';
import { macMusicState } from '../import/mac-music.ts';
import { watchState } from '../watch.ts';
import * as P from '../plan/store.ts';
import { ask, assistantEnabled, resetHistory, runRoutine, statsText } from '../plan/assistant.ts';
import { dueDigest, makeDigest, digestHtml } from '../plan/digest.ts';
import { runChecks, statusHtml, alertFor } from '../plan/watchdog.ts';
import { runSubs } from '../plan/budget.ts';
import { makeBackup } from '../backup.ts';

/** A forwarded message may only create records from its content — never edit or delete existing ones. */
const FORWARD_TOOLS = ['add_item', 'find_items', 'show_plan', 'add_reminder'];
import * as R from '../plan/routines.ts';
import * as M from '../plan/money.ts';
import { transcribe, voiceEnabled } from '../plan/voice.ts';
import { feedKey } from '../plan/ics.ts';

const COMMANDS: [string, string][] = [
  ['plan', 'План на сегодня'], ['tasks', 'Все задачи'], ['money', 'Расходы за месяц'], ['calendar', 'Связь с Календарём iPhone'], ['routines', 'Регулярные действия'], ['app', 'Открыть дашборд'], ['menu', 'Дашборд в чате'], ['today', 'Сегодня текстом'], ['week', 'Неделя'], ['month', 'Месяц'], ['year', 'Год'], ['all', 'За всё время'],
  ['sleep', 'Сон'], ['activity', 'Активность'], ['heart', 'Сердце'], ['workouts', 'Тренировки'], ['music', 'Музыка'],
  ['status', 'Проверка: всё ли работает'], ['siri', 'Ключ для команды Siri'], ['backup', 'Резервная копия базы'], ['shortcut', 'Ключ для команд iPhone'],
  ['reports', 'Автосводки вкл/выкл'], ['forget', 'Забыть разговор'], ['help', 'Помощь'],
];
const SECTION_CMD: Record<string, Section> = { sleep: 'sleep', activity: 'steps', steps: 'steps', heart: 'heart', workouts: 'workouts', music: 'music', screen: 'screen' };
const KIND_CMD: Record<string, PeriodKind> = { today: 'day', week: 'week', month: 'month', year: 'year', all: 'all' };
const VALID_SECTIONS = new Set(SECTIONS.map(([s]) => s));
const VALID_KINDS = new Set(KINDS.map(([k]) => k));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tgTime = (iso: string | null, fallback = 'никогда') => (iso ? `<tg-time unix="${Math.floor(Date.parse(iso) / 1000)}" format="r">${new Date(iso).toLocaleString('ru-RU')}</tg-time>` : fallback);
const localDate = (d = new Date()) => d.toLocaleDateString('sv-SE');

interface View { section: Section; kind: PeriodKind; offset: number }
function parseView(s: string): View | null {
  const [sec, kind, off] = s.split('|');
  if (!VALID_SECTIONS.has(sec as Section) || !VALID_KINDS.has(kind as PeriodKind)) return null;
  return { section: sec as Section, kind: kind as PeriodKind, offset: Math.max(0, Math.min(500, Number(off) || 0)) };
}

export class Bot {
  private tg: Telegram;
  private offset = Number(kvGet('tg:offset') || 0);
  private richOk = true;
  private widgetsOffUntil = 0;
  private liveTimer: ReturnType<typeof setTimeout> | undefined;
  private lastLive = 0;
  /** Public HTTPS address of the Mini App (changes whenever the quick tunnel restarts). */
  appUrl: string | null = null;

  constructor(token: string) { this.tg = new Telegram(token); this.appUrl = process.env.APP_URL || null; }

  /** Webhook mode (cloud): handle one update from Telegram. */
  processUpdate(u: unknown) { return this.handle(u); }
  /** Webhook mode: call Telegram directly (setup scripts). */
  api<T = unknown>(method: string, params: Record<string, unknown> = {}) { return this.tg.call<T>(method, params); }

  get owner(): number | null { const v = kvGet('tg:owner'); return v ? Number(v) : null; }
  /** A message to the owner from outside the update flow (watchdog). */
  async notifyOwner(html: string) { const o = this.owner; if (o) await this.send(o, html); }
  get widget(): { chatId: number; messageId: number } | null { const v = kvGet('tg:widget'); return v ? JSON.parse(v) : null; }
  get reportsOn() { return kvGet('tg:reports') !== 'off'; }

  async start() {
    const me = await this.tg.call<{ username: string }>('getMe');
    await this.tg.call('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) }).catch(() => {});
    await this.tg.call('setChatMenuButton', { menu_button: { type: 'commands' } }).catch(() => {});
    if (!this.owner) {
      let code = kvGet('tg:pair');
      if (!code) { code = String(crypto.randomInt(100000, 999999)); kvSet('tg:pair', code); }
      const msg = `Открой @${me.username} в Telegram и отправь:  /start ${code}`;
      console.log(`\n🔑 ${msg}\n`);
      fs.writeFileSync(path.join(config.dataDir, 'telegram-pairing.txt'), msg + '\n');
    } else console.log(`[bot] @${me.username} работает`);
    onUpdate(() => this.onData());
    setInterval(() => this.schedule().catch((e) => console.error('[bot] schedule', e.message)), 60_000);
    this.loop();
  }

  private async loop() {
    for (;;) {
      try {
        const updates = await this.tg.call<any[]>('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message', 'callback_query', 'widget_query'] });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          kvSet('tg:offset', String(this.offset));
          await this.handle(u).catch((e) => console.error('[bot] update', e));
        }
      } catch (e) {
        console.error('[bot] getUpdates', (e as Error).message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async handle(u: any): Promise<unknown> {
    if (u.widget_query) return this.onWidgetQuery(u.widget_query);
    if (u.inline_query) return this.onInline(u.inline_query);
    const from = u.message?.from ?? u.callback_query?.from;
    const chatId: number | undefined = u.message?.chat?.id ?? u.callback_query?.message?.chat?.id;
    if (!from || !chatId) return;
    if (!this.owner) {
      const code = kvGet('tg:pair');
      const m = /^\/start\s+(\d{6})/.exec(u.message?.text ?? '');
      if (m && code && m[1] === code && u.message.chat.type === 'private') {
        kvSet('tg:owner', String(from.id));
        kvSet('tg:pair', '');
        fs.rmSync(path.join(config.dataDir, 'telegram-pairing.txt'), { force: true });
        await this.send(chatId, '✅ Бот привязан к тебе и больше никому отвечать не будет.');
        if (this.appUrl) await this.setAppUrl(this.appUrl);
        return this.appUrl ? this.sendAppButton(chatId) : this.sendWidget(chatId);
      }
      return this.send(chatId, 'Это личный бот. Чтобы привязать его, отправь /start и код из консоли сервера.');
    }
    if (from.id !== this.owner) return;
    // Private chat only: in a group the owner's "/plan" would show personal data to everyone there.
    const chatType = u.message?.chat?.type ?? u.callback_query?.message?.chat?.type;
    if (chatType && chatType !== 'private') return;
    if (u.callback_query) return this.onCallback(u.callback_query);
    const msg = u.message;
    if ((msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_sender_name) && assistantEnabled()) return this.onForward(chatId, msg);
    if (msg.document) return this.onFile(chatId, msg.document);
    if (msg.voice || msg.audio || msg.video_note) return this.onVoice(chatId, msg);
    const cmd = /^\/(\w+)/.exec(msg.text ?? '')?.[1]?.toLowerCase();
    if (!cmd && msg.text && assistantEnabled()) return this.onText(chatId, msg.text);
    if (cmd === 'app' || cmd === 'start') return this.appUrl ? this.sendAppButton(chatId) : this.sendWidget(chatId);
    if (cmd === 'plan') return this.send(chatId, P.dayPlanHtml() ?? '🗓 На сегодня ничего не запланировано. Напиши или надиктуй, что добавить.');
    if (cmd === 'tasks') return this.send(chatId, this.tasksText());
    if (cmd === 'calendar') return this.send(chatId, this.calendarText());
    if (cmd === 'siri') return this.send(chatId, this.siriText());
    if (cmd === 'backup') return this.sendBackup(chatId);
    if (cmd === 'routines') return this.sendRoutines(chatId);
    if (cmd === 'money') return this.send(chatId, esc(statsText('money', 'month')));
    if (cmd === 'forget') { resetHistory(); return this.send(chatId, '🧹 Разговор забыт. Задачи и встречи на месте.'); }
    if (!cmd || cmd === 'menu') return this.sendWidget(chatId);
    if (KIND_CMD[cmd]) return this.sendDashboard(chatId, { section: 'home', kind: KIND_CMD[cmd], offset: 0 });
    if (SECTION_CMD[cmd]) return this.sendDashboard(chatId, { section: SECTION_CMD[cmd], kind: 'month', offset: 0 });
    if (cmd === 'status') return this.send(chatId, statusHtml(await runChecks()).slice(0, 4000));
    if (cmd === 'shortcut') return this.send(chatId, this.shortcutText());
    if (cmd === 'reports') { kvSet('tg:reports', this.reportsOn ? 'off' : 'on'); return this.send(chatId, this.reportsOn ? '🔔 Автосводки включены: утро, понедельник, 1-е число, Новый год.' : '🔕 Автосводки выключены.'); }
    return this.send(chatId, this.helpText());
  }

  // ---------------------------------------------------------------- Mini App

  private appButton(text = '📊 Открыть дашборд', styled = true) { return this.appUrl ? [{ text, web_app: { url: this.appUrl }, ...(styled ? { style: 'primary' } : {}) }] : null; }

  /** New tunnel address: point the chat's menu button at it. */
  async setAppUrl(url: string) {
    this.appUrl = url;
    const owner = this.owner;
    if (!owner) return;
    try {
      await this.tg.call('setChatMenuButton', { chat_id: owner, menu_button: { type: 'web_app', text: 'Статистика', web_app: { url } } });
      // The "open" button in the last /app message must follow the new address too.
      const m = kvGet('tg:appmsg');
      if (m) {
        const { chatId, messageId } = JSON.parse(m);
        await this.tg.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [this.appButton()!] } })
          .catch((e) => { if (!/not modified/i.test(e.description ?? '')) kvSet('tg:appmsg', ''); });
      }
    } catch (e) {
      // Network hiccup: keep trying, otherwise the button points at a dead tunnel address.
      console.warn('[bot] menu button:', (e as Error).message);
      setTimeout(() => { if (this.appUrl === url) this.setAppUrl(url); }, 30_000);
    }
  }

  /** One "open dashboard" message at a time; it is re-pointed whenever the tunnel address changes. */
  private async sendAppButton(chatId: number) {
    const markup = { inline_keyboard: [this.appButton()!] };
    const text = '📊 <b>lifestats</b>\nДашборд открывается во весь экран. Ещё он всегда под кнопкой <b>«Статистика»</b> слева от поля ввода.';
    let msg: any;
    try { msg = await this.send(chatId, text, { reply_markup: markup }); }
    catch (e) {
      if (!(e instanceof TgError && /style/i.test(e.description))) throw e;
      delete (markup.inline_keyboard[0][0] as Record<string, unknown>).style;
      msg = await this.send(chatId, text, { reply_markup: markup });
    }
    const old = kvGet('tg:appmsg');
    kvSet('tg:appmsg', JSON.stringify({ chatId, messageId: msg.message_id }));
    if (old) { const o = JSON.parse(old); if (o.messageId !== msg.message_id) this.tg.call('deleteMessage', { chat_id: o.chatId, message_id: o.messageId }).catch(() => {}); }
  }

  // ---------------------------------------------------------------- widget

  private async sendWidget(chatId: number) {
    if (process.env.WIDGETS === '0' || Date.now() < this.widgetsOffUntil) return this.sendDashboard(chatId, { section: 'home', kind: 'day', offset: 0 });
    try {
      const msg = await this.tg.call<any>('sendWidget', {
        chat_id: chatId, html: WIDGET_HTML, height: 470, allow_queries: true,
        chat_data: widgetPayload('home', 'day', 0),
        reply_markup: { inline_keyboard: [...(this.appUrl ? [this.appButton()!] : []), [{ text: '📋 Детали', callback_data: 'det' }, { text: '🔄 Обновить', callback_data: 'ref' }]] },
      });
      const old = this.widget;
      kvSet('tg:widget', JSON.stringify({ chatId, messageId: msg.message_id }));
      kvSet('tg:view', 'home|day|0');
      // One live dashboard at a time: remove the previous widget.
      if (old && old.messageId !== msg.message_id) this.tg.call('deleteMessage', { chat_id: old.chatId, message_id: old.messageId }).catch(() => {});
    } catch (e) {
      console.warn('[bot] sendWidget не прошёл, шлю текстом:', (e as Error).message);
      if (e instanceof TgError && (e.code === 404 || /method|widget/i.test(e.description))) this.widgetsOffUntil = Date.now() + 10 * 60_000;
      await this.sendDashboard(chatId, { section: 'home', kind: 'day', offset: 0 });
    }
  }

  private async onWidgetQuery(q: any) {
    if (q.from?.id !== this.owner) return this.tg.call('answerWidgetQuery', { widget_query_id: q.id }).catch(() => {});
    const v = parseView(String(q.data ?? ''));
    let data: string;
    if (v) { data = widgetPayload(v.section, v.kind, v.offset); kvSet('tg:view', `${v.section}|${v.kind}|${v.offset}`); }
    else data = JSON.stringify({ v: 'home|day|0', t: 'Ошибка', p: '', e: 'Неизвестный запрос', k: [], c: null });
    await this.tg.call('answerWidgetQuery', { widget_query_id: q.id, data });
  }

  /** New data arrived: push today's numbers into the widget (at most every 30 s). */
  private onData() {
    const w = this.widget;
    if (!w || !this.owner) return;
    clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => {
      this.lastLive = Date.now();
      this.tg.call('editMessageWidgetData', { chat_id: w.chatId, message_id: w.messageId, chat_data: widgetPayload('home', 'day', 0) })
        .catch((e) => console.warn('[bot] live update:', e.message));
    }, Math.max(2000, 30_000 - (Date.now() - this.lastLive)));
  }

  private async onCallback(q: any) {
    const chatId = q.message.chat.id;
    if (typeof q.data === 'string' && q.data.startsWith('p|')) return this.onPlanButton(q);
    if (typeof q.data === 'string' && q.data.startsWith('r|')) return this.onRoutineButton(q);
    if (typeof q.data === 'string' && q.data.startsWith('m|del|')) {
      let note = 'Удалено';
      try { M.deleteExpense(Number(q.data.slice(6))); } catch (e) { note = (e as Error).message; }
      await this.tg.call('answerCallbackQuery', { callback_query_id: q.id, text: note }).catch(() => {});
      const kb = (q.message.reply_markup?.inline_keyboard ?? []).filter((row: any[]) => row[0]?.callback_data !== q.data);
      return this.tg.call('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: kb } }).catch(() => {});
    }
    await this.tg.call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    if (q.data === 'ref') {
      const w = this.widget;
      if (w) await this.tg.call('editMessageWidgetData', { chat_id: w.chatId, message_id: w.messageId, chat_data: widgetPayload('home', 'day', 0) }).catch((e) => console.warn('[bot] refresh:', e.message));
      return;
    }
    if (typeof q.data === 'string' && q.data.startsWith('v|')) {
      const v = parseView(q.data.slice(2));
      if (v) return this.sendDashboard(chatId, v, q.message.message_id);
      return;
    }
    if (q.data === 'det') {
      const v = parseView(kvGet('tg:view') ?? '') ?? { section: 'home' as Section, kind: 'day' as PeriodKind, offset: 0 };
      return this.sendScreen(chatId, v.section, v.kind, v.offset);
    }
  }

  // ---------------------------------------------------------------- text dashboard (fallback when widgets aren't allowed)

  private keyboard(v: View) {
    const cb = (x: View) => `v|${x.section}|${x.kind}|${x.offset}`;
    const btn = (text: string, data: string, active = false) => ({ text, callback_data: data, ...(active ? { style: 'primary' } : {}) });
    const secs = availableSections().map((s) => btn(SECTIONS.find(([k]) => k === s)![1], cb({ section: s, kind: v.kind, offset: 0 }), s === v.section));
    const rows: unknown[][] = [];
    if (this.appUrl) rows.push(this.appButton('📱 Открыть во весь экран', false)!);
    for (let i = 0; i < secs.length; i += 4) rows.push(secs.slice(i, i + 4));
    rows.push(KINDS.map(([k, l]) => btn(l, cb({ section: v.section, kind: k, offset: 0 }), k === v.kind)));
    const nav = [btn('‹ Раньше', cb({ ...v, offset: v.offset + 1 }))];
    if (v.offset > 0) nav.push(btn('Позже ›', cb({ ...v, offset: v.offset - 1 })), btn('Сейчас', cb({ ...v, offset: 0 })));
    rows.push(nav);
    return { inline_keyboard: rows };
  }

  private screenFor(v: View) {
    let anchor: string | undefined;
    let p = periodFor(v.kind).period;
    for (let i = 0; i < v.offset; i++) { anchor = shift(p, -1); p = periodFor(v.kind, anchor).period; }
    return buildScreen(v.section, v.kind, anchor);
  }

  /** Rich message + buttons; switching edits the same message. */
  private async sendDashboard(chatId: number, v: View, editMessageId?: number) {
    const sc = this.screenFor(v);
    const markup = this.keyboard(v);
    kvSet('tg:view', `${v.section}|${v.kind}|${v.offset}`);
    const attempt = async (rich: boolean) => {
      if (editMessageId) {
        return this.tg.call('editMessageText', rich
          ? { chat_id: chatId, message_id: editMessageId, rich_message: { blocks: sc.blocks }, reply_markup: markup }
          : { chat_id: chatId, message_id: editMessageId, text: sc.html.slice(0, 4000), parse_mode: 'HTML', reply_markup: markup });
      }
      return rich
        ? this.tg.call('sendRichMessage', { chat_id: chatId, rich_message: { blocks: sc.blocks }, reply_markup: markup })
        : this.send(chatId, sc.html.slice(0, 4000), { reply_markup: markup });
    };
    try { await attempt(this.richOk); }
    catch (e) {
      if (e instanceof TgError && /not modified/i.test(e.description)) return;
      console.warn('[bot] dashboard:', (e as Error).message);
      if (e instanceof TgError && /style/i.test(e.description)) { for (const r of markup.inline_keyboard) for (const b of r as Record<string, unknown>[]) delete b.style; }
      if (this.richOk) { this.richOk = false; await attempt(false); } else throw e;
    }
  }

  // ---------------------------------------------------------------- text screens

  /** A section as a rich message (tables, headings, collapsible blocks); HTML text if rich messages fail. */
  private async sendScreen(chatId: number, section: Section, kind: PeriodKind, offset = 0, prefix: RichBlock[] = [], prefixHtml = '') {
    const sc = this.screenFor({ section, kind, offset });
    if (this.richOk) {
      try { await this.tg.call('sendRichMessage', { chat_id: chatId, rich_message: { blocks: [...prefix, ...sc.blocks] } }); return; }
      catch (e) { console.warn('[bot] rich message не прошёл, шлю HTML:', (e as Error).message); if (e instanceof TgError && e.code === 404) this.richOk = false; }
    }
    await this.send(chatId, (prefixHtml + sc.html).slice(0, 4000));
  }

  private async onFile(chatId: number, doc: any) {
    if (!/\.(zip|xml|csv|json)$/i.test(doc.file_name ?? '')) return this.send(chatId, 'Пришли export.zip, архив Apple Music или CSV.');
    if (doc.file_size > 20 * 1024 * 1024) return this.send(chatId, `Файл больше 20 МБ — через бота такой не скачать. Положи его в папку\n<code>${esc(path.join(config.dataDir, 'inbox'))}</code> на Mac — подхвачу сам.`);
    await this.send(chatId, '⏳ Импортирую…');
    const f = await this.tg.call<{ file_path: string }>('getFile', { file_id: doc.file_id });
    const dir = path.join(config.dataDir, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${Date.now()}-${path.basename(doc.file_name)}`);
    fs.writeFileSync(dest, await this.tg.download(f.file_path));
    try {
      const r = await importAny(dest);
      await this.send(chatId, `✅ Готово: ${Object.entries(r).map(([k, v]) => `${k} ${typeof v === 'number' ? num(v, 0) : v}`).join(' · ')}`);
    } catch (e) { await this.send(chatId, `❌ ${esc((e as Error).message)}`); }
    finally { fs.rmSync(dest, { force: true }); }
  }

  // ---------------------------------------------------------------- schedule

  /** Scheduled summaries. `cron` = called once a day by the cloud scheduler: don't wait for a later hour. */
  async schedule(cron = false) {
    const owner = this.owner;
    if (!owner || !this.reportsOn) return;
    const now = new Date(), today = localDate(now), hour = cron ? 23 : now.getHours();
    // Morning: as soon as last night's sleep has synced (after 6:00), or at 11:00 at the latest.
    if (kvGet('tg:morning') !== today && hour >= 6) {
      const slept = Q.nights(today, today).some((n) => n.asleep_min);
      if (slept || hour >= 11) {
        kvSet('tg:morning', today);
        if (!Q.bounds().first) return; // nothing to report yet
        const y = addDays(today, -1);
        const st = Q.daily(Q.T.steps, y, y)[0], km = Q.daily(Q.T.distance, y, y)[0], act = Q.daily(Q.T.active, y, y)[0];
        const line = `Вчера: ${num(st?.value ?? null, 0)} ${plural(Math.round(st?.value ?? 0), 'шаг', 'шага', 'шагов')} · ${num(km?.value ?? null, 1)} км · ${num(act?.value ?? null, 0)} ккал`;
        await this.sendScreen(owner, 'sleep', 'day', 0, [{ type: 'heading', text: '☀️ Доброе утро!', size: 1 }, { type: 'paragraph', text: line }], `☀️ <b>Доброе утро!</b>\n${line}\n\n`);
      }
    }
    const report = async (key: string, kind: PeriodKind, title: string) => {
      if (kvGet(key) === today) return;
      kvSet(key, today);
      if (!Q.bounds().first) return;
      await this.sendScreen(owner, 'home', kind, 1, [{ type: 'heading', text: title, size: 1 }], `<b>${title}</b>\n\n`);
    };
    if (now.getDay() === 1 && hour >= 9) await report('tg:weekly', 'week', '📅 Итоги недели');
    if (now.getDate() === 1 && hour >= 9) await report('tg:monthly', 'month', '🗓 Итоги месяца');
    if (now.getMonth() === 0 && now.getDate() === 1 && hour >= 10) await report('tg:yearly', 'year', '🎆 Итоги года');
  }

  // ---------------------------------------------------------------- assistant & planner

  /** "typing…" until the work is done (Telegram shows it for ~5 s per call). */
  private async typing<T>(chatId: number, work: Promise<T>, action = 'typing'): Promise<T> {
    let done = false;
    const tick = () => { if (!done) this.tg.call('sendChatAction', { chat_id: chatId, action }).catch(() => {}); };
    tick();
    const t = setInterval(tick, 4500);
    try { return await work; } finally { done = true; clearInterval(t); }
  }

  private async onText(chatId: number, text: string, prefix = '', modelText = text, only?: string[]) {
    let r;
    try { r = await this.typing(chatId, ask(modelText, true, only)); }
    catch (e) {
      console.error('[assistant]', e);
      await this.send(chatId, `${prefix}⚠️ Ассистент сейчас недоступен: ${esc((e as Error).message).slice(0, 300)}`);
      return null;
    }
    const items = r.touched.map((id) => P.getItem(id)).filter((x): x is P.Item => Boolean(x));
    const spent = r.expenses.map((id) => M.getExpense(id)).filter((x): x is M.Expense => Boolean(x));
    const body = [prefix + esc(r.text), ...items.slice(0, 5).map((it) => P.cardHtml(it)), ...(spent.length ? [spent.map(M.cardHtml).join('\n')] : [])].join('\n\n');
    const markup = items.length === 1 && !spent.length ? this.itemKeyboard(items[0])
      : spent.length && !items.length ? { inline_keyboard: spent.slice(0, 6).map((e) => [{ text: `🗑 ${M.money(e.amount, e.currency)} ${e.note ?? e.category}`.slice(0, 60), callback_data: `m|del|${e.id}` }]) } : null;
    await this.send(chatId, body.slice(0, 4000), markup ? { reply_markup: markup } : {});
    for (const n of r.notes ?? []) await this.send(chatId, esc(n));
    return r;
  }

  /** A forwarded message (from a teacher, a group chat, a channel) → tasks/meetings with dates. */
  private async onForward(chatId: number, msg: any) {
    const o = msg.forward_origin ?? {};
    const who = o.type === 'user' ? [o.sender_user?.first_name, o.sender_user?.last_name].filter(Boolean).join(' ')
      : o.type === 'hidden_user' ? o.sender_user_name : o.type === 'chat' ? o.sender_chat?.title : o.type === 'channel' ? o.chat?.title
      : [msg.forward_from?.first_name, msg.forward_from?.last_name].filter(Boolean).join(' ') || msg.forward_from_chat?.title || msg.forward_sender_name || 'неизвестно';
    const sentUnix = o.date ?? msg.forward_date ?? msg.date;
    const sent = new Date(sentUnix * 1000).toLocaleString('sv-SE', { hour12: false }).slice(0, 16);
    const link = o.type === 'channel' && o.chat?.username ? `https://t.me/${o.chat.username}/${o.message_id}` : '';
    const text = String(msg.text ?? msg.caption ?? '').trim();
    if (!text) return this.send(chatId, '📨 В пересланном сообщении нет текста — пришли текст или подпись к файлу.');
    const prompt = [
      `Пользователь переслал сообщение от «${who}», отправленное ${sent.replace('T', ' ')}${link ? ` (${link})` : ''}.`,
      'Сделай из него задачи и/или встречи с датами (их может быть несколько). Относительные даты («завтра», «в пятницу») считай от даты отправки.',
      `В notes коротко запиши суть и «от ${who}». Если дела или даты нет — сохрани как заметку (note). Ответь одной строкой, что сохранил.`,
      '', 'Текст сообщения:', text.slice(0, 3000),
    ].join('\n');
    return this.onText(chatId, prompt, `📨 <i>от ${esc(who)}</i>\n\n`, prompt, FORWARD_TOOLS);
  }

  /** The Mini App's assistant box: same as a chat message, marked as coming from the app. */
  async fromApp(text: string, voice: boolean) {
    const owner = this.owner;
    if (!owner || !assistantEnabled()) return null;
    return this.onText(owner, text, `📱 <i>${voice ? 'Голос из приложения' : 'Из приложения'}: ${esc(text)}</i>\n\n`);
  }

  /** Siri: the iPhone Shortcut sends dictated text; the answer is spoken, and the chat gets the same reply. */
  async siri(text: string): Promise<string> {
    const owner = this.owner;
    if (!owner || !assistantEnabled()) return 'Ассистент не подключён.';
    const r = await this.onText(owner, text, `🗣 <i>Siri: ${esc(text)}</i>\n\n`);
    if (!r) return 'Ассистент сейчас недоступен, попробуй через минуту.';
    const WD: Record<string, string> = { пн: 'понедельник', вт: 'вторник', ср: 'среда', чт: 'четверг', пт: 'пятница', сб: 'суббота', вс: 'воскресенье' };
    return r.text.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
      .replace(/(^|[\s(])(пн|вт|ср|чт|пт|сб|вс)(?=[,\s)])/gu, (_, pre, d) => pre + WD[d])
      .replace(/–/g, ' до ').replace(/\s+·\s+|\s+,/g, ', ').replace(/[ \t]+/g, ' ').trim();
  }

  // ---------------------------------------------------------------- inline mode: share the plan in any chat

  private async onInline(q: any) {
    const answer = (results: unknown[]) => this.tg.call('answerInlineQuery', { inline_query_id: q.id, results, cache_time: 0, is_personal: true }).catch((e) => console.warn('[inline]', e.message));
    if (q.from?.id !== this.owner) return answer([]);
    const today = P.todayLocal(), tomorrow = addDays(today, 1);
    const sunday = addDays(today, (7 - new Date(today + 'T12:00:00Z').getUTCDay()) % 7);
    const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
    const free = (d: string) => { const w = P.freeWindows(d); return w.length ? `Свободен ${P.dayLabel(d)} (${P.dayLabel(d, '')}): ${w.join(', ')}` : `${cap(P.dayLabel(d))} весь день занят`; };
    const items: [string, string, string, string][] = [
      ['today', '🗓 План на сегодня', 'Встречи и дела на сегодня', `Мой план на сегодня:\n\n${P.planText(today, today, { overdue: false })}`],
      ['tomorrow', '🗓 План на завтра', 'Встречи и дела на завтра', `Мой план на завтра:\n\n${P.planText(tomorrow, tomorrow, { overdue: false })}`],
      ['week', '📅 Расписание до конца недели', 'Только встречи, без личных задач', `Моё расписание до воскресенья:\n\n${P.planText(today, sunday, { overdue: false, tasks: false })}`],
      ['free', '🟢 Когда я свободен', 'Свободные окна сегодня и завтра (9:00–22:00)', `${free(today)}\n${free(tomorrow)}`],
    ];
    const qtext = String(q.query ?? '').toLowerCase().trim();
    const match = (id: string, title: string) => !qtext || title.toLowerCase().includes(qtext) || (qtext.startsWith('своб') && id === 'free') || (qtext.startsWith('нед') && id === 'week') || (qtext.startsWith('зав') && id === 'tomorrow') || (qtext.startsWith('сег') && id === 'today');
    return answer(items.filter(([id, t]) => match(id, t)).map(([id, title, description, text]) => ({
      type: 'article', id, title, description, input_message_content: { message_text: text.slice(0, 4000) },
    })));
  }

  private async onVoice(chatId: number, msg: any) {
    if (!assistantEnabled() || !voiceEnabled()) return this.send(chatId, '🎙 Ассистент не подключён: нет ключа Groq.');
    const f = msg.voice ?? msg.audio ?? msg.video_note;
    if (f.file_size > 20 * 1024 * 1024) return this.send(chatId, 'Слишком длинная запись: до 20 МБ.');
    let text: string;
    try {
      text = await this.typing(chatId, (async () => {
        const file = await this.tg.call<{ file_path: string }>('getFile', { file_id: f.file_id });
        return transcribe(await this.tg.download(file.file_path), msg.voice ? 'voice.ogg' : msg.video_note ? 'note.mp4' : (msg.audio.file_name || 'audio.mp3'));
      })(), 'record_voice');
    } catch (e) {
      console.error('[voice]', e);
      return this.send(chatId, `⚠️ Не смог расшифровать голосовое: ${esc((e as Error).message).slice(0, 200)}`);
    }
    if (!text) return this.send(chatId, '🎙 Ничего не расслышал.');
    return this.onText(chatId, text, `🎙 <i>${esc(text)}</i>\n\n`);
  }

  private itemKeyboard(it: P.Item) {
    if (it.source === 'reminders') return { inline_keyboard: it.status === 'open' ? [[{ text: '✅ Готово (закрою в «Напоминаниях»)', callback_data: `p|done|${it.id}` }]] : [] };
    if (it.source) return { inline_keyboard: [] };
    if (it.status !== 'open') return { inline_keyboard: it.repeat ? [] : [[{ text: '↩️ Вернуть', callback_data: `p|open|${it.id}` }]] };
    if (it.kind === 'note') return { inline_keyboard: [[{ text: '🗑 Удалить', callback_data: `p|del|${it.id}` }]] };
    return { inline_keyboard: [[{ text: '✅ Готово', callback_data: `p|done|${it.id}` }, { text: '🗑 Отменить', callback_data: `p|cancel|${it.id}` }]] };
  }

  private remindKeyboard(it: P.Item) {
    return { inline_keyboard: [
      [{ text: '✅ Готово', callback_data: `p|done|${it.id}` }],
      [{ text: '⏰ 15 мин', callback_data: `p|sn|${it.id}|15` }, { text: '⏰ 1 час', callback_data: `p|sn|${it.id}|60` }, { text: '⏰ 3 часа', callback_data: `p|sn|${it.id}|180` }],
    ] };
  }

  private async onPlanButton(q: any) {
    const [, action, idStr, arg] = String(q.data).split('|');
    const id = Number(idStr);
    let note = '';
    try {
      let it: P.Item | null = null;
      if (action === 'done') { it = P.completeItem(id); note = it.repeat ? `✅ Отмечено. Следующий раз: ${P.dayLabel(it.at!.slice(0, 10))} ${P.timeOf(it)}` : '✅ Готово'; }
      else if (action === 'cancel') { it = P.updateItem(id, { status: 'cancelled' }); note = 'Отменено'; }
      else if (action === 'open') { it = P.updateItem(id, { status: 'open' }); note = 'Вернул'; }
      else if (action === 'del') { P.deleteItem(id); note = 'Удалено'; }
      else if (action === 'sn') { it = P.snooze(id, Number(arg) || 15); note = `⏰ Напомню в ${it.next_remind!.slice(11)}`; }
      await this.tg.call('answerCallbackQuery', { callback_query_id: q.id, text: note }).catch(() => {});
      const m = q.message;
      if (action === 'del') await this.tg.call('editMessageText', { chat_id: m.chat.id, message_id: m.message_id, text: '🗑 Удалено', parse_mode: 'HTML' }).catch(() => {});
      else if (it) {
        const head = action === 'sn' ? `⏰ Отложено до ${it.next_remind!.slice(11)}\n\n` : '';
        await this.tg.call('editMessageText', { chat_id: m.chat.id, message_id: m.message_id, text: head + P.cardHtml(it), parse_mode: 'HTML', reply_markup: this.itemKeyboard(it) }).catch(() => {});
      }
    } catch (e) {
      await this.tg.call('answerCallbackQuery', { callback_query_id: q.id, text: (e as Error).message.slice(0, 180), show_alert: true }).catch(() => {});
    }
  }

  /** Called every minute (cron-job.org → /tick): reminders, repeats, the morning plan. */
  async tick() {
    const owner = this.owner;
    if (!owner) return { sent: 0 };
    kvSet('tick:last', new Date().toISOString());
    let sent = 0;
    for (const it of P.dueReminders()) {
      P.markReminded(it);
      const now = P.nowLocal();
      const timed = it.at && it.at.length > 10;
      const mins = timed ? Math.round((Date.parse(it.at! + ':00Z') - Date.parse(now + ':00Z')) / 60000) : null;
      const when = mins === null ? '🔔 <b>Напоминание</b>' : mins <= 0 ? '⏰ <b>Сейчас</b>' : mins < 60 ? `⏰ <b>Через ${mins} мин</b>` : `⏰ <b>Через ${Math.floor(mins / 60)} ч${mins % 60 ? ` ${mins % 60} мин` : ''}</b>`;
      await this.send(owner, `${when}\n${P.cardHtml(it)}`, { reply_markup: this.remindKeyboard(it) }).then(() => sent++).catch((e) => console.error('[tick] remind', e.message));
    }
    P.rollRepeats();
    if (assistantEnabled()) {
      for (const r of R.dueRoutines()) {
        R.claim(r);
        try { for (const m of await runRoutine(r)) { await this.send(owner, m.slice(0, 4000)); sent++; } }
        catch (e) { console.error('[routine]', r.id, e); R.saveResult(r.id, `ошибка: ${(e as Error).message}`); }
      }
    }
    const now = P.nowLocal(), today = now.slice(0, 10);
    if (kvGet('plan:morning') !== today && now.slice(11) >= P.planHour()) {
      kvSet('plan:morning', today);
      const plan = P.dayPlanHtml(today);
      if (plan) await this.send(owner, plan).then(() => sent++).catch((e) => console.error('[tick] plan', e.message));
    }
    // Watchdog once a day at noon: tells the owner only when something broke (or got fixed).
    if (kvGet('watchdog:day') !== today && now.slice(11, 16) >= '12:00') {
      kvSet('watchdog:day', today);
      try { const msg = alertFor(await runChecks()); if (msg) { await this.send(owner, msg); sent++; } }
      catch (e) { console.error('[watchdog]', (e as Error).message); }
    }
    // Weekly encrypted backup to the chat (Sunday night, or whenever a week has passed).
    const lastBackup = Date.parse(kvGet('backup:last') ?? '') || 0;
    if (process.env.BACKUP_KEY && now.slice(11, 16) >= '04:00' && Date.now() - lastBackup > 6.5 * 86400_000 && (new Date().getDay() === 0 || Date.now() - lastBackup > 8 * 86400_000)) {
      kvSet('backup:last', new Date().toISOString()); // claim first: never resend every minute on failure
      await this.sendBackup(owner).then(() => sent++).catch((e) => console.error('[backup]', e.message));
    }
    // Subscriptions once a day: reminders before a charge, and the charge recorded as an expense.
    if (kvGet('subs:day') !== today && now.slice(11, 16) >= '10:00') {
      kvSet('subs:day', today);
      for (const m of runSubs(today)) { await this.send(owner, esc(m)).catch((e) => console.error('[subs]', e.message)); sent++; }
    }
    const dk = assistantEnabled() ? dueDigest(now) : null;
    if (dk) {
      try {
        const d = await makeDigest(dk);
        const btn = this.appButton('📊 Разбор в приложении', false);
        await this.send(owner, digestHtml(d), btn ? { reply_markup: { inline_keyboard: [btn] } } : {});
        sent++;
      } catch (e) { console.error('[tick] digest', (e as Error).message); }
    }
    return { sent };
  }

  private routinesText() {
    const list = R.listRoutines();
    if (!list.length) return '🔁 Регулярных действий пока нет. Напиши, например: «каждый вечер в 21:30 присылай итоги дня» или «следи за каналом @name и сообщи, когда …».';
    return ['🔁 <b>Регулярные действия</b>', ...list.map((r) => [
      '',
      `${r.enabled ? (r.kind === 'watch' ? '👀' : r.kind === 'search' ? '🔎' : '🔁') : '⏸'} <b>${esc(r.title)}</b> · R#${r.id}`,
      `${R.scheduleLabel(r)}${r.channels ? ` · ${r.channels.split(',').map((c) => '@' + c).join(', ')}` : ''}${r.enabled && r.next_run ? ` · дальше ${r.next_run.slice(5).replace('T', ' ')}` : ''}`,
      r.last_run ? `<i>последний запуск ${r.last_run.slice(5).replace('T', ' ')}: ${esc((r.last_result ?? '').split('\n')[0].slice(0, 120))}</i>` : '',
    ].filter(Boolean).join('\n'))].join('\n').slice(0, 4000);
  }

  private routinesKeyboard() {
    return { inline_keyboard: R.listRoutines().slice(0, 8).map((r) => [
      { text: `▶️ R#${r.id}`, callback_data: `r|run|${r.id}` },
      r.enabled ? { text: '⏸ Пауза', callback_data: `r|off|${r.id}` } : { text: '▶️ Включить', callback_data: `r|on|${r.id}` },
      { text: '🗑', callback_data: `r|del|${r.id}` },
    ]) };
  }

  private sendRoutines(chatId: number) { return this.send(chatId, this.routinesText(), { reply_markup: this.routinesKeyboard() }); }

  private async onRoutineButton(q: any) {
    const [, action, idStr] = String(q.data).split('|');
    const id = Number(idStr);
    let note = '';
    try {
      if (action === 'run') { R.runNow(id); note = 'Запущу в течение минуты'; }
      else if (action === 'off') { R.updateRoutine(id, { enabled: false }); note = 'На паузе'; }
      else if (action === 'on') { R.updateRoutine(id, { enabled: true }); note = 'Включено'; }
      else if (action === 'del') { R.deleteRoutine(id); note = 'Удалено'; }
    } catch (e) { note = (e as Error).message.slice(0, 180); }
    await this.tg.call('answerCallbackQuery', { callback_query_id: q.id, text: note }).catch(() => {});
    await this.tg.call('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: this.routinesText(), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: this.routinesKeyboard() }).catch(() => {});
  }

  private tasksText() {
    const items = P.findItems({ status: 'open' }).filter((x) => x.kind !== 'note');
    if (!items.length) return '☑️ Открытых задач и встреч нет. Напиши или надиктуй, что добавить.';
    const groups = new Map<string, P.Item[]>();
    for (const it of items) { const k = it.at ? P.dayLabel(it.at.slice(0, 10)) : 'без срока'; groups.set(k, [...(groups.get(k) ?? []), it]); }
    const out = ['☑️ <b>Открытые задачи и встречи</b>'];
    for (const [k, list] of groups) out.push('', `<b>${k[0].toUpperCase() + k.slice(1)}</b>`, ...list.map((it) => `${P.timeOf(it) ? P.timeOf(it) + ' ' : ''}${P.iconOf(it)} ${esc(it.title)}${it.priority ? ' ❗️' : ''}`));
    return out.join('\n').slice(0, 4000);
  }

  // ---------------------------------------------------------------- texts

  private send(chatId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.tg.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  }

  private statusText() {
    const s = Q.syncTimes(), b = Q.bounds();
    return [
      '<b>Синхронизация</b>',
      `❤️ Здоровье: ${tgTime(s.health)}${watchState.haeDir ? '' : ' · папка Health Auto Export в iCloud ещё не найдена'}`,
      `🎧 Музыка: ${macMusicState.running ? `«Музыка» на Mac, ${num(macMusicState.tracks, 0)} треков` : '«Музыка» на Mac закрыта'} · ${tgTime(s.music)}`,
      `📱 Экранное время: ${tgTime(s.screentime)}`,
      b.first ? `\nДанные: с ${b.first} по ${b.last}` : '\nДанных о здоровье пока нет.',
      `Автосводки: ${this.reportsOn ? 'вкл' : 'выкл'} (/reports)`,
    ].join('\n');
  }

  /** What the iPhone Shortcut needs to push health data to the cloud (owner only). */
  /** Both directions of the iPhone calendar link: the subscription URL and the Shortcut's endpoint. */
  /** Encrypted database backup as a file in the chat. */
  async sendBackup(chatId: number) {
    try {
      const b = makeBackup();
      await this.tg.call('sendDocument', { chat_id: chatId, caption: b.caption, disable_notification: true }, { document: { data: b.file, name: b.name, type: 'application/octet-stream' } });
      kvSet('backup:last', new Date().toISOString());
    } catch (e) { await this.send(chatId, `⚠️ Резервная копия не получилась: ${esc((e as Error).message)}`); }
  }

  /** The Siri Shortcut's own key (separate from the data key used by the other Shortcuts). */
  private siriText() {
    const base = (process.env.APP_URL || '').replace(/\/app$/, ''), key = process.env.ASK_TOKEN;
    if (!base || !key) return 'Ключ для Siri ещё не настроен на сервере.';
    const switched = kvGet('ask:migrated');
    return [
      '🗣 <b>Команда Siri</b>',
      '',
      `Адрес: <code>${esc(base)}/ask</code>`,
      `Заголовок Authorization (нажми, чтобы скопировать):`,
      `<code>Bearer ${esc(key)}</code>`,
      '',
      switched ? '✅ Siri уже работает на своём ключе, общий ключ для неё отключён.'
        : 'В команде Siri открой «Get Contents of URL» → Headers → Authorization и замени значение на строку выше. После первого запроса с новым ключом старый для Siri перестанет работать.',
      '',
      '⚠️ Не делись этой командой по iCloud-ссылке: ключ уйдёт вместе с ней.',
    ].join('\n');
  }

  private calendarText() {
    const base = (process.env.APP_URL || '').replace(/\/app$/, '');
    const token = process.env.TELEGRAM_BOT_TOKEN, ingest = process.env.INGEST_TOKEN;
    if (!base || !token || !ingest) return 'Связь с календарём работает только в облачной версии.';
    const feed = `${base}/cal/${feedKey(token)}.ics`;
    const last = kvGet('calendar:icloud:last');
    return [
      '🗓 <b>Календарь iPhone</b>',
      '',
      '<b>1. Записи бота → Календарь.</b> Settings → Apps → Calendar → Calendar Accounts → Add Account → Other → Add Subscribed Calendar, вставь адрес:',
      `<code>${esc(feed)}</code>`,
      '',
      '<b>2. Календарь → бот.</b> Быстрая команда «lifestats календарь» отправляет события на адрес',
      `<code>${esc(base)}/calendar</code>`,
      `с заголовком Authorization: <code>Bearer ${esc(ingest)}</code>`,
      '',
      '<b>3. Напоминания → бот.</b> Быстрая команда «lifestats reminders» отправляет незакрытые напоминания на адрес',
      `<code>${esc(base)}/reminders</code>`,
      'с тем же заголовком.',
      '',
      `Последняя синхронизация: календарь ${tgTime(last ?? null)}, напоминания ${tgTime(kvGet('reminders:last') ?? null)}`,
      'Ссылки личные — никому не пересылай.',
    ].join('\n');
  }

  private shortcutText() {
    const base = (process.env.APP_URL || '').replace(/\/app$/, '');
    if (!base || !process.env.INGEST_TOKEN) return 'Приём данных с iPhone работает только в облачной версии.';
    return [
      '<b>Быстрая команда для здоровья</b>',
      '',
      'Адрес (URL):',
      `<code>${esc(base)}/ingest</code>`,
      '',
      'Заголовок <b>Authorization</b>, значение:',
      `<code>Bearer ${esc(process.env.INGEST_TOKEN)}</code>`,
      '',
      'Нажми на строку, чтобы скопировать. Никому не пересылай: с этим ключом можно записывать данные.',
    ].join('\n');
  }

  private helpText() {
    return [
      '<b>lifestats</b>',
      '',
      '🗓 <b>Ассистент.</b> Пиши или надиктуй голосом что угодно: «завтра в 15 созвон с Ромой», «купить корм коту до пятницы», «каждый день в 22 витамины», «что у меня на неделе?», «перенеси созвон на 16». Он запишет, напомнит в нужную минуту и каждое утро пришлёт план дня.',
      '• /plan — план на сегодня, /tasks — все открытые дела, /routines — регулярные действия, /calendar — связь с Календарём iPhone, /forget — забыть разговор.',
      '',
      '• Кнопка «Статистика» слева от поля ввода (или /app) — дашборд во весь экран: разделы, периоды, графики. Обновляется сам, когда приходят данные.',
      '• /menu — тот же дашборд прямо в чате, на кнопках.',
      '• /today /week /month /year /all, /sleep /activity /heart /workouts /music — то же текстом.',
      '• /status — синхронизация, /reports — автосводки (утро, неделя, месяц, год).',
      '• Пришли сюда export.zip (до 20 МБ) или CSV — импортирую.',
    ].join('\n');
  }
}

export function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.log('ℹ️  TELEGRAM_BOT_TOKEN не задан — бот выключен (данные всё равно собираются).'); return null; }
  const bot = new Bot(token);
  bot.start().catch((e) => console.error('[bot] не запустился:', e.message));
  return bot;
}
