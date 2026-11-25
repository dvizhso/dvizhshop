// Смоук-тест Cloudflare Worker на локальном SQLite-шиме D1.
// Запуск: node --experimental-sqlite test/worker-smoke.mjs
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../worker/src/index.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dvizh-worker-'));
const sqlite = new DatabaseSync(join(dir, 'shop.db'));

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  async first() { return this.db.prepare(this.sql).get(...this.params) || null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}
class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this.db, sql); }
  async exec(sql) { this.db.exec(sql); return { count: 0 }; }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
const DB = new D1(sqlite);
const ADMIN_ID = '111';
const WEBHOOK_SECRET = 'test-webhook-secret';
const env = {
  DB,
  TELEGRAM_BOT_TOKEN: '123456789:' + 'A'.repeat(35),
  ADMIN_ID,
  ADMIN_TOKEN: 'test-admin-token',
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  SITE_URL: 'https://dvizhso.github.io/dvizhshop',
};

const realFetch = globalThis.fetch;
const telegram = [];
let telegramDown = false;
globalThis.fetch = async (url, options) => {
  if (String(url).includes('api.telegram.org')) {
    const body = JSON.parse(options?.body || '{}');
    const method = String(url).split('/').pop();
    if (telegramDown && method === 'sendMessage') {
      return new Response(JSON.stringify({ ok: false, description: 'Bad Gateway' }), {
        status: 502, headers: { 'content-type': 'application/json' },
      });
    }
    telegram.push({ method, body });
    const result = method === 'getMe' ? { id: 1, username: 'dvizh_test_bot' } : { message_id: telegram.length };
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(url, options);
};

function ctx() {
  const pending = [];
  return { pending, waitUntil(p) { pending.push(p); } };
}

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const c = ctx();
  const res = await worker.fetch(new Request(`https://worker.test${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }), env, c);
  await Promise.allSettled(c.pending);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: Object.fromEntries(res.headers) };
}

async function runScheduled() {
  const c = ctx();
  await worker.scheduled({ scheduledTime: Date.now() }, env, c);
  await Promise.allSettled(c.pending);
}

async function webhook(update, secret = WEBHOOK_SECRET) {
  return call('/telegram/webhook', {
    method: 'POST',
    headers: secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {},
    body: update,
  });
}

const checks = {};
try {
  const health = await call('/health');
  checks.health = health.status === 200 && health.data.ok === true;
  checks.healthTelegram = health.data.telegram === true;
  checks.healthNoPhotos = health.data.photos === false;

  const catalog = await call('/api/catalog');
  checks.catalog = catalog.status === 200 && catalog.data.products.length === 6;
  checks.seededCollections = catalog.data.collections.length === 1;
  checks.seededBanner = catalog.data.banners.length === 1;
  checks.cors = catalog.headers['access-control-allow-origin'] === '*';

  const stockBefore = catalog.data.products.find((p) => p.id === 2).stock;
  const orderBody = {
    customer_name: 'Worker Покупатель',
    contact: '@worker_test',
    note: 'Cloudflare smoke',
    delivery: 'delivery',
    idempotency_key: 'smoke-key-0001',
    items: [{ productId: 2, size: 'XL', color: 'Чёрный', qty: 2 }],
  };
  const order = await call('/api/orders', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '203.0.113.10' },
    body: orderBody,
  });
  checks.orderCreated = order.status === 201 && order.data.ok === true && order.data.order.total === 11000;
  checks.publicId = /^[A-Z0-9]{8,}$/.test(order.data.order.public_id || '');

  const firstMessage = telegram.find((m) => m.method === 'sendMessage');
  checks.telegramSent = Boolean(firstMessage) && String(firstMessage.body.chat_id) === ADMIN_ID;
  checks.notificationFormat = Boolean(firstMessage)
    && /НОВЫЙ ЗАКАЗ — DVIZH SHOP/.test(firstMessage.body.text)
    && /Заказ №: <b>00001<\/b>/.test(firstMessage.body.text)
    && /👤 Покупатель: Worker Покупатель/.test(firstMessage.body.text)
    && /🔗 Telegram: @worker_test/.test(firstMessage.body.text)
    && /📋 <b>Товары:<\/b>/.test(firstMessage.body.text)
    && /📏 Размер: XL/.test(firstMessage.body.text)
    && /🎨 Цвет: Чёрный/.test(firstMessage.body.text)
    && /🔢 Количество: 2/.test(firstMessage.body.text)
    && /💶 Цена: 55 € за штуку/.test(firstMessage.body.text)
    && /💰 <b>Общая сумма: 110 €<\/b>/.test(firstMessage.body.text)
    && /📍 Способ получения: Доставка/.test(firstMessage.body.text)
    && /📞 Контакт покупателя: @worker_test/.test(firstMessage.body.text)
    && /🕒 Время оформления: /.test(firstMessage.body.text)
    && /Статус: <b>🆕 Новая заявка<\/b>/.test(firstMessage.body.text);
  const buttons = firstMessage?.body.reply_markup?.inline_keyboard?.flat() || [];
  checks.notificationButtons = ['☑ Принять заявку', '❌ Отклонить заявку', '📋 Посмотреть подробности', '📦 Отметить как выполненную']
    .every((label) => buttons.some((b) => b.text === label));

  const queueAfterSend = sqlite.prepare('SELECT COUNT(*) AS c FROM notify_queue WHERE sent_at IS NULL').get();
  checks.notificationQueued = Number(queueAfterSend.c) === 0;

  // Повторная отправка того же заказа с тем же ключом не создаёт дубль.
  const sentBefore = telegram.length;
  const duplicate = await call('/api/orders', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '203.0.113.99' },
    body: orderBody,
  });
  const orderCount = sqlite.prepare('SELECT COUNT(*) AS c FROM orders').get();
  checks.idempotentOrder = duplicate.status === 201
    && duplicate.data.order.public_id === order.data.order.public_id
    && Number(orderCount.c) === 1
    && telegram.length === sentBefore;

  const after = await call('/api/catalog');
  checks.stockDecremented = after.data.products.find((p) => p.id === 2).stock === stockBefore - 2;

  env.TELEGRAM_BOT_TOKEN = '';

  const tooMany = await call('/api/orders', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '203.0.113.11' },
    body: { customer_name: 'Жадный', delivery: 'pickup', items: [{ productId: 2, size: 'M', qty: 20 }] },
  });
  checks.stockGuard = tooMany.status === 400 && /осталось/i.test(tooMany.data.error);

  const badName = await call('/api/orders', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '203.0.113.12' },
    body: { customer_name: 'X', items: [{ productId: 1, qty: 1 }] },
  });
  checks.nameGuard = badName.status === 400;

  env.TELEGRAM_BOT_TOKEN = '123456789:' + 'A'.repeat(35);

  // Telegram «лежит»: заявка должна сохраниться, а уведомление — остаться в очереди.
  telegramDown = true;
  const offline = await call('/api/orders', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '203.0.113.13' },
    body: {
      customer_name: 'Оффлайн Покупатель',
      contact: '+49 000 000',
      delivery: 'pickup',
      items: [{ productId: 1, size: 'M', color: 'Белый', qty: 1 }],
    },
  });
  const queued = sqlite.prepare('SELECT COUNT(*) AS c FROM notify_queue WHERE sent_at IS NULL').get();
  checks.orderSavedWhenTelegramDown = offline.status === 201;
  checks.notificationQueuedOnFailure = Number(queued.c) === 1;
  checks.pickupPersisted = sqlite.prepare("SELECT delivery FROM orders WHERE customer_name = 'Оффлайн Покупатель'").get().delivery === 'pickup';

  telegramDown = false;
  await runScheduled();
  const queuedAfterRetry = sqlite.prepare('SELECT COUNT(*) AS c FROM notify_queue WHERE sent_at IS NULL').get();
  checks.notificationRetry = Number(queuedAfterRetry.c) === 0;

  // Webhook: без секрета доступ закрыт.
  const noSecret = await webhook({ message: { from: { id: 222 }, chat: { id: 222 }, text: '/start' } }, '');
  checks.webhookSecret = noSecret.status === 401;

  // Посторонний без ссылки на заказ получает только кнопку магазина.
  telegram.length = 0;
  const stranger = await webhook({
    update_id: 1,
    message: { message_id: 5, from: { id: 222 }, chat: { id: 222 }, text: '/start' },
  });
  const strangerReply = telegram.find((m) => m.method === 'sendMessage');
  checks.botOwnerGateDeny = stranger.status === 200
    && /бот магазина DVIZH/.test(strangerReply?.body?.text || '')
    && !/панель управления/.test(strangerReply?.body?.text || '');

  // Покупатель открывает бота по ссылке ?start=<public_id> и подписывается на статус.
  telegram.length = 0;
  const subscribe = await webhook({
    update_id: 2,
    message: {
      message_id: 6, from: { id: 222, username: 'buyer_user' }, chat: { id: 222 },
      text: `/start ${order.data.order.public_id}`,
    },
  });
  const subscribeReply = telegram.find((m) => m.method === 'sendMessage');
  const linked = sqlite.prepare('SELECT tg_chat_id, tg_username FROM orders WHERE id = 1').get();
  checks.buyerSubscribed = subscribe.status === 200
    && /подписан на статус заказа №00001/.test(subscribeReply?.body?.text || '')
    && linked.tg_chat_id === '222'
    && linked.tg_username === 'buyer_user';

  // Владелец открывает меню.
  telegram.length = 0;
  const owner = await webhook({
    update_id: 3,
    message: { message_id: 7, from: { id: 111 }, chat: { id: 111 }, text: '/start' },
  });
  const ownerReply = telegram.find((m) => m.method === 'sendMessage');
  checks.botOwnerGateAllow = owner.status === 200
    && /панель управления/.test(ownerReply?.body?.text || '')
    && ownerReply?.body?.reply_markup?.inline_keyboard?.length > 0;

  // Кнопка «В обработке» меняет статус и уведомляет покупателя.
  telegram.length = 0;
  const accepted = await webhook({
    update_id: 4,
    callback_query: {
      id: 'cb-1',
      from: { id: 111 },
      data: 'ost:1:processing',
      message: { message_id: 8, chat: { id: 111 } },
    },
  });
  const statusRow = sqlite.prepare('SELECT status, tg_message_id FROM orders WHERE id = 1').get();
  const buyerMessage = telegram.find((m) => m.method === 'sendMessage' && String(m.body.chat_id) === '222');
  checks.statusButtonPersists = accepted.status === 200 && statusRow.status === 'processing';
  checks.buyerNotified = Boolean(buyerMessage)
    && /статус заказа/.test(buyerMessage.body.text)
    && /⚙️ В обработке/.test(buyerMessage.body.text);

  // Посторонний не может менять статус.
  telegram.length = 0;
  const strangerButton = await webhook({
    update_id: 5,
    callback_query: {
      id: 'cb-2',
      from: { id: 222 },
      data: 'ost:1:cancelled',
      message: { message_id: 9, chat: { id: 222 } },
    },
  });
  const afterStranger = sqlite.prepare('SELECT status FROM orders WHERE id = 1').get();
  checks.strangerCannotChangeStatus = strangerButton.status === 200 && afterStranger.status === 'processing';

  const noAdmin = await call('/api/admin/summary');
  checks.adminGuard = noAdmin.status === 401;

  const summary = await call('/api/admin/summary', { headers: { 'X-Admin-Token': 'test-admin-token' } });
  checks.adminSummary = summary.status === 200 && summary.data.stats.products === 6 && summary.data.stats.orders === 2;

  const created = await call('/api/admin/products', {
    method: 'POST',
    headers: { 'X-Admin-Token': 'test-admin-token' },
    body: { name: 'Worker Кепка', price_cents: 1990, sizes: 'ONE SIZE', colors: 'Чёрный', stock: 3 },
  });
  checks.adminCreate = created.status === 201 && created.data.product.name === 'Worker Кепка';

  const photoData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  const photo = await call(`/api/admin/products/${created.data.product.id}/photos`, {
    method: 'POST',
    headers: { 'X-Admin-Token': 'test-admin-token' },
    body: { data: photoData, mime: 'image/png' },
  });
  // R2 не подключён: загрузка фото возвращает понятную ошибку, Worker не падает.
  checks.photoUpload = photo.status === 503 && /Хранение фото не подключено/.test(photo.data.error || '');
  const photosInDb = sqlite.prepare('SELECT COUNT(*) AS c FROM product_photos').get();
  checks.noPhotoRecords = Number(photosInDb.c) === 0;

  const served = await call('/uploads/test.jpg');
  checks.photoServed = served.status === 503 && /Хранение фото не подключено/.test(served.data.error || '');

  const removed = await call(`/api/admin/products/${created.data.product.id}`, {
    method: 'DELETE',
    headers: { 'X-Admin-Token': 'test-admin-token' },
  });
  checks.deleteProductWithoutR2 = removed.status === 200 && removed.data.ok === true;

  const orders = await call('/api/admin/orders', { headers: { 'X-Admin-Token': 'test-admin-token' } });
  checks.ordersList = orders.status === 200 && orders.data.orders.length === 2 && orders.data.orders[0].items.length === 1;

  // Смена статуса через admin API тоже уведомляет покупателя.
  telegram.length = 0;
  const status = await call(`/api/admin/orders/1`, {
    method: 'PATCH',
    headers: { 'X-Admin-Token': 'test-admin-token' },
    body: { status: 'done' },
  });
  const doneBuyer = telegram.find((m) => m.method === 'sendMessage' && String(m.body.chat_id) === '222');
  checks.orderStatus = status.status === 200 && status.data.order.status === 'done';
  checks.buyerNotifiedDone = Boolean(doneBuyer) && /🏁 Выполнен/.test(doneBuyer.body.text);

  const hook = await call('/api/admin/telegram/webhook', {
    method: 'POST',
    headers: { 'X-Admin-Token': 'test-admin-token' },
    body: { url: 'https://worker.test' },
  });
  checks.webhookRegistration = hook.status === 200 && hook.data.ok === true
    && hook.data.url === 'https://worker.test/telegram/webhook'
    && hook.data.bot === '@dvizh_test_bot';
} finally {
  globalThis.fetch = realFetch;
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
}

const failed = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
console.log(JSON.stringify({ checks, failed, telegramMessages: telegram.length }, null, 2));
process.exit(failed.length ? 1 : 0);
