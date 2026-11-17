// Self-hosting without Vercel: the same request handler as the cloud build, served by plain Node,
// plus the scheduler Vercel/cron-job.org provide in the cloud (/tick every minute, /cron daily).
//   npm run build:cloud && node --no-warnings selfhost/server.mjs
// Telegram needs a public HTTPS URL for the webhook — put a reverse proxy or tunnel in front (see docs/self-host.md).
import http from 'node:http';

const { default: handler } = await import('../api/index.mjs');
const port = Number(process.env.PORT || 3000);
const secret = process.env.CRON_SECRET || '';

http.createServer((req, res) => {
  handler(req, res).catch((e) => { console.error('[server]', e); if (!res.headersSent) res.writeHead(500); res.end(); });
}).listen(port, () => console.log(`[lifestats] listening on :${port}`));

const call = (path) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${secret}` } })
  .then((r) => { if (!r.ok) console.warn(`[scheduler] ${path} → ${r.status}`); })
  .catch((e) => console.warn(`[scheduler] ${path}: ${e.message}`));

if (!secret) console.warn('[scheduler] CRON_SECRET is empty — /tick and /cron will refuse; set it in .env');
setInterval(() => call('/tick'), 60_000);
let lastDaily = '';
setInterval(() => {
  const now = new Date(), day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === 5 && lastDaily !== day) { lastDaily = day; call('/cron'); }
}, 60_000);
