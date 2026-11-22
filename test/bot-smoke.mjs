// Смоук-тест бота без реального Telegram: подменяем fetch и прогоняем
// полный сценарий добавления товара с фото на отдельной тестовой БД.
// Запуск: node --experimental-sqlite test/bot-smoke.mjs
import { rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DATA = resolve(ROOT, 'data-test-bot');
rmSync(TEST_DATA, { recursive: true, force: true });

process.env.DATA_DIR = TEST_DATA;
process.env.TELEGRAM_BOT_TOKEN = '123456:TEST-TOKEN';
process.env.ADMIN_ID = '111';
process.env.QUIET_START = '1';

const ADMIN = 111;
const STRANGER = 222;
const records = [];
const sentTo = [];

const ok = (result) => new Response(JSON.stringify({ ok: true, result }), {
  status: 200, headers: { 'content-type': 'application/json' },
});

const msg = (id, text) => ({
  update_id: id,
  message: { message_id: id, from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' }, text },
});
const cb = (id, data) => ({
  update_id: id,
  callback_query: {
    id: 'cb' + id, from: { id: ADMIN },
    message: { message_id: 900 + id, chat: { id: ADMIN, type: 'private' } },
    data,
  },
});

const updates = [
  { update_id: 1, message: { message_id: 1, from: { id: STRANGER }, chat: { id: STRANGER }, text: '/start' } },
  msg(2, '/start'),
  cb(3, 'p:add'),
  msg(4, 'Смоук Худи'),
  msg(5, '49.90'),
  msg(6, '/skip'),
  msg(7, 'S,M,L'),
  msg(8, 'Чёрный,Белый'),
  msg(9, '5'),
  cb(10, 'awcol:-1'),
  {
    update_id: 11,
    message: {
      message_id: 11, from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' },
      photo: [{ file_id: 'FILE1', width: 10, height: 10 }],
    },
  },
  msg(12, '/готово'),
  cb(13, 'p:list:0'),
  cb(14, 'pe:1:stock'),
  msg(15, '9'),
  cb(16, 'disc:1'),
  cb(17, 'disc:1:10'),
  cb(18, 'p:1'),
  cb(19, 'menu'),
];

let served = false;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = u.split('/').pop().split('?')[0];

  if (u.includes('api.telegram.org/file/')) {
    return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200 });
  }

  const params = opts.body ? JSON.parse(opts.body) : {};
  records.push({ method, params });

  if (method === 'getMe') return ok({ id: 42, username: 'dvizh_test_bot', first_name: 'Test' });
  if (method === 'getUpdates') {
    if (!served) { served = true; return ok(updates); }
    await new Promise((r) => setTimeout(r, 15));
    return ok([]);
  }
  if (method === 'getFile') return ok({ file_id: params.file_id, file_path: 'photos/file_1.jpg' });
  if (method === 'sendMessage') { sentTo.push(params.chat_id); return ok({ message_id: 1 }); }
  if (method === 'editMessageText') return ok({ message_id: 1 });
  if (method === 'answerCallbackQuery') return ok(true);
  return ok(true);
};

await import('../bot.mjs');
await new Promise((r) => setTimeout(r, 1800));

const db = await import('../lib/db.mjs');
const { notifyAdmin } = await import('../lib/telegram.mjs');
await notifyAdmin('🔔 тестовое уведомление о заказе');
await new Promise((r) => setTimeout(r, 100));

const products = db.listProducts();
const product = products.find((p) => p.name === 'Смоук Худи');
const texts = records.filter((r) => r.method === 'sendMessage').map((r) => r.params.text);
const edits = records.filter((r) => r.method === 'editMessageText').map((r) => r.params.text);

const checks = {
  strangerDenied: texts.some((t) => String(t).includes('только администратору')),
  adminStill111: db.getSetting('admin_id') === '' || db.getSetting('admin_id') === '111',
  productCreated: Boolean(product),
  priceAfterDiscount: product?.price_cents === 4491,
  oldPriceKept: product?.old_price_cents === 4990,
  sizesOk: product?.sizes === 'S,M,L',
  colorsOk: product?.colors === 'Чёрный,Белый',
  stockEdited: product?.stock === 9,
  photoSaved: (product?.photos || []).length === 1,
  photoFileExists: product?.photos?.[0] ? existsSync(db.photoAbsolutePath(product.photos[0].path)) : false,
  productOnSite: db.listProducts({ activeOnly: true }).some((p) => p.name === 'Смоук Худи'),
  successMessage: texts.some((t) => String(t).includes('Товар создан')),
  listShown: edits.some((t) => String(t).includes('Товары')),
  discountShown: edits.some((t) => String(t).includes('Скидка')),
  notifySentToAdmin: records.some((r) => r.method === 'sendMessage'
    && Number(r.params.chat_id) === ADMIN && String(r.params.text).includes('тестовое уведомление')),
  sentOnlyKnown: sentTo.every((id) => Number(id) === ADMIN || Number(id) === STRANGER),
};

const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(JSON.stringify({ checks, failed, products: products.length }, null, 2));
db.closeDb();
rmSync(TEST_DATA, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
