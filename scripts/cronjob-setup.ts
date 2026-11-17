// Creates (or updates) the every-minute cron-job.org job that calls /tick (planner reminders).
// Usage: node --no-warnings scripts/cronjob-setup.ts https://<your-app>.vercel.app
// Needs CRONJOB_API_KEY and CRON_SECRET in the environment. Only the tick URL and the secret header are sent.
import '../server/config.ts'; // loads .env
const base = (process.argv[2] || '').replace(/\/$/, '');
const key = process.env.CRONJOB_API_KEY, secret = process.env.CRON_SECRET;
if (!base || !key || !secret) { console.error('Usage: cronjob-setup.ts <base url>; CRONJOB_API_KEY and CRON_SECRET must be set'); process.exit(1); }

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`https://api.cron-job.org${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

const url = `${base}/tick`;
const job = {
  url, enabled: true, title: 'lifestats tick', saveResponses: false, requestTimeout: 30, requestMethod: 0,
  schedule: { timezone: process.env.APP_TZ || 'UTC', expiresAt: 0, hours: [-1], mdays: [-1], minutes: [-1], months: [-1], wdays: [-1] },
  extendedData: { headers: { Authorization: `Bearer ${secret}` }, body: '' },
  notification: { onFailure: false, onSuccess: false, onDisable: true },
};
const { jobs = [] } = await api('GET', '/jobs');
const existing = jobs.find((j: { url: string }) => j.url === url);
if (existing) { await api('PATCH', `/jobs/${existing.jobId}`, { job }); console.log(`Updated job ${existing.jobId}: every minute → ${url}`); }
else { const r = await api('PUT', '/jobs', { job }); console.log(`Created job ${r.jobId}: every minute → ${url}`); }
