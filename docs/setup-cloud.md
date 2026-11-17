# Установка в облако (бесплатно)

Стек: **Vercel** (хостинг) + **Turso** (база) + **Groq** (ИИ, по желанию) + **cron-job.org** (запуск раз в минуту).
У всех есть бесплатные тарифы, кредитная карта не нужна. Время: ~30 минут.

## 0. Что понадобится

- Node.js 22+ и git на компьютере.
- Аккаунты: Telegram, [Vercel](https://vercel.com), [Turso](https://turso.tech), [cron-job.org](https://cron-job.org),
  по желанию [Groq](https://console.groq.com) и [Last.fm](https://www.last.fm/api/account/create).

```bash
git clone https://github.com/<you>/lifestats.git
cd lifestats
npm install
cp .env.example .env
```

## 1. Бот в Telegram

1. Напишите [@BotFather](https://t.me/BotFather) → `/newbot` → имя и username бота.
2. Токен положите в `.env`: `TELEGRAM_BOT_TOKEN=...`.
3. (По желанию) `/setinline` → выберите бота → подсказка, например `план, завтра, свободен` — это включит
   `@ваш_бот план` в любом чате.

## 2. База Turso

```bash
# установка CLI: https://docs.turso.tech/cli/installation
turso auth login
turso db create lifestats            # регион выберите ближе к региону Vercel (по умолчанию в vercel.json — fra1)
turso db show lifestats --url        # → TURSO_DATABASE_URL
turso db tokens create lifestats     # → TURSO_AUTH_TOKEN
```

Таблицы создаются сами при первом запуске.

## 3. Секреты и настройки

Сгенерируйте ключи и впишите в `.env`:

```bash
openssl rand -hex 24   # CRON_SECRET
openssl rand -hex 24   # INGEST_TOKEN — для «Команд» iPhone, которые присылают данные
openssl rand -hex 24   # ASK_TOKEN — отдельный ключ для Siri
openssl rand -hex 32   # BACKUP_KEY — ключ шифрования резервных копий (сохраните его в менеджер паролей!)
```

Ещё: `APP_TZ` (ваш часовой пояс, например `Europe/Berlin`), ключ ИИ (`GROQ_API_KEY` или `LLM_API_KEY` —
см. [assistant.md](assistant.md)), по желанию `LASTFM_API_KEY` и `LASTFM_USER`.

## 4. Vercel

```bash
npx vercel login
npx vercel link          # создать новый проект, корень — папка lifestats
```

Перенесите переменные из `.env` в проект: **Vercel → Project → Settings → Environment Variables** (Production)
или командой для каждой: `printf %s "значение" | npx vercel env add ИМЯ production`.
Обязательно: `TELEGRAM_BOT_TOKEN, APP_TZ, CRON_SECRET, INGEST_TOKEN, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN` и `DATA_DIR=/tmp`
(на Vercel писать можно только в `/tmp`);
`APP_URL` заполните после первого деплоя.

Деплой (сборка идёт локально, на Vercel уходит готовый `api/index.mjs`):

```bash
npm run build:cloud
npx vercel deploy --prod
```

Адрес вида `https://<ваш-проект>.vercel.app` впишите в `APP_URL` как `https://<ваш-проект>.vercel.app/app`
(и в Vercel тоже), затем задеплойте ещё раз.

## 5. Вебхук, меню и привязка бота к вам

```bash
node --no-warnings scripts/cloud-setup.ts https://<ваш-проект>.vercel.app   # вебхук, команды, кнопка Mini App
npm run pair                                                                  # покажет одноразовый код
```

Отправьте боту `/start <код>`. С этого момента бот отвечает только вам.

## 6. Запуск каждую минуту

Напоминания, регулярные действия, разборы, подписки, бэкапы и сторож работают от `POST /tick`.
Vercel Hobby разрешает только ежедневный cron (он уже настроен в `vercel.json` на `/cron`), поэтому нужен
внешний пингер — бесплатный [cron-job.org](https://cron-job.org):

- **Вручную:** Create cronjob → URL `https://<ваш-проект>.vercel.app/tick`, каждую минуту,
  Advanced → Request method **POST**, Headers: `Authorization: Bearer <CRON_SECRET>`.
- **Скриптом:** создайте API-ключ в настройках cron-job.org, положите в `.env` как `CRONJOB_API_KEY` и выполните
  `node --no-warnings scripts/cronjob-setup.ts https://<ваш-проект>.vercel.app`.

## 7. Проверка

- Отправьте боту `/status` — увидите, какие источники подключены.
- Кнопка «Статистика» у поля ввода открывает Mini App.
- Напишите «завтра в 10 тест» — должна появиться задача с напоминанием.

Дальше — [подключение iPhone](iphone-shortcuts.md).

## Обновление

```bash
git pull && npm install && npm run build:cloud && npx vercel deploy --prod
```
