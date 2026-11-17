// Points the Telegram bot at the cloud: webhook with a secret, commands, and the Mini App menu button.
// Usage: node --no-warnings scripts/cloud-setup.ts https://<app>.vercel.app
import { config } from '../server/config.ts';
import crypto from 'node:crypto';
// Same derivation as server/cloud/vercel.ts
const webhookSecret = (t: string) => crypto.createHash('sha256').update('lifestats-webhook:' + t).digest('hex').slice(0, 48);
void config; // loads .env
const base = (process.argv[2] || '').replace(/\/$/, '');
const token = process.env.TELEGRAM_BOT_TOKEN!;
const owner = Number(process.argv[3] || 0);
if (!base.startsWith('https://') || !token) { console.error('usage: cloud-setup.ts https://… [ownerId]'); process.exit(1); }
const call = async (method: string, params: Record<string, unknown>) => {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
  const j = await r.json() as { ok: boolean; description?: string };
  console.log(method, j.ok ? 'ok' : j.description);
};
await call('setWebhook', { url: `${base}/tg`, secret_token: webhookSecret(token), allowed_updates: ['message', 'callback_query', 'inline_query'], drop_pending_updates: false });
await call('setMyCommands', { commands: [
  ['plan', 'План на сегодня'], ['tasks', 'Все задачи и встречи'], ['money', 'Расходы за месяц'], ['calendar', 'Связь с Календарём iPhone'], ['siri', 'Ключ для команды Siri'], ['backup', 'Резервная копия базы'], ['routines', 'Регулярные действия'], ['app', 'Открыть дашборд'], ['menu', 'Дашборд в чате'], ['today', 'Сегодня'], ['week', 'Неделя'], ['month', 'Месяц'], ['year', 'Год'],
  ['sleep', 'Сон'], ['activity', 'Активность'], ['heart', 'Сердце'], ['workouts', 'Тренировки'], ['music', 'Музыка'], ['status', 'Проверка: всё ли работает'], ['reports', 'Автосводки вкл/выкл'], ['forget', 'Забыть разговор с ассистентом'], ['help', 'Помощь'],
].map(([command, description]) => ({ command, description })) });
if (owner) await call('setChatMenuButton', { chat_id: owner, menu_button: { type: 'web_app', text: 'Статистика', web_app: { url: `${base}/app` } } });
