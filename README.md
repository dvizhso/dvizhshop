# DVIZH FREIBURG — SHOP + ADMIN BOT

Работающий интернет-магазин DVIZH FREIBURG и отдельный Telegram-бот администратора.
Сайт и бот используют **одну общую базу данных**: всё, что меняется в боте, сразу появляется на сайте.

```
                    ┌────────────────────────────┐
   покупатель ────► │  public/  (frontend)        │
                    │  HTML + CSS + JS             │
                    └──────────────┬─────────────┘
                                   │ /api/catalog, /api/orders
                    ┌──────────────▼─────────────┐
                    │  server.mjs  (backend API)  │
                    └──────────────┬─────────────┘
                                   │
                    ┌──────────────▼─────────────┐        ┌─────────────────────┐
                    │  data/shop.db  (SQLite)     │ ◄───── │  bot.mjs            │
                    │  товары, фото, заказы,      │        │  Telegram ADMIN BOT │
                    │  коллекции, баннеры, тексты │        │  (панель управления)│
                    └──────────────┬─────────────┘        └─────────────────────┘
                                   │
                    ┌──────────────▼─────────────┐
                    │  data/uploads/  (фото)      │
                    └────────────────────────────┘
```

- **Frontend** — статический `public/`, данные берёт из API.
- **Backend (локально)** — `server.mjs` на встроенном `node:http`, без внешних зависимостей.
- **Backend (публично, бесплатно)** — `worker/` на Cloudflare Workers + D1, пока сайт на GitHub Pages. R2 не требуется.
- **База** — SQLite через встроенный `node:sqlite` (Node 22+) либо D1 в облаке.
- **Бот** — `bot.mjs` локально или `worker/src/bot.mjs` в облаке; оба меняют то, что видит покупатель.
- **Фото** — локально `data/uploads/`; в облаке хранилище не подключено, загрузка фото отключена аккуратно (без падений) и легко включается позже через R2.
- **Уведомления о заказах** — отдельный модуль: заявка сохраняется, ставится в очередь и уходит владельцу в Telegram.

---

## Быстрый старт

Нужен **Node.js 22.5 или новее** (проверьте: `node -v`).

```bash
# 1. зависимости не нужны — их нет
npm run setup               # локальный мастер: безопасно вставить токен бота
# (альтернатива: npm run setup:cli — скрытый ввод прямо в терминале)

# 2. создать базу и базовый каталог
npm run seed

# 3. сайт
npm start                   # http://localhost:8088

# 4. бот — во втором терминале
npm run bot
```

`npm run setup` открывает страницу **только на вашем компьютере** (`127.0.0.1`, одноразовая ссылка).
Токен вводится в поле с типом `password`, проверяется через Telegram и сохраняется в `.env`
с правами только для вашего пользователя. В чат, репозиторий, браузерное хранилище или логи
токен не попадает.

Windows-скрипты: `start-shop.bat` и `start-bot.bat` — при первом запуске сами открывают
мастер настройки, если файла `.env` ещё нет. `start.sh` делает то же через терминал.

> **Никогда не вставляйте токен бота в переписку, GitHub, сайт или скриншоты.**
> Если токен уже попал в чат — отзовите его: @BotFather → `/revoke` → выберите бота,
> затем введите новый токен через `npm run setup`.

### Безопасный ввод токена

Два способа, оба не показывают токен на экране и не отправляют его никуда, кроме Telegram:

1. **Локальный мастер в браузере** — `npm run setup`
   - поднимает сервер только на `127.0.0.1` со случайным портом и одноразовым ключом в ссылке;
   - страница недоступна из сети и с публичного сервера;
   - поле токена скрыто (`type=password`), значение не сохраняется в браузере;
   - токен проверяется запросом `getMe` и пишется в `.env`;
   - после сохранения одноразовый ключ уничтожается, мастер завершается.

2. **Терминал со скрытым вводом** — `npm run setup:cli`
   - токен не отображается и не попадает в историю команд;
   - можно оставить текущий токен, нажав Enter.

Файл `.env` создаётся с правами `600` (POSIX) или ограниченным ACL текущего пользователя (Windows).
Повторный запуск любого мастера заменяет токен. В переписку и GitHub токен вставлять не нужно.

### Как получить токен бота и ADMIN_ID

1. В Telegram откройте **@BotFather** → `/newbot` → имя и username бота.
2. Скопируйте токен в `TELEGRAM_BOT_TOKEN`.
3. Свой числовой id узнайте у **@userinfobot** и укажите в `ADMIN_ID`.
4. Запустите `npm run bot` и отправьте боту `/start`.

Если `ADMIN_ID` пуст, администратором становится тот, кто первым отправит боту `/start`
(id сохраняется в базе). Все остальные пользователи получают отказ.

---

## Что умеет бот

| Раздел | Возможности |
|---|---|
| 📦 Товары | добавить, изменить название/описание, размеры, цвета, цену, склад, скрыть/показать, удалить |
| 🖼 Фото | загрузить несколько фото подряд, удалить любое фото |
| 🏷 Цены | ручная цена, скидки −10/−15/−20/−25 %, сброс скидки (старая цена показывается зачёркнутой) |
| 🎨 Коллекции | создать, переименовать, скрыть/показать, удалить |
| 🖼 Баннеры | создать, загрузить фото, включить/выключить, удалить |
| 📝 Тексты сайта | бейдж, заголовок, подзаголовок, объявление, подвал, ссылка «Связаться» |
| 🛒 Заказы | уведомление о новом заказе, список и фильтры, состав/размер/цвет/кол-во, контакты, доставка/самовывоз, смена статуса |

Статусы заказа: `новая → подтверждён → в обработке → подготовлен → выполнен` (или `отклонён`).

При оформлении заказа на сайте:
1. сервер проверяет товары и остатки **по базе** (цены с клиента игнорируются);
2. один и тот же запрос с тем же `idempotency_key` не создаёт второй заказ;
3. создаёт заказ и позиции в транзакции, уменьшает склад;
4. ставит уведомление в очередь и отправляет его владельцу в Telegram;
5. если покупатель нажал «Получать статус в Telegram» и запустил бота, ему приходят уведомления о смене статуса.

Пример уведомления владельцу:

```
🛍 НОВЫЙ ЗАКАЗ — DVIZH SHOP

📦 Заказ №: 00125
👤 Покупатель: Александр
🔗 Telegram: @username

📋 Товары:
1. Худи DVIZH
   📏 Размер: L
   🎨 Цвет: Чёрный
   🔢 Количество: 1
   💶 Цена: 45 €

💰 Общая сумма: 45 €
📍 Способ получения: Доставка
📞 Контакт покупателя: @username
🕒 Время оформления: 23.11.2026, 14:35 (Берлин)

Статус: 🆕 Новая заявка
```

Кнопки: `☑ Принять заявку`, `❌ Отклонить заявку`, `📋 Посмотреть подробности`, `📦 Отметить как выполненную`.

---

## Структура проекта

```
dvizhshop/
├─ server.mjs              # HTTP-сервер: статика + публичный и admin API
├─ bot.mjs                 # Telegram admin bot
├─ lib/
│  ├─ core.mjs             # env, деньги, слаги, безопасный fetch
│  ├─ db.mjs               # схема и все операции с SQLite
│  ├─ envfile.mjs          # безопасная запись .env и права доступа
│  ├─ setup.mjs            # проверка токена и сохранение настроек
│  └─ telegram.mjs         # Bot API, скачивание фото, уведомления
├─ worker/
│  ├─ src/index.mjs        # Cloudflare Worker: API, webhook, очередь уведомлений
│  ├─ src/db.mjs           # D1: схема, каталог, заказы, admin CRUD
│  ├─ src/telegram.mjs     # Bot API и формат уведомления о заявке
│  ├─ src/notify.mjs       # отдельный модуль уведомлений и повторных попыток
│  └─ src/bot.mjs          # личный Telegram-бот владельца (webhook)
├─ wrangler.toml           # Cloudflare: D1, cron (R2 закомментирован, опционален)
├─ .github/workflows/pages.yml  # публикация public/ на GitHub Pages
├─ public/
│  ├─ index.html           # магазин
│  ├─ styles.css           # фирменный стиль
│  ├─ app.js               # каталог, корзина, оформление
│  └─ favicon.svg
├─ scripts/
│  ├─ seed.mjs             # первичное наполнение (идемпотентно)
│  ├─ setup-web.mjs        # локальный мастер настройки в браузере
│  ├─ setup.mjs            # мастер настройки со скрытым вводом
│  └─ publish-github.mjs   # публикация файлов в GitHub (токен скрыт)
├─ data/                   # БД + фото (создаётся автоматически, в git не попадает)
├─ Dockerfile
├─ docker-compose.yml
└─ .env.example
```

---

## Публичный API

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/catalog` | активные товары, коллекции, баннеры, тексты сайта |
| `POST` | `/api/orders` | создать заявку |
| `GET` | `/health` | состояние сервера |

Пример заявки:

```json
POST /api/orders
{
  "customer_name": "Имя",
  "contact": "@username",
  "note": "комментарий",
  "delivery": "delivery",
  "idempotency_key": "f3f0c2a1-...",
  "items": [{ "productId": 1, "size": "M", "color": "Чёрный", "qty": 2 }]
}
```

`delivery`: `delivery` (доставка) или `pickup` (самовывоз).
`idempotency_key`: необязательный ключ повтора. Повторный запрос с тем же ключом
возвращает уже созданный заказ и не отправляет уведомление второй раз.

Ответ: `{ "ok": true, "order": { "public_id": "...", "total": 5000 } }`.

Ограничение: не более 5 заявок с одного IP за 10 минут.

## Admin API

Все методы требуют заголовок `X-Admin-Token: <ADMIN_TOKEN>`.

```
GET    /api/admin/summary
GET    /api/admin/products          POST   /api/admin/products
GET    /api/admin/products/:id      PATCH  /api/admin/products/:id
DELETE /api/admin/products/:id
POST   /api/admin/products/:id/photos   { data: "<base64>", mime: "image/jpeg" }
DELETE /api/admin/photos/:id
GET    /api/admin/collections       POST   /api/admin/collections
PATCH  /api/admin/collections/:id   DELETE /api/admin/collections/:id
GET    /api/admin/banners           POST   /api/admin/banners
PATCH  /api/admin/banners/:id       DELETE /api/admin/banners/:id
GET    /api/admin/orders?status=new
GET    /api/admin/orders/:id        PATCH  /api/admin/orders/:id  { "status": "confirmed" }
GET    /api/admin/settings          PATCH  /api/admin/settings
POST   /api/admin/telegram/webhook  # регистрация webhook + сохранение username бота
POST   /api/admin/telegram/retry    # повтор неотправленных уведомлений
```

`ADMIN_TOKEN` нужен только для внешних интеграций и registration webhook. Бот работает с базой
через тот же Worker, поэтому при пустом `ADMIN_TOKEN` admin API отключён, а бот продолжает работать.
Смена статуса через бот или через admin API отправляет уведомление покупателю, если он запустил
бота по ссылке из экрана подтверждения заказа.

---

## Публикация кода на GitHub

```bash
npm run publish
```

Мастер попросит **fine-grained PAT** с доступом `Contents: Read and write` к репозиторию
`dvizhso/dvizhshop`. Ввод скрытый, токен не сохраняется на диск и не печатается.
Скрипт отправляет только код из фиксированного списка: `.env`, `data/`, фото и временные
файлы в GitHub не попадают. Остальные файлы репозитория (например,
`dvizh_freiburg_shop_custom_design.html`) сохраняются.

Можно передать токен через переменную окружения `GITHUB_TOKEN`, например в CI.

---

## Деплой

### Вариант A — GitHub Pages + Cloudflare Workers (бесплатно, без своего ПК)

Сайт живёт на GitHub Pages, а приём заказов, база, фото и Telegram-бот — на Cloudflare.
Ваш компьютер может быть выключен: всё работает в облаке.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dvizhso/dvizhshop)

1. Нажмите кнопку и авторизуйте Cloudflare. Он сам создаст Worker и базу D1
   `dvizh-shop-db` (см. `wrangler.toml`). Бакет R2 не нужен.
2. В Worker → **Settings → Variables and Secrets** добавьте секреты:
   - `TELEGRAM_BOT_TOKEN` — токен бота от @BotFather;
   - `ADMIN_ID` — только ваш Telegram ID (бот никого больше не пустит);
   - `ADMIN_TOKEN` — длинная случайная строка для admin API;
   - `TELEGRAM_WEBHOOK_SECRET` — длинная случайная строка для проверки webhook.
   Токен хранится только в секретах Cloudflare, в коде сайта его нет.
3. Зарегистрируйте webhook (один раз):

   ```bash
   curl -X POST https://<worker>.workers.dev/api/admin/telegram/webhook \
     -H "X-Admin-Token: <ADMIN_TOKEN>"
   ```

   Worker сам вызовет `setWebhook` с секретным заголовком и сохранит username бота —
   он понадобится сайту для ссылки «Получать статус в Telegram».
4. В GitHub → **Settings → Secrets and variables → Actions → Variables** добавьте
   `SHOP_API_BASE = https://<worker>.workers.dev`.
5. GitHub → **Settings → Pages → Source: GitHub Actions**. После пуша в `main`
   workflow `.github/workflows/pages.yml` соберёт сайт и подставит адрес API.
6. Откройте `https://dvizhso.github.io/dvizhshop/`, оформите тестовую заявку —
   в Telegram придёт сообщение с кнопками «Принять / Отклонить / Подробности / Выполнено».
7. На экране «Заявка отправлена» покупатель может нажать «Получать статус в Telegram».
   Это откроет того же бота со ссылкой `/start <номер заказа>`; после запуска бот
   запомнит чат и будет присылать статусы только по этому заказу. Административные
   команды посторонним по-прежнему недоступны.

Если Cloudflare не смог создать D1 автоматически (старая версия Wrangler), создайте базу
вручную и впишите её идентификатор в `wrangler.toml`:

```bash
npx wrangler d1 create dvizh-shop-db
```

```toml
[[d1_databases]]
binding = "DB"
database_name = "dvizh-shop-db"
database_id = "<id из вывода команды>"
```

Затем повторите деплой. Схема таблиц создаётся автоматически при первом запросе к Worker.

#### Фото позже (необязательно)

Чтобы включить загрузку фото в облаке, раскомментируйте блок `[[r2_buckets]]` в `wrangler.toml`
и создайте бакет командой `npx wrangler r2 bucket create dvizh-shop-photos`. Код Worker уже
проверяет наличие биндинга `BUCKET`: без него заказы, каталог и бот работают нормально,
а запросы на загрузку фото возвращают понятную ошибку вместо падения.

Если Telegram временно недоступен, заявка всё равно сохраняется, а Worker повторяет
отправку по cron-расписанию каждые 5 минут (`notify_queue`). Вручную повторить очередь:

```bash
curl -X POST https://<worker>.workers.dev/api/admin/telegram/retry \
  -H "X-Admin-Token: <ADMIN_TOKEN>"
```

Проверка Worker локально:

```bash
npm run test:worker
```

### Вариант B — свой сервер / VPS

Нужен постоянно работающий процесс (VPS, домашний сервер, любой хостинг с Node).

#### Docker Compose

```bash
cp .env.example .env    # заполнить
docker compose up -d --build
docker compose exec shop node --experimental-sqlite scripts/seed.mjs   # один раз
```

`data/` монтируется в контейнеры, поэтому база и фото сохраняются между перезапусками.

#### VPS + systemd

```ini
# /etc/systemd/system/dvizh-shop.service
[Unit]
Description=DVIZH FREIBURG shop
After=network.target

[Service]
WorkingDirectory=/opt/dvizhshop
ExecStart=/usr/bin/node --experimental-sqlite server.mjs
Restart=always
User=dvizh

[Install]
WantedBy=multi-user.target
```

Аналогичный unit для `bot.mjs` (`dvizh-bot.service`). Перед публикацией поставьте
Nginx/Caddy с HTTPS и проксированием на `127.0.0.1:8088`.

В `.env` на сервере укажите реальный `SITE_URL`, например `https://shop.example.com`.

---

## Резервные копии

Вся система — это два каталога:

```bash
tar -czf backup-$(date +%F).tar.gz data/
```

Для SQLite можно копировать `data/shop.db` вместе с `-wal` и `-shm` либо делать
`sqlite3 data/shop.db ".backup 'backup.db'"`. Фото лежат в `data/uploads/`.

---

## Безопасность

- `.env` и `data/` в `.gitignore`; токены не попадают в репозиторий.
- Бот (локальный) отвечает только `ADMIN_ID` либо владельцу, закрепившемуся первым `/start`.
  Облачный бот `worker/src/bot.mjs` принимает **только** `ADMIN_ID` из секретов — без исключений.
- `ADMIN_TOKEN` сравнивается за постоянное время; без него admin API недоступен.
- Webhook Telegram проверяет заголовок `X-Telegram-Bot-Api-Secret-Token`.
- Заявки принимаются с серверной проверкой цен, остатков и лимитом по IP (5 за 10 минут).
- Все пользовательские строки экранируются: в боте — HTML, на сайте — `textContent`.
- После настройки перевыпустите токены, которые передавались в переписке.

Для продакшена обязательно: HTTPS, сильный `ADMIN_TOKEN`, закрытый `ADMIN_ID`,
регулярные бэкапы `data/`.

---

## Расширение

- Новые поля товара: добавьте колонку в `SCHEMA` (`lib/db.mjs`), затем в `createProduct`/`updateProduct`
  и в `publicCatalog()` (`server.mjs`).
- Новые разделы бота: обработчик callback в `onCallback` + пункт меню в `showMenu`.
- Оплата: добавьте платёжный провайдер в `POST /api/orders` после создания заказа,
  не меняя модель данных.
- Аналитика: `stats()` в `lib/db.mjs` уже отдаёт базовые счётчики.

---

## Возможные проблемы

| Симптом | Решение |
|---|---|
| `SQLite is an experimental feature` | это предупреждение, не ошибка; скрипты уже запускаются с `--experimental-sqlite` |
| `TELEGRAM_BOT_TOKEN не задан` | заполните `.env` рядом с проектом |
| Бот молчит | проверьте `ADMIN_ID`, запущен ли `npm run bot`, нет ли второго экземпляра бота |
| Фото не видны | проверьте права на `data/uploads/` и что каталог данных тот же у сайта и бота |
| Порт занят | измените `PORT` в `.env` |
| Изменения не видны сразу | обновите страницу; каталог кэшируется на 20 секунд и сам обновляется раз в минуту |
