# Свой сервер

Тот же код, что и в облаке, но без Vercel и cron-job.org: один процесс Node (или Docker-контейнер) со
встроенным планировщиком (`/tick` раз в минуту, `/cron` раз в сутки). База — SQLite-файл в `DATA_DIR`
(или Turso, если задать `TURSO_DATABASE_URL`).

Подходит: VPS, домашний сервер, Raspberry Pi 4/5, Mac, NAS с Docker.

## Требование Telegram: публичный HTTPS

Telegram доставляет сообщения боту через вебхук — нужен адрес `https://…`, доступный из интернета. Варианты:

- **Свой домен + Caddy** (сам получает сертификат Let's Encrypt):
  ```
  stats.example.com {
      reverse_proxy 127.0.0.1:3000
  }
  ```
- **Cloudflare Tunnel** (без белого IP и открытых портов): `cloudflared tunnel --url http://localhost:3000`
  для пробы или именованный туннель для постоянной работы.
- nginx + certbot, Tailscale Funnel и т. п.

## Вариант A — Docker

```bash
git clone https://github.com/<you>/lifestats.git && cd lifestats
cp .env.example .env          # заполните: TELEGRAM_BOT_TOKEN, APP_URL, APP_TZ, CRON_SECRET, INGEST_TOKEN …
docker compose up -d --build
```

Данные лежат в `./data` (подключён как том). Порт 3000 открыт только на `127.0.0.1` — наружу его отдаёт прокси.

## Вариант B — Node напрямую

```bash
npm install
cp .env.example .env          # заполните
npm run serve                 # = npm run build:cloud && node selfhost/server.mjs
```

Автозапуск: `automations/linux/lifestats.service` (systemd) или `automations/macos/dev.lifestats.plist` (launchd на Mac).

## После запуска

```bash
node --no-warnings scripts/cloud-setup.ts https://stats.example.com   # вебхук, команды, кнопка Mini App
npm run pair                                                         # код для /start
```

`APP_URL` в `.env` — `https://stats.example.com/app`. Проверка: `/status` в боте.

## Резервные копии

С `BACKUP_KEY` бот раз в неделю присылает зашифрованную копию в чат. Для своего сервера дополнительно можно
копировать `data/lifestats.db` (например, `sqlite3 data/lifestats.db ".backup backup.db"` по cron).
Восстановление из файла из чата: `npm run backup:restore -- файл.lsb` (проверка) и `… --apply` (запись).

## Старый «Mac-режим»

`npm start` запускает исходный локальный вариант (`server/index.ts`): долгий опрос Telegram, Mini App через
туннель, импорт из iCloud-папки HealthExport и экранного времени Mac. Он оставлен для совместимости;
для новых установок используйте `selfhost/server.mjs`.
