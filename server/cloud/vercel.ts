// Cloud entry point (Vercel serverless function). One handler for everything:
//   GET  /                 Mini App page
//   GET  /api/view|wait    Mini App API (owner's Telegram signature required)
//   POST /tg               Telegram webhook (secret token header required)
//   POST /ingest           health data from the iPhone (Bearer INGEST_TOKEN)
//   POST /screen           {app[, event]} from iPhone app open/close automations (Bearer INGEST_TOKEN)
//   POST /health           { sleep, steps, energy, distance } sample lines from a Shortcut (Bearer INGEST_TOKEN)
//   POST /sleep            sleep samples straight from Apple Health (Shortcut, Bearer INGEST_TOKEN)
//   GET  /cron             daily summaries (Vercel Cron, Bearer CRON_SECRET)
//   POST /calendar         iPhone calendar events from a Shortcut (Bearer INGEST_TOKEN)
//   GET  /cal/<key>.ics    the bot's records as a subscribed calendar (secret in the URL)
//   GET  /tick             every minute: planner reminders + morning plan (cron-job.org, Bearer CRON_SECRET)
// State lives in Turso; this function keeps nothing between requests.
import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
if (process.env.APP_TZ) process.env.TZ = process.env.APP_TZ; // dates are computed in the owner's time zone

import PAGE from '../app/index.html';
import { syncDb, kvGet, kvSet, writes } from '../db.ts';
import { view, viewParams, authorize, json, SECURITY, routineAction, itemAction } from '../app/server.ts';
import { transcribe } from '../plan/voice.ts';
import { Bot } from '../bot/bot.ts';
import { ingestHealthExport, isHealthExport } from '../import/healthexport.ts';
import { ingestHealthAutoExport } from '../import/hae.ts';
import { parseSleepText, syncSleep, syncHealth } from '../import/health-sleep.ts';
import { makeDigest } from '../plan/digest.ts';
import { screenEvent } from '../import/screen-events.ts';
import { runChecks, statusHtml } from '../plan/watchdog.ts';
import { lastfmEnabled, syncLastfm } from '../import/lastfm.ts';
import { syncCalendar, parseCalendarText, syncReminders, parseRemindersText, reminderOps } from '../plan/store.ts';
import { icsFeed, feedKey } from '../plan/ics.ts';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const bot = TOKEN ? new Bot(TOKEN) : null;

/** Secret Telegram must echo in X-Telegram-Bot-Api-Secret-Token (derived from the bot token). */
export const webhookSecret = (token: string) => crypto.createHash('sha256').update('lifestats-webhook:' + token).digest('hex').slice(0, 48);

const safeEqual = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bearer = (req: IncomingMessage) => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

async function bodyBuf(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > limit) throw new Error('too large'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
async function body(req: IncomingMessage, limit = 4_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > limit) throw new Error('too large'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}

const viewCache = new Map<string, string>();
const dataVersion = () => Number(kvGet('data:ver') || 1);
const bump = () => kvSet('data:ver', String(Date.now()));

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'https://x');
  // vercel.json rewrites every path to this function and passes the original one as ?__path=
  const path = url.searchParams.get('__path') ?? url.pathname;
  try {
    if (req.method === 'GET' && (path === '/' || path === '/app' || path === '/index.html')) {
      res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(PAGE);
    }
    if (!bot) return json(res, 500, { error: 'TELEGRAM_BOT_TOKEN не задан' });
    syncDb(); // pick up writes made by other invocations

    if (path === '/tg' && req.method === 'POST') {
      if (!safeEqual(String(req.headers['x-telegram-bot-api-secret-token'] ?? ''), webhookSecret(TOKEN))) return json(res, 403, { error: 'forbidden' });
      const update = JSON.parse(await body(req));
      // Answer Telegram at once (the assistant can take a while) and keep working in the background.
      const last = Number(kvGet('tg:last_update') || 0);
      if (update.update_id && update.update_id <= last) return json(res, 200, { ok: true, dup: true });
      if (update.update_id) kvSet('tg:last_update', String(update.update_id));
      const w0 = writes();
      waitUntil(bot.processUpdate(update).catch((e) => console.error('[tg]', e)).then(() => { if (writes() !== w0) bump(); }));
      return json(res, 200, { ok: true });
    }

    if (path === '/ingest' && req.method === 'POST') {
      const want = process.env.INGEST_TOKEN ?? '';
      if (!want || !safeEqual(bearer(req), want)) return json(res, 403, { error: 'forbidden' });
      const data = JSON.parse(await body(req));
      const r = isHealthExport(data) ? ingestHealthExport(data) : ingestHealthAutoExport(data);
      kvSet('hae:last', new Date().toISOString());
      bump();
      return json(res, 200, { ok: true, ...r });
    }

    if (path === '/sleep' && req.method === 'POST') {
      const want = process.env.INGEST_TOKEN ?? '';
      if (!want || !safeEqual(bearer(req), want)) return json(res, 403, { error: 'forbidden' });
      const raw = await body(req);
      let text = raw;
      try { const d = JSON.parse(raw); if (typeof d?.text === 'string') text = d.text; } catch { /* plain text */ }
      const r = syncSleep(parseSleepText(text));
      kvSet('hae:last', new Date().toISOString());
      bump();
      return json(res, 200, { ok: true, ...r });
    }

    if (path === '/screen' && req.method === 'POST') {
      const want = process.env.INGEST_TOKEN ?? '';
      if (!want || !safeEqual(bearer(req), want)) return json(res, 403, { error: 'forbidden' });
      const raw = await body(req);
      let d: any;
      try { d = JSON.parse(raw); } catch { const [app, event] = raw.split('|'); d = { app, event }; }
      try { const r = screenEvent(d?.app, d?.event); bump(); return json(res, 200, { ok: true, ...r }); }
      catch (e) { return json(res, 400, { error: (e as Error).message }); }
    }

    if (path === '/health' && req.method === 'POST') {
      const want = process.env.INGEST_TOKEN ?? '';
      if (!want || !safeEqual(bearer(req), want)) return json(res, 403, { error: 'forbidden' });
      let data: any;
      try { data = JSON.parse(await body(req)); } catch { return json(res, 400, { error: 'expected JSON' }); }
      const r = syncHealth(data ?? {});
      kvSet('hae:last', new Date().toISOString());
      bump();
      return json(res, 200, { ok: true, ...r });
    }

    if (path === '/calendar' && req.method === 'POST') {
      const want = process.env.INGEST_TOKEN ?? '';
      if (!want || !safeEqual(bearer(req), want)) return json(res, 403, { error: 'forbidden' });
      const raw = await body(req);
      let data: any;
      try { data = JSON.parse(raw); } catch { data = { text: raw }; }
      const events = Array.isArray(data?.events) ? data.events : parseCalendarText(String(data?.text ?? ''));
      const r = syncCalendar(events);
      bump();
      return json(res, 200, { ok: true, ...r });
    }

    if (path === '/reminders/ops' && req.method === 'GET') {
      const want = process.env.INGEST_TOKEN ?? '';
      if (!want || !safeEqual(bearer(req), want)) return json(res, 403, { error: 'forbidden' });
      return json(res, 200, reminderOps());
    }

    if (path === '/reminders' && req.method === 'POST') {
      const want = process.env.INGEST_TOKEN ?? '';
      if (!want || !safeEqual(bearer(req), want)) return json(res, 403, { error: 'forbidden' });
      const raw = await body(req);
      let text = raw;
      try { text = String(JSON.parse(raw)?.text ?? ''); } catch { /* plain text */ }
      const r = syncReminders(parseRemindersText(text));
      bump();
      return json(res, 200, { ok: true, ...r });
    }

    if (req.method === 'GET' && path.startsWith('/cal/') && safeEqual(path, `/cal/${feedKey(TOKEN)}.ics`)) {
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Disposition': 'inline; filename="lifestats.ics"' });
      return res.end(icsFeed());
    }

    if (path === '/cron') {
      const want = process.env.CRON_SECRET ?? '';
      if (!want || !safeEqual(bearer(req), want)) return json(res, 403, { error: 'forbidden' });
      if (lastfmEnabled()) await syncLastfm().then((r) => r.added && bump()).catch((e) => console.error('[lastfm]', e.message));
      await bot.schedule(true);
      // Independent of cron-job.org: if the every-minute tick stopped, nothing else could report it.
      const tick = (await runChecks({ network: false, fromCron: true })).find((x) => x.key === 'tick');
      if (tick && !tick.ok) await bot.notifyOwner(statusHtml([tick])).catch((e) => console.error('[watchdog]', e.message));
      return json(res, 200, { ok: true });
    }

    // Siri has its own key, so a shared data Shortcut can't drive the assistant. The old shared key keeps
    // working only until the Siri Shortcut has been switched (first request with the new key retires it).
    if (path === '/ask' && req.method === 'POST') {
      const ask = process.env.ASK_TOKEN ?? '', got = bearer(req);
      const okNew = Boolean(ask) && safeEqual(got, ask);
      const okOld = !kvGet('ask:migrated') && Boolean(process.env.INGEST_TOKEN) && safeEqual(got, process.env.INGEST_TOKEN!);
      if (!okNew && !okOld) return json(res, 403, { error: 'forbidden' });
      if (okNew && !kvGet('ask:migrated')) kvSet('ask:migrated', new Date().toISOString());
      const raw = await body(req, 100_000);
      let text = raw;
      try { const j = JSON.parse(raw); text = String(j.text ?? j.q ?? ''); } catch { /* plain text body */ }
      if (!text.trim()) return json(res, 400, { error: 'empty' });
      const speech = await bot.siri(text.trim().slice(0, 2000));
      return json(res, 200, { ok: true, speech });
    }

    if (path === '/tick') {
      const want = process.env.CRON_SECRET ?? '';
      if (!want || !safeEqual(bearer(req), want)) return json(res, 403, { error: 'forbidden' });
      const w0 = writes();
      const r = await bot.tick();
      if (writes() !== w0) bump();
      return json(res, 200, { ok: true, ...r });
    }

    if (path === '/api/item' && req.method === 'POST') {
      const denied = authorize(req.headers.authorization, TOKEN);
      if (denied) return json(res, denied.code, { error: denied.error });
      try { itemAction(Number(url.searchParams.get('id')), String(url.searchParams.get('a')), url.searchParams.get('to')); bump(); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 400, { error: (e as Error).message }); }
    }

    // The assistant from the Mini App: text or a voice recording; the reply also lands in the chat.
    if (path === '/api/ask' && req.method === 'POST') {
      const denied = authorize(req.headers.authorization, TOKEN);
      if (denied) return json(res, denied.code, { error: denied.error });
      const type = String(req.headers['content-type'] || '');
      let text = '', heard = '';
      if (/^audio\/|octet-stream/.test(type)) {
        const buf = await bodyBuf(req, 8_000_000);
        if (buf.length < 800) return json(res, 400, { error: 'Запись слишком короткая' });
        heard = text = (await transcribe(buf, /mp4|m4a|aac/.test(type) ? 'voice.m4a' : /ogg/.test(type) ? 'voice.ogg' : 'voice.webm')).trim();
        if (!text) return json(res, 400, { error: 'Не расслышал, попробуй ещё раз' });
      } else {
        try { text = String(JSON.parse(await body(req, 20_000)).text ?? ''); } catch { /* empty */ }
      }
      if (!text.trim()) return json(res, 400, { error: 'Пусто' });
      const w0 = writes();
      const r = await bot.fromApp(text.trim().slice(0, 2000), Boolean(heard));
      if (writes() !== w0) bump();
      return json(res, 200, { ok: Boolean(r), heard, text: r?.text ?? 'Ассистент сейчас недоступен, попробуй через минуту.', notes: r?.notes ?? [] });
    }

    if (path === '/api/digest' && req.method === 'POST') {
      const denied = authorize(req.headers.authorization, TOKEN);
      if (denied) return json(res, denied.code, { error: denied.error });
      const k = url.searchParams.get('k');
      if (k !== 'morning' && k !== 'evening') return json(res, 400, { error: 'bad kind' });
      if (Date.now() - Number(kvGet('digest:manual') || 0) < 60_000) return json(res, 429, { error: 'Разбор обновлялся меньше минуты назад.' });
      kvSet('digest:manual', String(Date.now()));
      const d = await makeDigest(k);
      bump();
      return json(res, 200, { digest: d });
    }

    if (path === '/api/routine' && req.method === 'POST') {
      const denied = authorize(req.headers.authorization, TOKEN);
      if (denied) return json(res, denied.code, { error: denied.error });
      try { const r = routineAction(Number(url.searchParams.get('id')), String(url.searchParams.get('a'))); bump(); return json(res, 200, { routines: r }); }
      catch (e) { return json(res, 400, { error: (e as Error).message }); }
    }

    if (path.startsWith('/api/') && req.method === 'GET') {
      const denied = authorize(req.headers.authorization, TOKEN);
      if (denied) return json(res, denied.code, { error: denied.error });
      if (path === '/api/wait') return json(res, 200, { ver: dataVersion() }); // no long polling in serverless
      if (path === '/api/view') {
        const v = viewParams(url);
        if (!v) return json(res, 400, { error: 'bad view' });
        // Fresh music on open (Last.fm) in the background: the new version reaches the page via /api/wait.
        if (lastfmEnabled() && v.o === 0 && Date.now() - Date.parse(kvGet('lastfm:last_sync') ?? '0') > 5 * 60_000) {
          kvSet('lastfm:last_sync', new Date().toISOString()); // one sync at a time
          waitUntil(syncLastfm().then((r) => { if (r.added) bump(); }).catch((e) => console.warn('[lastfm]', e.message)));
        }
        // Screens only change when data does: keep built ones per data version (and day) in this instance.
        const fb = url.searchParams.get('fb') === '1', ver = dataVersion();
        const key = `${v.s}|${v.k}|${v.o}|${fb ? 1 : 0}|${ver}|${new Date().toLocaleDateString('sv-SE')}`;
        let out = viewCache.get(key);
        if (!out) {
          out = JSON.stringify(view(v.s, v.k, v.o, ver, fb));
          viewCache.set(key, out);
          if (viewCache.size > 60) viewCache.delete(viewCache.keys().next().value!);
        }
        res.writeHead(200, { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(out);
      }
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[cloud]', e);
    return json(res, 500, { error: 'Ошибка на сервере' });
  }
}
