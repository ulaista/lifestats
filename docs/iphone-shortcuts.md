# Подключение iPhone через «Команды»

Apple не даёт серверам доступ к «Здоровью», Календарю, «Напоминаниям» и «Экранному времени» напрямую.
Поэтому данные отправляет сам iPhone — бесплатным приложением **«Команды» (Shortcuts)**: каждая команда собирает
данные и делает один запрос `Get Contents of URL` на ваш сервер.

Общее для всех команд:

- **Адрес сервера** — `https://<ваш-проект>.vercel.app` (или ваш домен). Ниже он обозначен как `$SERVER`.
- **Ключ данных** — `INGEST_TOKEN`. Бот покажет готовую строку командой `/calendar` или `/shortcut`:
  `Authorization: Bearer …` — нажмите на неё, Telegram скопирует.
- **Ключ Siri** — отдельный `ASK_TOKEN`, его показывает `/siri`. Не ставьте его в другие команды.
- В действии **Get Contents of URL**: стрелка ▸ → **Method POST** → **Headers** → `Authorization` = `Bearer <ключ>` →
  **Request Body JSON** (или File — где указано).
- Даты в тексте — **Date Format → ISO 8601**, включить **Include ISO 8601 Time**.
- Названия действий ниже — как в английском интерфейсе; в русском они переведены по смыслу.
- ⚠️ **Не делитесь этими командами по iCloud-ссылке** — ключ уйдёт вместе с ними.

---

## 1. Здоровье — команда `lifestats`

Два источника, можно оба в одной команде (сервер возьмёт более полный).

### 1a. Свежие шаги и сон напрямую из «Здоровья» (рекомендуется)

**Блок «Шаги»**
1. **Find Health Samples** — Type **Steps**, Start Date **is in the last 2 days**, **Group by Hour**,
   Fill Missing — вкл., Sort by **Start Date**.
2. **Repeat with Each** (Health Samples), внутри **Text**: `Start Date` `|` `End Date` `|` `Value`
   (обе даты — ISO 8601 со временем).
3. После End Repeat — **Combine Text**: Repeat Results, **New Lines**.

**Блок «Сон»**
1. **Find Health Samples** — Type **Sleep Analysis**, Start Date **is in the last 2 days**, Sort by **Start Date**.
2. **Repeat with Each**, внутри **Text**: `Start Date` `|` `End Date` `|` `Value` `|` `Source`.
3. **Combine Text** — Repeat Results, New Lines.

(По желанию блок «Активная энергия»: как шаги, Type **Active Energy**.)

**Отправка** — **Get Contents of URL** `$SERVER/health`, POST, ключ данных, Request Body **JSON**:
`steps` = Combined Text (шаги), `sleep` = Combined Text (сон), `energy` = Combined Text (энергия, если есть).

Сервер склеит образцы с iPhone и часов так же, как «Здоровье» (по часу берёт больший источник; для сна при
наличии фаз считает только фазы).

### 1b. Полные итоги дня через приложение HealthExport (по желанию)

Бесплатное приложение **HealthExport** раз в сутки пишет JSON с итогами (пульс, ВСР, тренировки, вес) в
iCloud Drive → HealthExport → Health. Блок в начало той же команды:

1. **Get Contents of Folder** — iCloud Drive → HealthExport → Health.
2. **Filter Files** — Sort by **Creation Date**, Order **Latest First**, Limit **1**.
3. **Get Contents of URL** `$SERVER/ingest`, POST, ключ данных, Request Body **File** = отфильтрованный файл.

### Автоматизация

**Automation → Time of Day** (например 09:00, 14:00 и 22:00) → **Run Immediately** → Run Shortcut `lifestats`.
«Здоровье» доступно, только пока iPhone разблокирован: если в момент запуска экран заблокирован, данные
придут со следующим запуском.

---

## 2. Календарь — в обе стороны

**Записи бота → Календарь iPhone.** Команда `/calendar` даёт ссылку на подписку. iPhone: Settings → Apps →
Calendar → Calendar Accounts → Add Account → Other → **Add Subscribed Calendar** → вставить ссылку.

**Календарь → бот** (чтобы ассистент знал о ваших встречах). Проще всего — ссылкой: если календарь в Google или
опубликован в iCloud, отправьте боту `/ical add <ссылка iCal>`, сервер будет забирать его сам раз в час
(подробнее в [android.md](android.md#2-календарь-по-ссылке)). Для локальных календарей iPhone — команда `lifestats calendar`:
1. **Find Calendar Events** — Start Date **is in the next 14 days** (можно добавить и «последний день»).
2. **Repeat with Each**, внутри **Text**:
   `Start Date` `|` `End Date` `|` `Is All Day` `|` `Calendar` `|` `Location` `|` `Title`.
3. **Combine Text** — New Lines.
4. **Get Contents of URL** `$SERVER/calendar`, POST, ключ данных, Request Body JSON: `text` = Combined Text.

Автоматизация: **App → Calendar → Is Closed** и/или **Time of Day 07:30**, Run Immediately.
События из календарей, в названии которых есть `lifestats`, сервер пропускает (чтобы не было петли с подпиской).

---

## 3. «Напоминания» — в обе стороны

Команда `lifestats reminders`. **Сначала** применяет изменения, сделанные в боте, **потом** отправляет свежий список.

**Блок применения (в начале команды)**
1. **Get Contents of URL** `$SERVER/reminders/ops` — **GET**, ключ данных. Ответ:
   `{"done":["…"],"due":[{"title":"…","due":"…"}],"new":[{"title":"…","due":"…"}]}`.
2. **Отметить выполненные:** Get Dictionary Value `done` → Repeat with Each → **Find Reminders**
   (Title is *Repeat Item*, Is Not Completed, Limit 1) → **Edit Reminder**: Is Completed = вкл.
3. **Новые:** Get Dictionary Value `new` (из ответа шага 1) → Repeat → Get Dictionary Value `title` и `due`
   из Repeat Item → **Add New Reminder** с этим названием и датой.
4. **Перенос сроков** (по желанию): ключ `due` → Repeat → Find Reminders по `title` → Edit Reminder → Due Date = `due`.

**Блок отправки**
1. **Find Reminders** — Is Not Completed (можно ограничить списками).
2. **Repeat with Each**, внутри **Text**: `Due Date` `|` `List` `|` `Priority` `|` `Title`.
3. **Combine Text** — New Lines.
4. **Get Contents of URL** `$SERVER/reminders`, POST, ключ данных, Request Body JSON: `text` = Combined Text.

Автоматизация: **App → Reminders → Is Closed** и **Time of Day 07:30**. Из бота напоминания можно
закрыть, перенести и создать новые; переименовать и удалить — только в самом приложении.

---

## 4. Экранное время

У Apple нет доступа к «Экранному времени», поэтому время в приложениях считается по событиям
«открыто / закрыто».

**Команда `lifestats screen`** (одна на всё):
1. Настройки команды (ⓘ) → **Receive** → только **Text**.
2. **Get Contents of URL** `$SERVER/screen`, POST, ключ данных, Request Body JSON: `app` = **Shortcut Input**.

**Автоматизация на каждое приложение** (Instagram, Telegram, YouTube, TikTok, Safari …):
1. **Automation → App** → выбрать **одно** приложение → **Opened or Closed** (или «Is Opened» + «Is Closed»).
2. **Run Immediately**, уведомление выкл.
3. Действия: **Text** с названием приложения → **Run Shortcut** `lifestats screen`, Input = Text.

Одна автоматизация — одно приложение: иначе сервер не поймёт, какое открыли. Сервер сам определяет
открытие/закрытие, открытие другого приложения закрывает текущую сессию; забытое «закрыто» считается
как 30 минут, сессия не длиннее 3 часов.

---

## 5. Siri-ассистент голосом

Команда, например, `Спроси lifestats` (её название и есть фраза для Siri):
1. **Dictate Text** (язык — русский).
2. **Get Contents of URL** `$SERVER/ask`, POST, **ключ Siri** (`/siri`), Request Body JSON: `text` = Dictated Text.
3. **Get Dictionary Value** `speech` из ответа.
4. **Speak Text** — выберите русский голос (иначе Siri промолчит).

Ответ и карточки дублируются в чат с ботом.

---

## Проверка

После запуска любой команды отправьте боту `/status`: напротив источника должно быть «последние данные N мин назад».
Если данных нет — запустите команду вручную (▶) и посмотрите ответ сервера в последнем действии.
