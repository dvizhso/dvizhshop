// DVIZH FREIBURG — Telegram ADMIN BOT.
// Полное управление магазином: товары, фото, цены/скидки, коллекции, баннеры,
// тексты сайта, склады и заказы. Работает с той же SQLite-базой, что и сайт.
import {
  loadEnv, log, escapeHtml, money, parsePriceToCents, normList,
} from './lib/core.mjs';
import * as db from './lib/db.mjs';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  botTokenPresent, getMe, getUpdates, sendMessage, editMessageText, editMessageReplyMarkup,
  answerCallbackQuery, deleteMessage, downloadFile,
} from './lib/telegram.mjs';

loadEnv();

const PAGE = 8;
const QUIET_START = process.env.QUIET_START === '1';

// chatId -> незавершённое действие (мастер/ввод поля)
const pending = new Map();

function currentAdminId() {
  const env = Number(process.env.ADMIN_ID);
  if (Number.isFinite(env) && env > 0) return env;
  const stored = Number(db.getSetting('admin_id'));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

const kb = (rows) => ({ inline_keyboard: rows });
const backBtn = (target = 'menu', label = '← В меню') => [{ text: label, callback_data: target }];

async function reply(chatId, text, markup) {
  return sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
}

async function edit(cq, text, markup) {
  try {
    await editMessageText({ chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: String(text).slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
  } catch (e) {
    if (!/not modified/i.test(String(e.message))) throw e;
  }
}

function productText(p) {
  const lines = [
    `${p.active ? '🟢' : '⚪'} <b>${escapeHtml(p.name)}</b>  <code>#${p.id}</code>`,
    `Цена: <b>${money(p.price_cents)} €</b>${p.old_price_cents ? `  <s>${money(p.old_price_cents)} €</s>` : ''}`,
    p.collection_name ? `Коллекция: ${escapeHtml(p.collection_name)}` : 'Коллекция: —',
    `Размеры: ${escapeHtml(p.sizes || '—')}`,
    `Цвета: ${escapeHtml(p.colors || '—')}`,
    `Склад: <b>${p.stock} шт.</b>${p.stock <= 0 ? '  ❗ нет в наличии' : p.stock <= 2 ? '  ⚠️ мало' : ''}`,
    `Фото: ${(p.photos || []).length} шт.`,
    '',
    p.description ? escapeHtml(p.description).slice(0, 700) : '<i>без описания</i>',
  ];
  return lines.join('\n');
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

async function showProduct(chatId, id, cq = null) {
  const p = db.getProduct(id);
  if (!p) return cq ? edit(cq, 'Товар не найден', kb([backBtn('p:list:0')])) : reply(chatId, 'Товар не найден');
  if (cq) return edit(cq, productText(p), productKeyboard(p));
  return reply(chatId, productText(p), productKeyboard(p));
}

function productsListKeyboard(page = 0) {
  const all = db.listProducts();
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
  return kb(rows);
}

async function showProducts(chatId, page = 0, cq = null) {
  const all = db.listProducts();
  const text = all.length
    ? `📦 <b>Товары</b> — ${all.length} шт.\nВыберите товар для управления:`
    : '📦 Товаров пока нет. Добавьте первый!';
  if (cq) return edit(cq, text, productsListKeyboard(page));
  return reply(chatId, text, productsListKeyboard(page));
}

async function showMenu(chatId, cq = null, hello = false) {
  const s = db.stats();
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
    [{ text: '🎨 Коллекции', callback_data: 'col:list' }, { text: '🖼 Баннеры', callback_data: 'ban:list' }],
    [{ text: '📝 Тексты сайта', callback_data: 'set:list' }, { text: '🛒 Заказы', callback_data: 'ord:all:0' }],
  ]);
  if (cq) return edit(cq, text, markup);
  return reply(chatId, text, markup);
}

// --- мастера ---------------------------------------------------------------
const WIZARD_STEPS = {
  name: { prompt: '1/7 · Название товара?\nНапример: Худи DVIZH Classic', field: 'name' },
  price: { prompt: '2/7 · Цена в €?\nНапример: 55 или 55.50', field: 'price' },
  desc: { prompt: '3/7 · Описание товара?\n(/skip — без описания)', field: 'description' },
  sizes: { prompt: '4/7 · Размеры через запятую?\nНапример: S,M,L,XL\n(/skip — S,M,L,XL)', field: 'sizes' },
  colors: { prompt: '5/7 · Цвета через запятую?\nНапример: Чёрный,Белый\n(/skip — Чёрный)', field: 'colors' },
  stock: { prompt: '6/7 · Сколько штук на складе?\nНапример: 10', field: 'stock' },
};

function wizardPrompt(step) {
  return WIZARD_STEPS[step]?.prompt || 'Продолжаем…';
}

async function startWizard(chatId) {
  pending.set(chatId, { kind: 'wizard', step: 'name', data: {} });
  return reply(chatId, `➕ <b>Новый товар</b>\n\n${wizardPrompt('name')}\n\n/cancel — отменить`, kb([[{ text: '✖️ Отмена', callback_data: 'menu' }]]));
}

async function afterWizardField(chatId, p) {
  const order = ['name', 'price', 'desc', 'sizes', 'colors', 'stock'];
  if (p.step === 'collection') {
    return showWizardCollections(chatId);
  }
  const idx = order.indexOf(p.step) + 1;
  if (idx >= order.length) {
    p.step = 'collection';
    return showWizardCollections(chatId);
  }
  p.step = order[idx];
  return reply(chatId, wizardPrompt(p.step) + '\n\n/cancel — отменить');
}

async function showWizardCollections(chatId) {
  const cols = db.listCollections();
  const rows = cols.map((c) => [{ text: c.name, callback_data: `awcol:${c.id}` }]);
  rows.push([{ text: 'Без коллекции', callback_data: 'awcol:-1' }]);
  rows.push([{ text: '✖️ Отмена', callback_data: 'menu' }]);
  return reply(chatId, '7/7 · Коллекция? Выберите кнопкой:', kb(rows));
}

async function finishWizard(chatId) {
  const p = pending.get(chatId);
  if (!p || p.kind !== 'wizard') return;
  pending.delete(chatId);
  const d = p.data;
  try {
    const product = db.createProduct({
      name: d.name,
      price_cents: d.price_cents,
      description: d.description || '',
      sizes: d.sizes || 'S,M,L,XL',
      colors: d.colors || 'Чёрный',
      stock: d.stock || 0,
      collection_id: d.collection_id || null,
      active: true,
    });
    await reply(chatId, `✅ Товар создан и уже на сайте!\n\n${productText(product)}`, productKeyboard(product));
    pending.set(chatId, { kind: 'photo', productId: product.id });
    return reply(chatId, '🖼 Отправьте фото товара (можно несколько подряд).\n/готово — завершить.', kb([[{ text: 'Готово', callback_data: `p:${product.id}` }]]));
  } catch (e) {
    log('wizard', `create failed: ${e.message}`);
    return reply(chatId, `❌ Не удалось создать товар: ${escapeHtml(e.message)}`, kb([[{ text: 'Попробовать снова', callback_data: 'p:add' }], backBtn('menu')]));
  }
}

const FIELD_PROMPTS = {
  name: 'Введите новое название:',
  price: 'Введите новую цену в € (например 49.90):',
  desc: 'Введите новое описание (до 2000 символов). /skip — очистить:',
  sizes: 'Введите размеры через запятую (например S,M,L,XL):',
  colors: 'Введите цвета через запятую (например Чёрный,Белый):',
  stock: 'Введите количество на складе (целое число):',
};

// --- обработчики callback ---------------------------------------------------
async function onCallback(cq) {
  const chatId = cq.message.chat.id;
  const data = String(cq.data || '');
  await answerCallbackQuery({ callback_query_id: cq.id }).catch(() => {});

  if (data === 'noop') return;
  if (data === 'menu') { pending.delete(chatId); return showMenu(chatId, cq); }

  // товары
  if (data === 'p:list:0' || data.startsWith('p:list:')) {
    pending.delete(chatId);
    return showProducts(chatId, Number(data.split(':')[2]) || 0, cq);
  }
  if (data === 'p:add') {
    pending.delete(chatId);
    return startWizard(chatId);
  }
  if (/^p:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    pending.delete(chatId);
    return showProduct(chatId, id, cq);
  }
  if (/^pe:\d+:(name|price|desc|sizes|colors|stock)$/.test(data)) {
    const [, id, field] = data.split(':');
    const p = db.getProduct(id);
    if (!p) return edit(cq, 'Товар не найден', kb([backBtn('p:list:0')]));
    pending.set(chatId, { kind: 'field', productId: Number(id), field });
    return edit(cq, `✏️ <b>${escapeHtml(p.name)}</b>\n\n${FIELD_PROMPTS[field]}\n\n/cancel — отмена`, kb([backBtn(`p:${id}`, '← Назад')]));
  }
  if (/^pt:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const p = db.getProduct(id);
    const updated = db.updateProduct(id, { active: !p.active });
    return edit(cq, productText(updated), productKeyboard(updated));
  }
  if (/^pdl:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const p = db.getProduct(id);
    if (!p) return edit(cq, 'Товар не найден', kb([backBtn('p:list:0')]));
    return edit(cq, `🗑 Удалить товар <b>${escapeHtml(p.name)}</b>?\nОн исчезнет с сайта и из каталога.`, kb([
      [{ text: 'Да, удалить', callback_data: `pdly:${id}` }],
      [{ text: 'Отмена', callback_data: `p:${id}` }],
    ]));
  }
  if (/^pdly:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const p = db.getProduct(id);
    for (const ph of p?.photos || []) {
      try { unlinkSync(db.photoAbsolutePath(ph.path)); } catch { /* файла нет */ }
    }
    db.deleteProduct(id);
    pending.delete(chatId);
    return showProducts(chatId, 0, cq);
  }
  if (/^pcol:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const p = db.getProduct(id);
    if (!p) return edit(cq, 'Товар не найден', kb([backBtn('p:list:0')]));
    pending.delete(chatId);
    const rows = db.listCollections().map((c) => [{
      text: `${p.collection_id === c.id ? '● ' : '○ '}${c.name}`,
      callback_data: `setcol:${id}:${c.id}`,
    }]);
    rows.push([{ text: 'Без коллекции', callback_data: `setcol:${id}:0` }]);
    rows.push([{ text: '← К товару', callback_data: `p:${id}` }]);
    return edit(cq, `🎨 <b>Коллекция товара «${escapeHtml(p.name)}»</b>\nСейчас: ${p.collection_name ? escapeHtml(p.collection_name) : '—'}\n\nВыберите коллекцию:`, kb(rows));
  }
  if (/^disc:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    return edit(cq, '🏷 <b>Скидка</b>\nВыберите процент — цена пересчитается, старая цена сохранится зачёркнутой.', kb([
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
    const p = db.getProduct(id);
    if (!p) return edit(cq, 'Товар не найден', kb([backBtn('p:list:0')]));
    let updated;
    if (!pct) {
      updated = db.updateProduct(id, { price_cents: p.old_price_cents || p.price_cents, old_price_cents: null });
    } else {
      const base = p.old_price_cents || p.price_cents;
      updated = db.updateProduct(id, { old_price_cents: base, price_cents: Math.max(1, Math.round(base * (1 - pct / 100))) });
    }
    return edit(cq, productText(updated), productKeyboard(updated));
  }
  if (/^pp:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const p = db.getProduct(id);
    if (!p) return edit(cq, 'Товар не найден', kb([backBtn('p:list:0')]));
    pending.set(chatId, { kind: 'photo', productId: id });
    const rows = (p.photos || []).map((ph) => [{ text: `🗑 Удалить фото #${ph.id}`, callback_data: `dph:${ph.id}:${id}` }]);
    rows.push([{ text: '← К товару', callback_data: `p:${id}` }]);
    return edit(cq, `🖼 <b>Фото товара «${escapeHtml(p.name)}»</b>\n\nОтправьте новые фото (можно несколько подряд).\n/готово — завершить.`, kb(rows));
  }
  if (/^dph:\d+:\d+$/.test(data)) {
    const [, phId, prodId] = data.split(':');
    const ph = db.getPhoto(phId);
    if (ph) {
      try { unlinkSync(db.photoAbsolutePath(ph.path)); } catch { /* файла нет */ }
      db.deletePhoto(phId);
    }
    const p = db.getProduct(prodId);
    const rows = (p.photos || []).map((x) => [{ text: `🗑 Удалить фото #${x.id}`, callback_data: `dph:${x.id}:${prodId}` }]);
    rows.push([{ text: '← К товару', callback_data: `p:${prodId}` }]);
    return edit(cq, `🖼 Фото товара «${escapeHtml(p.name)}» — ${(p.photos || []).length} шт.\n\nОтправьте новые фото или удалите существующие.`, kb(rows));
  }
  if (data.startsWith('awcol:')) {
    const p = pending.get(chatId);
    if (!p || p.kind !== 'wizard') return edit(cq, 'Мастер устарел — начните заново.', kb([[{ text: '➕ Добавить товар', callback_data: 'p:add' }]]));
    const colId = Number(data.split(':')[1]);
    p.data.collection_id = colId > 0 ? colId : null;
    return finishWizard(chatId);
  }
  if (/^setcol:\d+:-?\d+$/.test(data)) {
    const [, pid, col] = data.split(':');
    const updated = db.updateProduct(pid, { collection_id: Number(col) > 0 ? Number(col) : null });
    return edit(cq, productText(updated), productKeyboard(updated));
  }

  // коллекции
  if (data === 'col:list') return showCollections(chatId, cq);
  if (data === 'col:add') {
    pending.set(chatId, { kind: 'coladd' });
    return edit(cq, '🎨 <b>Новая коллекция</b>\n\nВведите название (например: Winter Drop 2026):', kb([backBtn('col:list', '← Назад')]));
  }
  if (/^colr:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    pending.set(chatId, { kind: 'colrename', id });
    return edit(cq, 'Введите новое название коллекции:', kb([backBtn('col:list', '← Назад')]));
  }
  if (/^colt:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const c = db.getCollection(id);
    db.updateCollection(id, { active: !c.active });
    return showCollections(chatId, cq);
  }
  if (/^coldl:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const c = db.getCollection(id);
    if (!c) return showCollections(chatId, cq);
    return edit(cq, `Удалить коллекцию «${escapeHtml(c.name)}»?\nТовары останутся, но без коллекции.`, kb([
      [{ text: 'Да, удалить', callback_data: `coldly:${id}` }],
      [{ text: 'Отмена', callback_data: 'col:list' }],
    ]));
  }
  if (/^coldly:\d+$/.test(data)) {
    db.deleteCollection(Number(data.split(':')[1]));
    return showCollections(chatId, cq);
  }

  // баннеры
  if (data === 'ban:list') return showBanners(chatId, cq);
  if (data === 'ban:add') {
    pending.set(chatId, { kind: 'banadd', step: 'title', data: {} });
    return edit(cq, '🖼 <b>Новый баннер</b>\n\nЗаголовок (например: WINTER DROP):\n/cancel — отмена', kb([backBtn('ban:list', '← Назад')]));
  }
  if (/^bant:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const b = db.getBanner(id);
    db.updateBanner(id, { active: !b.active });
    return showBanners(chatId, cq);
  }
  if (/^banimg:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    pending.set(chatId, { kind: 'bannerphoto', id });
    return edit(cq, 'Отправьте фото баннера одним сообщением:', kb([backBtn('ban:list', '← Назад')]));
  }
  if (/^bane:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const b = db.getBanner(id);
    if (!b) return showBanners(chatId, cq);
    pending.set(chatId, { kind: 'banedit', id, step: 'title', data: {} });
    return edit(cq, `✏️ <b>Редактирование баннера</b>\n\nЗаголовок сейчас:\n<i>${escapeHtml(b.title || '—')}</i>\n\nОтправьте новый заголовок (или /skip — оставить):`, kb([backBtn('ban:list', '← Назад')]));
  }
  if (/^bandl:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const b = db.getBanner(id);
    if (!b) return showBanners(chatId, cq);
    return edit(cq, `Удалить баннер «${escapeHtml(b.title || 'без названия')}»?`, kb([
      [{ text: 'Да, удалить', callback_data: `bandly:${id}` }],
      [{ text: 'Отмена', callback_data: 'ban:list' }],
    ]));
  }
  if (/^bandly:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    const b = db.getBanner(id);
    if (b?.image_path) {
      try { unlinkSync(db.photoAbsolutePath(b.image_path)); } catch { /* файла нет */ }
    }
    db.deleteBanner(id);
    return showBanners(chatId, cq);
  }

  // тексты сайта
  if (data === 'set:list') return showSettings(chatId, cq);
  if (data.startsWith('set:')) {
    const key = data.split(':')[1];
    const labels = settingsLabels();
    if (!labels[key]) return showSettings(chatId, cq);
    pending.set(chatId, { kind: 'setval', key });
    const cur = db.getSetting(key);
    return edit(cq, `📝 <b>${escapeHtml(labels[key])}</b>\n\nТекущее значение:\n<i>${escapeHtml(cur || '—')}</i>\n\nОтправьте новое значение (или /skip — очистить):`, kb([backBtn('set:list', '← Назад')]));
  }

  // заказы
  if (data.startsWith('ord:')) {
    const [, filt, pageStr] = data.split(':');
    return showOrders(chatId, cq, filt, Number(pageStr) || 0);
  }
  if (/^o:\d+$/.test(data)) {
    const id = Number(data.split(':')[1]);
    return showOrder(chatId, cq, id);
  }
  if (/^ost:\d+:(new|confirmed|processing|prepared|shipped|done|cancelled)$/.test(data)) {
    const [, id, status] = data.split(':');
    try {
      const o = db.setOrderStatus(id, status);
      return showOrder(chatId, cq, o.id);
    } catch (e) {
      return edit(cq, `❌ ${escapeHtml(e.message)}`, kb([backBtn('ord:all:0')]));
    }
  }

  return showMenu(chatId, cq);
}

// --- справочники -----------------------------------------------------------
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

async function showCollections(chatId, cq = null) {
  const cols = db.listCollections();
  const counts = new Map();
  for (const p of db.listProducts()) {
    if (p.collection_id) counts.set(p.collection_id, (counts.get(p.collection_id) || 0) + 1);
  }
  const rows = cols.map((c) => [
    { text: `${c.active ? '🟢' : '⚪'} ${c.name} (${counts.get(c.id) || 0})`, callback_data: `colt:${c.id}` },
    { text: '✏️', callback_data: `colr:${c.id}` },
    { text: '🗑', callback_data: `coldl:${c.id}` },
  ]);
  rows.push([{ text: '➕ Новая коллекция', callback_data: 'col:add' }]);
  rows.push(backBtn('menu'));
  const text = cols.length ? '🎨 <b>Коллекции</b>\nНажмите на название, чтобы скрыть/показать.' : '🎨 Коллекций пока нет.';
  if (cq) return edit(cq, text, kb(rows));
  return reply(chatId, text, kb(rows));
}

async function showBanners(chatId, cq = null) {
  const banners = db.listBanners();
  const rows = banners.map((b) => [
    { text: `${b.active ? '🟢' : '⚪'} ${b.title || 'Без названия'}${b.image_path ? ' 🖼' : ''}`, callback_data: `bant:${b.id}` },
    { text: '✏️', callback_data: `bane:${b.id}` },
    { text: '🖼 Фото', callback_data: `banimg:${b.id}` },
    { text: '🗑', callback_data: `bandl:${b.id}` },
  ]);
  rows.push([{ text: '➕ Новый баннер', callback_data: 'ban:add' }]);
  rows.push(backBtn('menu'));
  const text = banners.length ? '🖼 <b>Баннеры на главной</b>' : '🖼 Баннеров пока нет.\nДобавьте акцию или анонс коллекции.';
  if (cq) return edit(cq, text, kb(rows));
  return reply(chatId, text, kb(rows));
}

async function showSettings(chatId, cq = null) {
  const labels = settingsLabels();
  const rows = Object.entries(labels).map(([key, label]) => [{ text: `✏️ ${label.split(' (')[0]}`, callback_data: `set:${key}` }]);
  rows.push([{ text: '👁 Открыть сайт', url: process.env.SITE_URL || 'https://example.com' }]);
  rows.push(backBtn('menu'));
  const s = db.getSettings();
  const text = [
    '📝 <b>Тексты сайта</b>',
    '',
    `Бейдж: ${escapeHtml(s.hero_badge || '—')}`,
    `Заголовок: ${escapeHtml((s.hero_title || '—').slice(0, 60))}`,
    `Подзаголовок: ${escapeHtml((s.hero_subtitle || '—').slice(0, 80))}`,
    `Объявление: ${escapeHtml((s.notice_text || '—').slice(0, 80))}`,
  ].join('\n');
  if (cq) return edit(cq, text, kb(rows));
  return reply(chatId, text, kb(rows));
}

async function showOrders(chatId, cq = null, filter = 'all', page = 0) {
  const status = filter === 'all' ? null : filter;
  const orders = db.listOrders({ status, limit: 100 });
  const pages = Math.max(1, Math.ceil(orders.length / 10));
  const cur = Math.min(Math.max(0, page), pages - 1);
  const slice = orders.slice(cur * 10, cur * 10 + 10);
  const rows = slice.map((o) => [{
    text: `№${o.id} · ${o.customer_name} · ${money(o.total_cents)} € · ${db.STATUS_LABELS[o.status] || o.status}`,
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
    { text: 'Все', callback_data: 'ord:all:0' },
    { text: '🆕', callback_data: 'ord:new:0' },
    { text: '✅', callback_data: 'ord:confirmed:0' },
    { text: '📦', callback_data: 'ord:shipped:0' },
    { text: '🏁', callback_data: 'ord:done:0' },
  ]);
  rows.push(backBtn('menu'));
  const newCount = db.stats().newOrders;
  const text = `🛒 <b>Заказы</b>${status ? ` · ${db.STATUS_LABELS[status]}` : ''}\nВсего: ${orders.length}${newCount ? ` · новых: <b>${newCount}</b>` : ''}`;
  if (cq) return edit(cq, text, kb(rows));
  return reply(chatId, text, kb(rows));
}

async function showOrder(chatId, cq, id) {
  const o = db.getOrder(id);
  if (!o) return cq ? edit(cq, 'Заказ не найден', kb([backBtn('ord:all:0')])) : reply(chatId, 'Заказ не найден');
  const lines = [
    `🧾 <b>Заказ №${String(o.id).padStart(5, '0')}</b> · <code>${escapeHtml(o.public_id)}</code>`,
    `Статус: <b>${db.STATUS_LABELS[o.status] || o.status}</b>`,
    `Создан: ${escapeHtml(o.created_at)} UTC`,
    '',
    `👤 ${escapeHtml(o.customer_name)}`,
    o.contact ? `📞 ${escapeHtml(o.contact)}` : '📞 контакт не указан',
    o.delivery ? `📍 ${o.delivery === 'pickup' ? 'Самовывоз' : 'Доставка'}` : '',
    o.note ? `💬 ${escapeHtml(o.note)}` : '',
    '',
    ...o.items.map((i) => `• ${escapeHtml(i.name)}${i.size ? ` / ${escapeHtml(i.size)}` : ''}${i.color ? ` / ${escapeHtml(i.color)}` : ''} × ${i.qty} — ${money(i.price_cents * i.qty)} €`),
    '',
    `<b>Итого: ${money(o.total_cents)} €</b>`,
  ].filter((x) => x !== '');
  const markup = kb([
    [{ text: '☑ Принять', callback_data: `ost:${o.id}:confirmed` }, { text: '❌ Отклонить', callback_data: `ost:${o.id}:cancelled` }],
    [{ text: '⚙️ В обработке', callback_data: `ost:${o.id}:processing` }, { text: '📦 Подготовлен', callback_data: `ost:${o.id}:prepared` }],
    [{ text: '🏁 Выполнен', callback_data: `ost:${o.id}:done` }, { text: '🆕 Новая', callback_data: `ost:${o.id}:new` }],
    backBtn('ord:all:0', '← К заказам'),
  ]);
  if (cq) return edit(cq, lines.join('\n'), markup);
  return reply(chatId, lines.join('\n'), markup);
}

// --- входящие сообщения ----------------------------------------------------
async function onText(msg) {
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();

  if (text === '/start') {
    pending.delete(chatId);
    return showMenu(chatId, null, true);
  }
  if (text === '/cancel' || text === '/отмена') {
    pending.delete(chatId);
    return reply(chatId, 'Отменено.', kb([backBtn('menu')]));
  }
  if (text === '/help') {
    return reply(chatId, [
      '<b>Как пользоваться ботом</b>',
      '',
      '📦 Товары — добавление, редактирование, фото, цены, склад, скрытие с сайта.',
      '🎨 Коллекции — новые дропы и коллекции.',
      '🖼 Баннеры — акции и анонсы на главной.',
      '📝 Тексты сайта — заголовки и объявления.',
      '🛒 Заказы — уведомления, детали и статусы.',
      '',
      'Все изменения сразу видны на сайте.',
      '/start — меню · /cancel — отменить ввод',
    ].join('\n'), kb([backBtn('menu')]));
  }
  if (text === '/готово' || text === '/done') {
    const p = pending.get(chatId);
    if (p && p.kind === 'photo') {
      pending.delete(chatId);
      return showProduct(chatId, p.productId);
    }
    pending.delete(chatId);
    return showMenu(chatId);
  }

  const p = pending.get(chatId);
  if (!p) return reply(chatId, 'Выберите действие в меню:', kb([[{ text: '🏠 Меню', callback_data: 'menu' }]]));

  // --- мастер добавления товара ---
  if (p.kind === 'wizard') {
    const step = p.step;
    if (step === 'name') {
      if (text.length < 2) return reply(chatId, 'Название слишком короткое. Введите ещё раз:');
      p.data.name = text.slice(0, 120);
      p.step = 'price';
      return reply(chatId, wizardPrompt('price'));
    }
    if (step === 'price') {
      const cents = parsePriceToCents(text);
      if (!cents) return reply(chatId, 'Не понял цену. Введите число, например 55 или 55.50:');
      p.data.price_cents = cents;
      p.step = 'desc';
      return reply(chatId, wizardPrompt('desc'));
    }
    if (step === 'desc') {
      p.data.description = /^\/skip$/i.test(text) ? '' : text.slice(0, 2000);
      p.step = 'sizes';
      return reply(chatId, wizardPrompt('sizes'));
    }
    if (step === 'sizes') {
      p.data.sizes = /^\/skip$/i.test(text) ? 'S,M,L,XL' : normList(text, 'S,M,L,XL');
      p.step = 'colors';
      return reply(chatId, wizardPrompt('colors'));
    }
    if (step === 'colors') {
      p.data.colors = /^\/skip$/i.test(text) ? 'Чёрный' : normList(text, 'Чёрный');
      p.step = 'stock';
      return reply(chatId, wizardPrompt('stock'));
    }
    if (step === 'stock') {
      const n = Number(String(text).replace(/[^\d]/g, ''));
      if (!Number.isFinite(n) || n < 0) return reply(chatId, 'Введите целое число, например 10:');
      p.data.stock = Math.min(9999, n);
      p.step = 'collection';
      return showWizardCollections(chatId);
    }
    return showMenu(chatId);
  }

  // --- редактирование одного поля ---
  if (p.kind === 'field') {
    const prod = db.getProduct(p.productId);
    if (!prod) { pending.delete(chatId); return showProducts(chatId); }
    let patch = null;
    if (p.field === 'name') {
      if (text.length < 2) return reply(chatId, 'Слишком коротко. Введите название ещё раз:');
      patch = { name: text.slice(0, 120) };
    } else if (p.field === 'price') {
      const cents = parsePriceToCents(text);
      if (!cents) return reply(chatId, 'Не понял цену. Например: 49.90');
      patch = { price_cents: cents, old_price_cents: null };
    } else if (p.field === 'desc') {
      patch = { description: /^\/skip$/i.test(text) ? '' : text.slice(0, 2000) };
    } else if (p.field === 'sizes') {
      patch = { sizes: normList(text, prod.sizes) };
    } else if (p.field === 'colors') {
      patch = { colors: normList(text, prod.colors) };
    } else if (p.field === 'stock') {
      const n = Number(String(text).replace(/[^\d]/g, ''));
      if (!Number.isFinite(n) || n < 0) return reply(chatId, 'Введите целое число:');
      patch = { stock: Math.min(9999, n) };
    }
    if (!patch) return showProduct(chatId, p.productId);
    const updated = db.updateProduct(p.productId, patch);
    pending.delete(chatId);
    return reply(chatId, `✅ Сохранено. Уже на сайте.\n\n${productText(updated)}`, productKeyboard(updated));
  }

  // --- коллекции ---
  if (p.kind === 'coladd') {
    try {
      const c = db.createCollection({ name: text });
      pending.delete(chatId);
      await reply(chatId, `✅ Коллекция «${escapeHtml(c.name)}» создана.`);
      return showCollections(chatId);
    } catch (e) {
      return reply(chatId, `❌ ${escapeHtml(e.message)}`);
    }
  }
  if (p.kind === 'colrename') {
    try {
      const c = db.updateCollection(p.id, { name: text });
      pending.delete(chatId);
      await reply(chatId, `✅ Переименовано в «${escapeHtml(c.name)}».`);
      return showCollections(chatId);
    } catch (e) {
      return reply(chatId, `❌ ${escapeHtml(e.message)}`);
    }
  }

  // --- баннеры ---
  if (p.kind === 'banadd') {
    if (p.step === 'title') {
      p.data.title = text.slice(0, 120);
      p.step = 'subtitle';
      return reply(chatId, 'Подзаголовок (или /skip):');
    }
    if (p.step === 'subtitle') {
      p.data.subtitle = /^\/skip$/i.test(text) ? '' : text.slice(0, 300);
      p.step = 'link';
      return reply(chatId, 'Ссылка (https://t.me/... или /skip):');
    }
    if (p.step === 'link') {
      p.data.link = /^\/skip$/i.test(text) ? '' : text.slice(0, 300);
      const b = db.createBanner(p.data);
      pending.set(chatId, { kind: 'bannerphoto', id: b.id });
      await reply(chatId, '✅ Баннер создан. Отправьте фото баннера или /готово, чтобы пропустить.');
      return;
    }
  }
  if (p.kind === 'bannerphoto') {
    return reply(chatId, 'Отправьте именно фото (изображение) одним сообщением или /готово.');
  }
  if (p.kind === 'banedit') {
    const b = db.getBanner(p.id);
    if (!b) { pending.delete(chatId); return showBanners(chatId); }
    if (p.step === 'title') {
      if (!/^\/skip$/i.test(text)) p.data.title = text.slice(0, 120);
      p.step = 'subtitle';
      return reply(chatId, `Подзаголовок сейчас:\n<i>${escapeHtml(b.subtitle || '—')}</i>\n\nОтправьте новый (или /skip — оставить):`);
    }
    if (p.step === 'subtitle') {
      if (!/^\/skip$/i.test(text)) p.data.subtitle = text.slice(0, 300);
      p.step = 'link';
      return reply(chatId, `Ссылка сейчас:\n<i>${escapeHtml(b.link || '—')}</i>\n\nОтправьте новую (или /skip — оставить):`);
    }
    if (p.step === 'link') {
      if (!/^\/skip$/i.test(text)) p.data.link = text.slice(0, 300);
      db.updateBanner(p.id, p.data);
      pending.delete(chatId);
      await reply(chatId, '✅ Баннер обновлён. Изменения уже на сайте.');
      return showBanners(chatId);
    }
  }

  // --- тексты ---
  if (p.kind === 'setval') {
    db.setSetting(p.key, /^\/skip$/i.test(text) ? '' : text.slice(0, 2000));
    pending.delete(chatId);
    await reply(chatId, '✅ Текст сайта обновлён.');
    return showSettings(chatId);
  }

  // --- фото товара: ждём изображение ---
  if (p.kind === 'photo') {
    return reply(chatId, 'Жду фото (изображение). Отправьте его или /готово.');
  }

  return showMenu(chatId);
}

async function onPhoto(msg) {
  const chatId = msg.chat.id;
  const p = pending.get(chatId);
  const photos = msg.photo || [];
  if (!photos.length) return;
  const fileId = photos[photos.length - 1].file_id;

  if (!p || (p.kind !== 'photo' && p.kind !== 'bannerphoto')) {
    return reply(chatId, 'Чтобы добавить фото: откройте товар → «🖼 Фото».');
  }

  try {
    const { bytes } = await downloadFile(fileId);
    const name = `p-${Date.now()}-${randomBytes(4).toString('hex')}.jpg`;
    writeFileSync(join(db.UPLOADS_DIR, name), bytes);
    const rel = `uploads/${name}`;

    if (p.kind === 'photo') {
      db.addProductPhoto(p.productId, rel);
      const prod = db.getProduct(p.productId);
      await reply(chatId, `✅ Фото добавлено (всего ${(prod.photos || []).length}). Отправьте ещё или /готово.`);
    } else {
      const b = db.updateBanner(p.id, { image_path: rel });
      pending.delete(chatId);
      await reply(chatId, `✅ Фото баннера «${escapeHtml(b.title || '')}» обновлено.`);
      return showBanners(chatId);
    }
  } catch (e) {
    log('photo', `ошибка загрузки: ${e.message}`);
    return reply(chatId, `❌ Не удалось сохранить фото: ${escapeHtml(e.message)}`);
  }
}

// --- главный цикл ----------------------------------------------------------
async function main() {
  if (!botTokenPresent()) {
    log('bot', 'ERROR: TELEGRAM_BOT_TOKEN не задан (см. .env.example)');
    process.exitCode = 1;
    return;
  }
  db.getDb();
  const me = await getMe();
  log('bot', `запущен как @${me.username} (id ${me.id})`);

  const admin = currentAdminId();
  if (admin && !QUIET_START) {
    reply(admin, '🟢 <b>DVIZH FREIBURG — бот магазина на связи.</b>\nВсе изменения сразу попадают на сайт.').catch(() => {});
  }

  let offset = Number(db.getSetting('bot_offset')) || 0;
  let lastOffsetSave = 0;

  while (true) {
    let updates = [];
    try {
      updates = await getUpdates({ offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
    } catch (e) {
      log('bot', `getUpdates: ${e.message} — повтор через 5 с`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    for (const upd of updates) {
      const cq = upd.callback_query;
      const msg = upd.message;
      const userId = cq ? cq.from.id : msg && msg.from && msg.from.id;
      try {
        if (userId) {
          const adminNow = currentAdminId();
          if (!adminNow && msg && /^\/start\b/.test(msg.text || '')) {
            // первичная привязка владельца
            db.setSetting('admin_id', String(userId));
            await reply(userId, '✅ Вы назначены администратором магазина DVIZH FREIBURG.');
            await showMenu(userId, null, true);
          } else if (!adminNow || userId !== adminNow) {
            if (cq) await answerCallbackQuery({ callback_query_id: cq.id, text: 'Доступ только для администратора.' }).catch(() => {});
            else if (msg) await reply(userId, '❌ Этот бот управляет магазином DVIZH FREIBURG и доступен только администратору.');
          } else if (cq) {
            await onCallback(cq);
          } else if (msg) {
            if (msg.photo && msg.photo.length) await onPhoto(msg);
            else if (msg.text) await onText(msg);
          }
        }
      } catch (e) {
        log('bot', `update ${upd.update_id}: ${e.message}`);
        if (cq) await answerCallbackQuery({ callback_query_id: cq.id, text: 'Ошибка, попробуйте ещё раз' }).catch(() => {});
      }
      if (upd.update_id >= offset) offset = upd.update_id + 1;
    }

    if (updates.length && Date.now() - lastOffsetSave > 3000) {
      db.setSetting('bot_offset', String(offset));
      lastOffsetSave = Date.now();
    }
  }
}

main().catch((e) => {
  log('bot', `FATAL: ${e.message}`);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('bot', `${signal}: остановка…`);
    try { db.closeDb(); } catch { /* ignore */ }
    process.exit(0);
  });
}
