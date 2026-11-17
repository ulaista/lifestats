# Every-minute tick

Reminders, routines, the morning plan, digests, subscriptions, backups and the watchdog all run from
`POST /tick`, which must be called **every minute** with `Authorization: Bearer $CRON_SECRET`.

- **Vercel Hobby** allows only daily crons, so use a free external scheduler:
  - [cron-job.org](https://cron-job.org) — `node --no-warnings scripts/cronjob-setup.ts https://<your-app>.vercel.app`
    creates the job through their API (needs `CRONJOB_API_KEY` and `CRON_SECRET` in `.env`), or create it by hand:
    URL `https://<your-app>.vercel.app/tick`, method POST, every minute, header `Authorization: Bearer <CRON_SECRET>`.
  - any other pinger (GitHub Actions is too coarse — minimum 5 min and often delayed).
- **Self-hosted** (`selfhost/server.mjs`, Docker, systemd): the scheduler is built in, nothing to set up.
- Plain crontab alternative: `* * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://<host>/tick >/dev/null`
