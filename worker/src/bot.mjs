// Telegram-бот администратора для Cloudflare Worker.
// Работает через webhook и ту же D1-базу, что и сайт.
import {
  ensureSchema, getSetting, getSettings, setSetting,
  listProducts, getProduct, createProduct, updateProduct, deleteProduct,
  addProductPhoto, getPhoto, deletePhoto,
  listCollections, getCollection, createCollection, updateCollection, deleteCollection,
  listOrders, getOrder, getOrderByPublicId, linkOrderChat, setOrderStatus,
  stats, STATUS_LABELS, DELIVERY_LABELS,
} from './db.mjs';
import { tg, escapeHtml, money, formatOrderTime, orderNo } from './telegram.mjs';
import { notifyBuyerStatus } from './notify.mjs';

const PAGE = 8;
const FIELD_PROMPTS = {
  name: 'Введите новое название:',
  price: 'Введите новую цену в € (например 49.90):',
  desc: 'Введите новое описание (до 2000 символов). /skip — очистить:',
  sizes: 'Введите размеры через запятую (например S,M,L,XL):',
  colors: 'Введите цвета через запятую (например Чёрный,Белый):',
  stock: 'Введите количество на складе (целое число):',
};
const WIZARD = {
  name: { prompt: '1/6 · Название товара?\nНапример: Худи DVIZH Classic' },
  price: { prompt: '2/6 · Цена в €?\nНапример: 55 или 55.50' },
  desc: { prompt: '3/6 · Описание товара?\n(/skip — без описания)' },
  sizes: { prompt: '4/6 · Размеры через запятую?\nНапример: S,M,L,XL\n(/skip — S,M,L,XL)' },
  colors: { prompt: '5/6 · Цвета через запятую?\nНапример: Чёрный,Белый\n(/skip — Чёрный)' },
  stock: { prompt: '6/6 · Сколько штук на складе?\nНапример: 10' },
};

const kb = (rows) => ({ inline_keyboard: rows });
const backBtn = (target = 'menu', label = '← В меню') => [{ text: label, callback_data: target }];

async function reply(env, chatId, text, markup) {
  return tg(env, 'sendMessage', {
    chat_id: chatId,
    text: String(text).slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(markup ? { reply_markup: markup } : {}),
  });
}

async function edit(env, cq, text, markup) {
  try {
    await tg(env, 'editMessageText', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: String(text).slice(0, 4000),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(markup ? { reply_markup: markup } : {}),
    });
  } catch (error) {
    if (!/not modified/i.test(String(error.message))) throw error;
  }
}

async function getSession(env, chatId) {
  const row = await env.DB.prepare('SELECT state FROM bot_sessions WHERE chat_id = ?').bind(String(chatId)).first();
  if (!row) return null;
  try { return JSON.parse(row.state); } catch { return null; }
}
async function setSession(env, chatId, state) {
  await env.DB.prepare(`INSERT INTO bot_sessions (chat_id, state, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`)
    .bind(String(chatId), JSON.stringify(state)).run();
}
async function clearSession(env, chatId) {
  await env.DB.prepare('DELETE FROM bot_sessions WHERE chat_id = ?').bind(String(chatId)).run();
}

// Бот строго личный: администратор задаётся ТОЛЬКО через секрет ADMIN_ID.
// Никакого «первого /start» и никаких значений из базы — иначе посторонний
// мог бы перехватить управление магазином.
async function currentAdmin(env) {
  const envId = Number(env.ADMIN_ID);
  return Number.isFinite(envId) && envId > 0 ? String(envId) : '';
}

function productText(p) {
  return [
    `${p.active ? '🟢' : '⚪'} <b>${escapeHtml(p.name)}</b>  <code>#${p.id}</code>`,
    `Цена: <b>${money(p.price_cents)} €</b>${p.old_price_cents ? `  <s>${money(p.old_price_cents)} €</s>` : ''}`,
    p.collection_name ? `Коллекция: ${escapeHtml(p.collection_name)}` : 'Коллекция: —',
    `Размеры: ${escapeHtml(p.sizes || '—')}`,
    `Цвета: ${escapeHtml(p.colors || '—')}`,
    `Склад: <b>${p.stock} шт.</b>${p.stock <= 0 ? '  ❗ нет в наличии' : p.stock <= 2 ? '  ⚠️ мало' : ''}`,
    `Фото: ${(p.photos || []).length} шт.`,
    '',
    p.description ? escapeHtml(p.description).slice(0, 700) : '<i>без описания</i>',
  ].join('\n');
}

function productKeyboard(p) {
  return kb([
    [{ text: '✏️ Название', callback_data: `pe:${p.id}:name` }, { text: '✏️ Цена', callback_data: `pe:${p.id}:price` }],
    [{ text: '✏️ Описание', callback_data: `pe:${p.id}:desc` }, { text: '📐 Размеры', callback_data: `pe:${p.id}:sizes` }],
    [{ text: '🎨 Цвета', callback_data: `pe:${p.id}:colors` }, { text: '📦 Склад', callback_data: `pe:${p.id}:stock` }],
    [{ text: '🏷 Скидка', callback_data: `disc:${p.id}` }, { text: `🖼 Фото (${(p.photos || []).length})`, callback_data: `pp:${p.id}` }],
    [{ text: '🎨 Коллекция', callback_data: `pcol:${p.id}` }, { text: p.active ? '⚪ Скрыть' : '🟢 Показать', callback_data: `pt:${p.id}` }],
    [{ text: '🗑 Удалить товар', callback_data: `pdl:${p.id}` }],
    backBtn('p:list:0', '← К товарам'),
  ]);
}

async function showProduct(env, chatId, id, cq = null) {
  const product = await getProduct(env, id);
  if (!product) return cq ? edit(env, cq, 'Товар не найден', kb([backBtn('p:list:0')])) : reply(env, chatId, 'Товар не найден');
  if (cq) return edit(env, cq, productText(product), productKeyboard(product));
  return reply(env, chatId, productText(product), productKeyboard(product));
}

async function showProducts(env, chatId, page = 0, cq = null) {
  const all = await listProducts(env);
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const cur = Math.min(Math.max(0, page), pages - 1);
  const rows = all.slice(cur * PAGE, cur * PAGE + PAGE).map((p) => [{
    text: `${p.active ? '🟢' : '⚪'} ${p.name} — ${money(p.price_cents)} € (${p.stock} шт.)`,
    callback_data: `p:${p.id}`,
  }]);
  if (pages > 1) {
    const nav = [];
    if (cur > 0) nav.push({ text: '‹', callback_data: `p:list:${cur - 1}` });
    nav.push({ text: `${cur + 1}/${pages}`, callback_data: 'noop' });
    if (cur < pages - 1) nav.push({ text: '›', callback_data: `p:list:${cur + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: '➕ Добавить товар', callback_data: 'p:add' }]);
  rows.push(backBtn('menu'));
  const text = all.length
    ? `📦 <b>Товары</b> — ${all.length} шт.\nВыберите товар для управления:`
    : '📦 Товаров пока нет. Добавьте первый!';
  if (cq) return edit(env, cq, text, kb(rows));
  return reply(env, chatId, text, kb(rows));
}

async function showMenu(env, chatId, cq = null, hello = false) {
  const s = await stats(env);
  const text = [
    hello ? '👋 <b>DVIZH FREIBURG — панель управления</b>' : '🏠 <b>Главное меню</b>',
    '',
    `📦 Товаров: ${s.products} (на сайте: ${s.active})`,
    `🎨 Коллекций: ${s.collections}`,
    `🛒 Заказов: ${s.orders} · новых: <b>${s.newOrders}</b>`,
    s.lowStock ? `⚠️ Мало на складе: ${s.lowStock} поз.` : '',
    '',
    'Всё, что вы меняете здесь, сразу появляется на сайте.',
  ].filter(Boolean).join('\n');
  const markup = kb([
    [{ text: '📦 Товары', callback_data: 'p:list:0' }, { text: '➕ Добавить товар', callback_data: 'p:add' }],
    [{ text: '🎨 Коллекции', callback_data: 'col:list' }, { text: '🛒 Заказы', callback_data: 'ord:new:0' }],
    [{ text: '📝 Тексты сайта', callback_data: 'set:list' }],
  ]);
  if (cq) return edit(env, cq, text, markup);
  return reply(env, chatId, text, markup);
}

function settingsLabels() {
  return {
    hero_badge: 'Бейдж в шапке (например OFFICIAL COMMUNITY MERCH)',
    hero_title: 'Главный заголовок',
    hero_subtitle: 'Подзаголовок',
    notice_text: 'Плашка-объявление под каталогом',
    footer_text: 'Текст в подвале сайта',
    contact_url: 'Ссылка «Связаться» (Telegram, https://t.me/...)',
  };
}

async function showSettings(env, chatId, cq = null) {
  const labels = settingsLabels();
  const rows = Object.entries(labels).map(([key, label]) => [{ text: `✏️ ${label.split(' (')[0]}`, callback_data: `set:${key}` }]);
  rows.push([{ text: '👁 Открыть сайт', url: env.SITE_URL || 'https://dvizhso.github.io/dvizhshop' }]);
  rows.push(backBtn('menu'));
  const s = await getSettings(env);
  const text = [
    '📝 <b>Тексты сайта</b>',
    '',
    `Бейдж: ${escapeHtml(s.hero_badge || '—')}`,
    `Заголовок: ${escapeHtml((s.hero_title || '—').slice(0, 60))}`,
    `Подзаголовок: ${escapeHtml((s.hero_subtitle || '—').slice(0, 80))}`,
    `Объявление: ${escapeHtml((s.notice_text || '—').slice(0, 80))}`,
  ].join('\n');
  if (cq) return edit(env, cq, text, kb(rows));
  return reply(env, chatId, text, kb(rows));
}

async function showCollections(env, chatId, cq = null) {
  const cols = await listCollections(env);
  const products = await listProducts(env);
  const counts = new Map();
  for (const p of products) if (p.collection_id) counts.set(p.collection_id, (counts.get(p.collection_id) || 0) + 1);
  const rows = cols.map((c) => [
    { text: `${c.active ? '🟢' : '⚪'} ${c.name} (${counts.get(c.id) || 0})`, callback_data: `colt:${c.id}` },
    { text: '✏️', callback_data: `colr:${c.id}` },
    { text: '🗑', callback_data: `coldl:${c.id}` },
  ]);
  rows.push([{ text: '➕ Новая коллекция', callback_data: 'col:add' }]);
  rows.push(backBtn('menu'));
  const text = cols.length ? '🎨 <b>Коллекции</b>\nНажмите на название, чтобы скрыть/показать.' : '🎨 Коллекций пока нет.';
  if (cq) return edit(env, cq, text, kb(rows));
  return reply(env, chatId, text, kb(rows));
}

async function showOrders(env, chatId, cq = null, filter = 'all', page = 0) {
  const status = filter === 'all' ? null : filter;
  const orders = await listOrders(env, { status, limit: 100 });
  const pages = Math.max(1, Math.ceil(orders.length / 10));
  const cur = Math.min(Math.max(0, page), pages - 1);
  const slice = orders.slice(cur * 10, cur * 10 + 10);
  const rows = slice.map((o) => [{
    text: `№${orderNo(o)} · ${o.customer_name} · ${money(o.total_cents)} € · ${STATUS_LABELS[o.status] || o.status}`,
    callback_data: `o:${o.id}`,
  }]);
  if (pages > 1) {
    const nav = [];
    if (cur > 0) nav.push({ text: '‹', callback_data: `ord:${filter}:${cur - 1}` });
    nav.push({ text: `${cur + 1}/${pages}`, callback_data: 'noop' });
    if (cur < pages - 1) nav.push({ text: '›', callback_data: `ord:${filter}:${cur + 1}` });
    rows.push(nav);
  }
  rows.push([
    { text: filter === 'all' ? '• Все' : 'Все', callback_data: 'ord:all:0' },
    { text: filter === 'new' ? '• Новые' : 'Новые', callback_data: 'ord:new:0' },
    { text: filter === 'confirmed' ? '• Подтв.' : 'Подтв.', callback_data: 'ord:confirmed:0' },
  ]);
  rows.push([
    { text: filter === 'processing' ? '• В работе' : 'В работе', callback_data: 'ord:processing:0' },
    { text: filter === 'prepared' ? '• Готовы' : 'Готовы', callback_data: 'ord:prepared:0' },
    { text: filter === 'done' ? '• Выполнены' : 'Выполнены', callback_data: 'ord:done:0' },
  ]);
  rows.push([
    { text: filter === 'cancelled' ? '• Отклонены' : 'Отклонены', callback_data: 'ord:cancelled:0' },
  ]);
  rows.push(backBtn('menu'));
  const text = orders.length
    ? `🛒 <b>Заказы</b> — ${orders.length}\nФильтр: ${filter === 'all' ? 'все' : STATUS_LABELS[filter] || filter}`
    : '🛒 Заказов пока нет.';
  if (cq) return edit(env, cq, text, kb(rows));
  return reply(env, chatId, text, kb(rows));
}

function orderText(o) {
  const lines = [
    `🛒 <b>Заказ №${orderNo(o)}</b>`,
    `Статус: <b>${STATUS_LABELS[o.status] || o.status}</b>`,
    '',
    `👤 ${escapeHtml(o.customer_name)}`,
    o.contact ? `📞 ${escapeHtml(o.contact)}` : '📞 контакт не указан',
    o.delivery ? `📍 ${DELIVERY_LABELS[o.delivery] || escapeHtml(o.delivery)}` : '',
    o.tg_chat_id ? `🔔 Покупатель подписан на статус${o.tg_username ? ` (@${escapeHtml(o.tg_username)})` : ''}` : '',
    o.note ? `💬 ${escapeHtml(o.note)}` : '',
    '',
    ...o.items.map((i) => `• ${escapeHtml(i.name)}${i.size ? ` / ${escapeHtml(i.size)}` : ''}${i.color ? ` / ${escapeHtml(i.color)}` : ''} × ${i.qty} — ${money(i.price_cents * i.qty)} €`),
    '',
    `<b>Итого: ${money(o.total_cents)} €</b>`,
    `<i>${escapeHtml(formatOrderTime(o.created_at))}</i>`,
  ];
  return lines.filter((x) => x !== '').join('\n');
}

async function showOrder(env, chatId, id, cq = null) {
  const order = await getOrder(env, id);
  if (!order) return cq ? edit(env, cq, 'Заказ не найден', kb([backBtn('ord:all:0')])) : reply(env, chatId, 'Заказ не найден');
  const buttons = [
    [{ text: '☑ Принять', callback_data: `ost:${id}:confirmed` }, { text: '❌ Отклонить', callback_data: `ost:${id}:cancelled` }],
    [{ text: '⚙️ В обработке', callback_data: `ost:${id}:processing` }, { text: '📦 Подготовлен', callback_data: `ost:${id}:prepared` }],
    [{ text: '🏁 Выполнен', callback_data: `ost:${id}:done` }, { text: '🆕 Новая', callback_data: `ost:${id}:new` }],
    backBtn('ord:all:0', '← К заказам'),
  ];
  if (cq) return edit(env, cq, orderText(order), kb(buttons));
  return reply(env, chatId, orderText(order), kb(buttons));
}

function parsePriceToCents(value) {
  const clean = String(value || '').replace(',', '.').replace(/[^\d.]/g, '');
  const number = Number(clean);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.max(1, Math.round(number * 100));
}

async function handlePhoto(env, message, session) {
  if (!session || session.kind !== 'photo') return;
  const photos = Array.isArray(message.photo) ? message.photo : [];
  if (!photos.length) return;
  // Хранилище необязательно. Без биндинга BUCKET бот не падает: фото просто
  // не сохраняются, а остальной функционал продолжает работать.
  if (!env.BUCKET) {
    await reply(env, message.chat.id,
      '⚠️ Хранение фото не подключено. Товар создан без фото; остальные функции работают.');
    return;
  }
  const best = photos[photos.length - 1];
  try {
    const file = await tg(env, 'getFile', { file_id: best.file_id });
    if (!file?.file_path) throw new Error('Telegram не вернул file_path');
    const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
    if (!res.ok) throw new Error('Не удалось скачать фото');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > 6 * 1024 * 1024) throw new Error('Фото больше 6 МБ');
    const ext = /\.(png|webp|jpg|jpeg)$/i.exec(file.file_path)?.[0]?.toLowerCase() || '.jpg';
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    const key = `uploads/p-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext === '.jpeg' ? '.jpg' : ext}`;
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
    const photo = await addProductPhoto(env, session.productId, key);
    await reply(env, message.chat.id,
      `✅ Фото добавлено (#${photo.id}). Отправьте ещё или нажмите «Готово».`,
      kb([[{ text: 'Готово', callback_data: `p:${session.productId}` }]]));
  } catch (error) {
    await reply(env, message.chat.id, `❌ ${escapeHtml(error.message)}`);
  }
}

async function finishWizard(env, chatId, session) {
  const d = session.data || {};
  const product = await createProduct(env, {
    name: d.name,
    price_cents: d.price_cents,
    description: d.description || '',
    sizes: d.sizes || 'S,M,L,XL',
    colors: d.colors || 'Чёрный',
    stock: d.stock || 0,
    active: true,
  });
  await clearSession(env, chatId);
  await reply(env, chatId, `✅ Товар создан и уже на сайте!\n\n${productText(product)}`, productKeyboard(product));
  await setSession(env, chatId, { kind: 'photo', productId: product.id });
  return reply(env, chatId, '🖼 Отправьте фото товара (можно несколько подряд).\n/готово — завершить.',
    kb([[{ text: 'Готово', callback_data: `p:${product.id}` }]]));
}

async function handleMessage(env, message) {
  const chatId = message.chat.id;
  const text = String(message.text || '').trim();
  const session = await getSession(env, chatId);

  if (text === '/cancel') {
    await clearSession(env, chatId);
    return reply(env, chatId, 'Отменено.', kb([backBtn('menu')]));
  }
  if (text === '/start') {
    await clearSession(env, chatId);
    return showMenu(env, chatId, null, true);
  }
  if (!session) {
    return reply(env, chatId, 'Выберите действие в меню:', kb([
      [{ text: '🏠 Меню', callback_data: 'menu' }],
      [{ text: '🛒 Новые заказы', callback_data: 'ord:new:0' }],
    ]));
  }

  if (session.kind === 'photo') {
    if (text === '/готово') {
      await clearSession(env, chatId);
      return showProduct(env, chatId, session.productId);
    }
    return reply(env, chatId, 'Отправьте фото или /готово.');
  }

  if (session.kind === 'wizard') {
    const step = session.step;
    if (step === 'name') {
      if (text.length < 2) return reply(env, chatId, 'Название слишком короткое. Введите ещё раз:');
      session.data = { ...session.data, name: text.slice(0, 120) };
    } else if (step === 'price') {
      const cents = parsePriceToCents(text);
      if (!cents) return reply(env, chatId, 'Не понял цену. Введите например 49.90:');
      session.data = { ...session.data, price_cents: cents };
    } else if (step === 'desc') {
      session.data = { ...session.data, description: text === '/skip' ? '' : text.slice(0, 2000) };
    } else if (step === 'sizes') {
      session.data = { ...session.data, sizes: text === '/skip' ? 'S,M,L,XL' : text.slice(0, 120) };
    } else if (step === 'colors') {
      session.data = { ...session.data, colors: text === '/skip' ? 'Чёрный' : text.slice(0, 120) };
    } else if (step === 'stock') {
      const stock = Math.max(0, Math.min(9999, Number(text) || 0));
      session.data = { ...session.data, stock };
      return finishWizard(env, chatId, session);
    }
    const order = ['name', 'price', 'desc', 'sizes', 'colors', 'stock'];
    session.step = order[order.indexOf(step) + 1];
    await setSession(env, chatId, session);
    return reply(env, chatId, `${WIZARD[session.step].prompt}\n\n/cancel — отменить`);
  }

  if (session.kind === 'field') {
    const product = await getProduct(env, session.productId);
    if (!product) {
      await clearSession(env, chatId);
      return showMenu(env, chatId);
    }
    const fields = {};
    if (session.field === 'name') {
      if (text.length < 2) return reply(env, chatId, 'Слишком короткое название. Ещё раз:');
      fields.name = text.slice(0, 120);
    } else if (session.field === 'price') {
      const cents = parsePriceToCents(text);
      if (!cents) return reply(env, chatId, 'Не понял цену. Введите например 49.90:');
      fields.price_cents = cents;
      fields.old_price_cents = null;
    } else if (session.field === 'desc') {
      fields.description = text === '/skip' ? '' : text.slice(0, 2000);
    } else if (session.field === 'sizes') {
      fields.sizes = text.slice(0, 120);
    } else if (session.field === 'colors') {
      fields.colors = text.slice(0, 120);
    } else if (session.field === 'stock') {
      fields.stock = Math.max(0, Math.min(9999, Number(text) || 0));
    }
    await clearSession(env, chatId);
    const updated = await updateProduct(env, product.id, fields);
    return reply(env, chatId, productText(updated), productKeyboard(updated));
  }

  if (session.kind === 'coladd') {
    const collection = await createCollection(env, { name: text });
    await clearSession(env, chatId);
    await reply(env, chatId, `✅ Коллекция «${escapeHtml(collection.name)}» создана.`);
    return showCollections(env, chatId);
  }
  if (session.kind === 'colrename') {
    await updateCollection(env, session.id, { name: text });
    await clearSession(env, chatId);
    return showCollections(env, chatId);
  }
  if (session.kind === 'setval') {
    await setSetting(env, session.key, text === '/skip' ? '' : text.slice(0, 1000));
    await clearSession(env, chatId);
    return showSettings(env, chatId);
  }

  await clearSession(env, chatId);
  return showMenu(env, chatId);
}

async function handleCallback(env, cq) {
  const chatId = cq.message.chat.id;
  const data = String(cq.data || '');
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});

  if (data === 'noop') return;
  if (data === 'menu') { await clearSession(env, chatId); return showMenu(env, chatId, cq); }

  if (data === 'p:list:0' || data.startsWith('p:list:')) {
    await clearSession(env, chatId);
    return showProducts(env, chatId, Number(data.split(':')[2]) || 0, cq);
  }
  if (data === 'p:add') {
    await setSession(env, chatId, { kind: 'wizard', step: 'name', data: {} });
    return edit(env, cq, `➕ <b>Новый товар</b>\n\n${WIZARD.name.prompt}\n\n/cancel — отменить`,
      kb([[{ text: '✖️ Отмена', callback_data: 'menu' }]]));
  }
  if (/^p:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    await clearSession(env, chatId);
    return showProduct(env, chatId, id, cq);
  }
  if (/^pe:\d+:(name|price|desc|sizes|colors|stock)$/.test(data)) {
    const [, id, field] = data.split(':');
    const product = await getProduct(env, id);
    if (!product) return edit(env, cq, 'Товар не найден', kb([backBtn('p:list:0')]));
    await setSession(env, chatId, { kind: 'field', productId: Number(id), field });
    return edit(env, cq, `✏️ <b>${escapeHtml(product.name)}</b>\n\n${FIELD_PROMPTS[field]}\n\n/cancel — отмена`,
      kb([backBtn(`p:${id}`, '← Назад')]));
  }
  if (/^pt:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const product = await getProduct(env, id);
    const updated = await updateProduct(env, id, { active: !product.active });
    return edit(env, cq, productText(updated), productKeyboard(updated));
  }
  if (/^pdl:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const product = await getProduct(env, id);
    if (!product) return edit(env, cq, 'Товар не найден', kb([backBtn('p:list:0')]));
    return edit(env, cq, `🗑 Удалить товар <b>${escapeHtml(product.name)}</b>?\nОн исчезнет с сайта и из каталога.`, kb([
      [{ text: 'Да, удалить', callback_data: `pdly:${id}` }],
      [{ text: 'Отмена', callback_data: `p:${id}` }],
    ]));
  }
  if (/^pdly:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const product = await getProduct(env, id);
    if (product && env.BUCKET) {
      for (const photo of product.photos || []) {
        try { await env.BUCKET.delete(String(photo.path).replace(/^\/+/, '')); } catch { /* нет */ }
      }
    }
    await deleteProduct(env, id);
    await clearSession(env, chatId);
    return showProducts(env, chatId, 0, cq);
  }
  if (/^pcol:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const product = await getProduct(env, id);
    if (!product) return edit(env, cq, 'Товар не найден', kb([backBtn('p:list:0')]));
    const collections = await listCollections(env);
    const rows = collections.map((c) => [{
      text: `${product.collection_id === c.id ? '● ' : '○ '}${c.name}`,
      callback_data: `setcol:${id}:${c.id}`,
    }]);
    rows.push([{ text: 'Без коллекции', callback_data: `setcol:${id}:0` }]);
    rows.push([{ text: '← К товару', callback_data: `p:${id}` }]);
    return edit(env, cq, `🎨 <b>Коллекция товара «${escapeHtml(product.name)}»</b>\nСейчас: ${product.collection_name ? escapeHtml(product.collection_name) : '—'}\n\nВыберите коллекцию:`, kb(rows));
  }
  if (/^setcol:\d+:-?\d+$/.test(data)) {
    const [, pid, col] = data.split(':');
    const updated = await updateProduct(env, pid, { collection_id: Number(col) > 0 ? Number(col) : null });
    return edit(env, cq, productText(updated), productKeyboard(updated));
  }
  if (/^disc:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    return edit(env, cq, '🏷 <b>Скидка</b>\nВыберите процент — цена пересчитается, старая цена сохранится зачёркнутой.', kb([
      [{ text: '−10%', callback_data: `disc:${id}:10` }, { text: '−15%', callback_data: `disc:${id}:15` }],
      [{ text: '−20%', callback_data: `disc:${id}:20` }, { text: '−25%', callback_data: `disc:${id}:25` }],
      [{ text: '↩️ Сбросить скидку', callback_data: `disc:${id}:0` }],
      [{ text: '✏️ Цена вручную', callback_data: `pe:${id}:price` }],
      backBtn(`p:${id}`, '← Назад'),
    ]));
  }
  if (/^disc:\d+:\d+$/.test(data)) {
    const [, ids, pcts] = data.split(':');
    const id = Number(ids); const pct = Number(pcts);
    const product = await getProduct(env, id);
    if (!product) return edit(env, cq, 'Товар не найден', kb([backBtn('p:list:0')]));
    let updated;
    if (!pct) {
      updated = await updateProduct(env, id, { price_cents: product.old_price_cents || product.price_cents, old_price_cents: null });
    } else {
      const base = product.old_price_cents || product.price_cents;
      updated = await updateProduct(env, id, { old_price_cents: base, price_cents: Math.max(1, Math.round(base * (1 - pct / 100))) });
    }
    return edit(env, cq, productText(updated), productKeyboard(updated));
  }
  if (/^pp:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const product = await getProduct(env, id);
    if (!product) return edit(env, cq, 'Товар не найден', kb([backBtn('p:list:0')]));
    await setSession(env, chatId, { kind: 'photo', productId: id });
    const rows = (product.photos || []).map((photo) => [{ text: `🗑 Удалить фото #${photo.id}`, callback_data: `dph:${photo.id}:${id}` }]);
    rows.push([{ text: '← К товару', callback_data: `p:${id}` }]);
    return edit(env, cq, `🖼 <b>Фото товара «${escapeHtml(product.name)}»</b>\n\nОтправьте новые фото (можно несколько подряд).\n/готово — завершить.`, kb(rows));
  }
  if (/^dph:\d+:\d+$/.test(data)) {
    const [, phId, prodId] = data.split(':');
    const photo = await getPhoto(env, phId);
    if (photo) {
      if (env.BUCKET) { try { await env.BUCKET.delete(String(photo.path).replace(/^\/+/, '')); } catch { /* нет */ } }
      await deletePhoto(env, phId);
    }
    const product = await getProduct(env, prodId);
    const rows = (product.photos || []).map((photo) => [{ text: `🗑 Удалить фото #${photo.id}`, callback_data: `dph:${photo.id}:${prodId}` }]);
    rows.push([{ text: '← К товару', callback_data: `p:${prodId}` }]);
    return edit(env, cq, `🖼 Фото товара «${escapeHtml(product.name)}» — ${(product.photos || []).length} шт.\n\nОтправьте новые фото или удалите существующие.`, kb(rows));
  }

  if (data === 'col:list') return showCollections(env, chatId, cq);
  if (data === 'col:add') {
    await setSession(env, chatId, { kind: 'coladd' });
    return edit(env, cq, '🎨 <b>Новая коллекция</b>\n\nВведите название (например: Winter Drop 2026):', kb([backBtn('col:list', '← Назад')]));
  }
  if (/^colr:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    await setSession(env, chatId, { kind: 'colrename', id });
    return edit(env, cq, 'Введите новое название коллекции:', kb([backBtn('col:list', '← Назад')]));
  }
  if (/^colt:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const collection = await getCollection(env, id);
    await updateCollection(env, id, { active: !collection.active });
    return showCollections(env, chatId, cq);
  }
  if (/^coldl:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const collection = await getCollection(env, id);
    if (!collection) return showCollections(env, chatId, cq);
    return edit(env, cq, `Удалить коллекцию «${escapeHtml(collection.name)}»?\nТовары останутся, но без коллекции.`, kb([
      [{ text: 'Да, удалить', callback_data: `coldly:${id}` }],
      [{ text: 'Отмена', callback_data: 'col:list' }],
    ]));
  }
  if (/^coldly:\d+$/.test(data)) {
    await deleteCollection(env, Number(data.split(':')[1]));
    return showCollections(env, chatId, cq);
  }

  if (data === 'set:list') return showSettings(env, chatId, cq);
  if (data.startsWith('set:')) {
    const key = data.split(':')[1];
    const labels = settingsLabels();
    if (!labels[key]) return showSettings(env, chatId, cq);
    await setSession(env, chatId, { kind: 'setval', key });
    const current = await getSetting(env, key);
    return edit(env, cq, `📝 <b>${escapeHtml(labels[key])}</b>\n\nТекущее значение:\n<i>${escapeHtml(current || '—')}</i>\n\nОтправьте новое значение (или /skip — очистить):`, kb([backBtn('set:list', '← Назад')]));
  }

  if (data.startsWith('ord:')) {
    const [, filter, page] = data.split(':');
    return showOrders(env, chatId, cq, filter, Number(page) || 0);
  }
  if (/^o:\d+$/.test(data)) return showOrder(env, chatId, Number(data.split(':')[1]), cq);
  if (/^ost:\d+:(new|confirmed|processing|prepared|shipped|done|cancelled)$/.test(data)) {
    const [, id, status] = data.split(':');
    try {
      const order = await setOrderStatus(env, id, status);
      await notifyBuyerStatus(env, order);
      return showOrder(env, chatId, order.id, cq);
    } catch (error) {
      return edit(env, cq, `❌ ${escapeHtml(error.message)}`, kb([backBtn('ord:all:0')]));
    }
  }

  return showMenu(env, chatId, cq);
}

// Покупатель запускает бота по ссылке https://t.me/<bot>?start=<public_id>.
// Показываем только номер и статус его заказа — без чужих данных.
async function handleBuyerStart(env, message, payload) {
  const chatId = message.chat.id;
  const key = String(payload || '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(key)) {
    return reply(env, chatId, [
      '🛍 Это бот магазина DVIZH FREIBURG.',
      '',
      'Чтобы получать статус заказа, оформи заказ на сайте и нажми',
      '«Получать статус в Telegram» на экране подтверждения.',
    ].join('\n'), kb([[{ text: '🛍 Открыть магазин', url: env.SITE_URL || 'https://dvizhso.github.io/dvizhshop' }]]));
  }
  const order = await getOrderByPublicId(env, key);
  if (!order) return reply(env, chatId, 'Заказ не найден или ссылка устарела.');
  await linkOrderChat(env, order.id, message.chat.id, message.from?.username || '');
  return reply(env, chatId, [
    `✅ Готово! Ты подписан на статус заказа №${orderNo(order)}.`,
    `Текущий статус: <b>${STATUS_LABELS[order.status] || order.status}</b>`,
    '',
    'Мы пришлём сообщение, когда статус изменится.',
  ].join('\n'));
}

export async function handleUpdate(env, update) {
  await ensureSchema(env);
  const message = update.message || update.callback_query?.message;
  if (!message) return;
  const from = update.callback_query?.from || update.message?.from;
  if (!from) return;
  const chatId = message.chat.id;

  const adminId = await currentAdmin(env);
  if (!adminId) {
    console.error('[bot] ADMIN_ID не задан — бот отключён');
    return reply(env, chatId, '⛔ Бот не настроен: администратор не задан.').catch(() => {});
  }

  if (String(from.id) !== adminId) {
    // Не владелец. Единственное разрешённое действие — подписка на статус
    // своего заказа по ссылке из оформления. Меню и заказы недоступны.
    const text = String(update.message?.text || '').trim();
    if (!update.callback_query && /^\/start(\s|$)/i.test(text)) {
      return handleBuyerStart(env, update.message, text.split(/\s+/).slice(1).join(' ')).catch(() => {});
    }
    return reply(env, chatId, '🛍 Это бот магазина DVIZH FREIBURG. Оформить заказ можно на сайте.',
      kb([[{ text: '🛍 Открыть магазин', url: env.SITE_URL || 'https://dvizhso.github.io/dvizhshop' }]])).catch(() => {});
  }

  if (update.callback_query) return handleCallback(env, update.callback_query);
  if (update.message?.photo) {
    const session = await getSession(env, chatId);
    return handlePhoto(env, update.message, session);
  }
  if (update.message?.text) return handleMessage(env, update.message);
}

export async function setWebhook(env, workerUrl, secret) {
  return tg(env, 'setWebhook', {
    url: `${String(workerUrl).replace(/\/+$/, '')}/telegram/webhook`,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
}
