# Автоматизации — всё в одном месте

| Что | Где | Зачем |
|---|---|---|
| Запуск каждую минуту (облако) | [cron/README.md](cron/README.md), `scripts/cronjob-setup.ts` | напоминания, регулярные действия, разборы, подписки, бэкапы, сторож |
| Ежедневный cron Vercel | `vercel.json` → `/cron` | синхронизация Last.fm, проверка, что ежеминутный запуск жив |
| Свой сервер: systemd | [linux/lifestats.service](linux/lifestats.service) | автозапуск на Linux |
| Свой сервер: Mac | [macos/dev.lifestats.plist](macos/dev.lifestats.plist) | автозапуск при входе (launchd) |
| Docker | `Dockerfile`, `docker-compose.yml` | один контейнер со встроенным планировщиком |
| iPhone «Команды» | [../docs/iphone-shortcuts.md](../docs/iphone-shortcuts.md) | здоровье, календарь, напоминания, экранное время, Siri |
| Android | [../docs/android.md](../docs/android.md) | Health Connect (HC Webhook), MacroDroid/Tasker, HTTP Shortcuts |
| Календари по ссылке | команда `/ical` или `CALENDAR_ICS_URLS` | Google/iCloud/Outlook, обновление раз в час |
| Вебхук и меню бота | `scripts/cloud-setup.ts <URL>` | после деплоя и при смене адреса |
| Привязка бота | `npm run pair` | одноразовый код для `/start` |
| Восстановление бэкапа | `npm run backup:restore -- файл.lsb [--apply]` | из файла, который бот присылает раз в неделю |

## Расписание внутри бота (время — `APP_TZ`)

| Время | Что |
|---|---|
| каждую минуту | напоминания о делах, повторы, регулярные действия по их расписанию |
| раз в час | календари по ссылке iCal |
| 08:00 (меняется) | план на день + утренний разбор |
| 10:00 | подписки: напоминание накануне, запись списания в день списания |
| 12:00 | сторож (пишет только при поломке) |
| 21:30 | вечерний разбор |
| вс, после 04:00 | зашифрованная резервная копия в чат |

## Рекомендуемые автоматизации iPhone

| Команда | Когда запускать |
|---|---|
| `lifestats` (здоровье) | Time of Day 09:00, 14:00, 22:00 |
| `lifestats calendar` | Calendar Is Closed + 07:30 |
| `lifestats reminders` | Reminders Is Closed + 07:30 |
| `lifestats screen` | App Opened or Closed — по автоматизации на каждое приложение |
| Siri | вручную: «Привет, Siri, спроси lifestats» |
