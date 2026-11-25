// Общая база данных магазина (SQLite, node:sqlite — встроен в Node 22+).
// Один файл data/shop.db используют и сайт (server.mjs), и бот (bot.mjs).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, publicId, slugify } from './core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(ROOT, 'data');
export const UPLOADS_DIR = resolve(DATA_DIR, 'uploads');
const DB_FILE = process.env.DB_FILE ? resolve(process.env.DB_FILE) : resolve(DATA_DIR, 'shop.db');

// Абсолютный путь к фото по записи в БД (хранится как "uploads/name.jpg").
export function photoAbsolutePath(rel) {
  const clean = String(rel || '')
    .replace(/^[\\/]*uploads[\\/]/, '')
    .replace(/\.\./g, '')
    .replace(/^[\\/]+/, '');
  return resolve(UPLOADS_DIR, clean);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  old_price_cents INTEGER,
  collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  sizes TEXT NOT NULL DEFAULT 'S,M,L,XL',
  colors TEXT NOT NULL DEFAULT 'Чёрный',
  stock INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS product_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  delivery TEXT NOT NULL DEFAULT '',
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER,
  name TEXT NOT NULL,
  size TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL,
  price_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  image_path TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active, sort, id);
CREATE INDEX IF NOT EXISTS idx_photos_product ON product_photos(product_id, sort);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
`;

export const ORDER_STATUSES = ['new', 'confirmed', 'processing', 'prepared', 'done', 'cancelled', 'shipped'];
export const STATUS_LABELS = {
  new: '🆕 Новая заявка', confirmed: '✅ Подтверждён', processing: '⚙️ В обработке',
  prepared: '📦 Подготовлен', done: '🏁 Выполнен', cancelled: '❌ Отклонён', shipped: '🚚 Отправлен',
};

const DEFAULT_SETTINGS = {
  brand: 'DVIZH FREIBURG',
  hero_badge: 'OFFICIAL COMMUNITY MERCH',
  hero_title: 'НЕ ПРОСТО\nОДЕЖДА.',
  hero_subtitle: 'Мерч DVIZH FREIBURG. Выбирай вещь, размер и цвет — заявка сразу уходит администратору.',
  notice_text: 'Оплата и доставка обсуждаются с администратором после оформления заявки.',
  footer_text: 'DVIZH FREIBURG · FREIBURG / DE · COMMUNITY GOODS',
  contact_url: '',
  currency: 'EUR',
  admin_id: '',
  bot_offset: '0',
};

let db = null;

export function getDbPath() {
  return DB_FILE;
}

export function getDb() {
  if (db) return db;
  mkdirSync(UPLOADS_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // Миграции для баз, созданных до появления новых полей.
  for (const sql of [
    "ALTER TABLE orders ADD COLUMN delivery TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE orders ADD COLUMN idempotency_key TEXT',
  ]) {
    try { db.exec(sql); } catch { /* колонка уже есть */ }
  }
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idem ON orders(idempotency_key)'); } catch { /* уже есть */ }
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  }
  log('db', `открыта база ${DB_FILE}`);
  return db;
}

export function closeDb() {
  if (!db) return;
  try { db.close(); } catch { /* уже закрыта */ }
  db = null;
}

const one = (sql, ...p) => getDb().prepare(sql).get(...p) || null;
const all = (sql, ...p) => getDb().prepare(sql).all(...p);
const run = (sql, ...p) => getDb().prepare(sql).run(...p);

// --- настройки -------------------------------------------------------------
export function getSetting(key, fallback = '') {
  const row = one('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value ?? ''));
}
export function getSettings() {
  const out = {};
  for (const r of all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}

// --- коллекции -------------------------------------------------------------
export function listCollections(activeOnly = false) {
  return all(`SELECT * FROM collections ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort, id`);
}
export function getCollection(id) {
  return one('SELECT * FROM collections WHERE id = ?', Number(id) || 0);
}
export function createCollection({ name, description = '' }) {
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) throw new Error('Пустое название коллекции');
  let slug = slugify(clean);
  if (one('SELECT id FROM collections WHERE slug = ?', slug)) slug = `${slug}-${Date.now().toString(36)}`;
  const r = run('INSERT INTO collections (name, slug, description, sort) VALUES (?, ?, ?, ?)',
    clean, slug, String(description).slice(0, 300),
    (one('SELECT COALESCE(MAX(sort), 0) AS m FROM collections')?.m || 0) + 1);
  return getCollection(Number(r.lastInsertRowid));
}
export function updateCollection(id, fields) {
  const cur = getCollection(id);
  if (!cur) throw new Error('Коллекция не найдена');
  const name = fields.name != null ? String(fields.name).trim().slice(0, 80) : cur.name;
  const description = fields.description != null ? String(fields.description).slice(0, 300) : cur.description;
  const active = fields.active != null ? (fields.active ? 1 : 0) : cur.active;
  const sort = fields.sort != null ? Number(fields.sort) || 0 : cur.sort;
  run('UPDATE collections SET name = ?, description = ?, active = ?, sort = ? WHERE id = ?', name, description, active, sort, cur.id);
  return getCollection(cur.id);
}
export function deleteCollection(id) {
  const cur = getCollection(id);
  if (!cur) return false;
  run('DELETE FROM collections WHERE id = ?', cur.id);
  return true;
}

// --- товары ----------------------------------------------------------------
function attachPhotos(products) {
  if (!products.length) return products;
  const ids = products.map((p) => p.id);
  const photos = all(`SELECT * FROM product_photos WHERE product_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort, id`, ...ids);
  const byProduct = new Map();
  for (const ph of photos) {
    if (!byProduct.has(ph.product_id)) byProduct.set(ph.product_id, []);
    byProduct.get(ph.product_id).push(ph);
  }
  return products.map((p) => ({ ...p, photos: byProduct.get(p.id) || [] }));
}

export function listProducts({ activeOnly = false, collectionId = null } = {}) {
  const where = [];
  const params = [];
  if (activeOnly) where.push('p.active = 1');
  if (collectionId) { where.push('p.collection_id = ?'); params.push(Number(collectionId)); }
  const sql = `SELECT p.*, c.name AS collection_name FROM products p
    LEFT JOIN collections c ON c.id = p.collection_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.sort, p.id`;
  return attachPhotos(all(sql, ...params));
}
export function getProduct(id) {
  return attachPhotos(all('SELECT p.*, c.name AS collection_name FROM products p LEFT JOIN collections c ON c.id = p.collection_id WHERE p.id = ?', Number(id) || 0))[0] || null;
}
export function createProduct(data) {
  const name = String(data.name || '').trim().slice(0, 120);
  if (!name) throw new Error('Пустое название товара');
  const price = Number(data.price_cents);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Некорректная цена');
  let slug = slugify(name);
  if (one('SELECT id FROM products WHERE slug = ?', slug)) slug = `${slug}-${Date.now().toString(36)}`;
  const r = run(`INSERT INTO products (name, slug, description, price_cents, old_price_cents, collection_id, sizes, colors, stock, active, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    name, slug,
    String(data.description || '').slice(0, 2000),
    Math.round(price),
    data.old_price_cents ? Math.round(Number(data.old_price_cents)) : null,
    data.collection_id ? Number(data.collection_id) : null,
    String(data.sizes || 'S,M,L,XL').slice(0, 120),
    String(data.colors || 'Чёрный').slice(0, 120),
    Math.max(0, Math.min(9999, Number(data.stock) || 0)),
    data.active === false ? 0 : 1,
    (one('SELECT COALESCE(MAX(sort), 0) AS m FROM products')?.m || 0) + 1);
  return getProduct(Number(r.lastInsertRowid));
}
export function updateProduct(id, fields) {
  const cur = getProduct(id);
  if (!cur) throw new Error('Товар не найден');
  const next = {
    name: fields.name != null ? String(fields.name).trim().slice(0, 120) : cur.name,
    description: fields.description != null ? String(fields.description).slice(0, 2000) : cur.description,
    price_cents: fields.price_cents != null ? Math.round(Number(fields.price_cents)) : cur.price_cents,
    old_price_cents: fields.old_price_cents !== undefined
      ? (fields.old_price_cents ? Math.round(Number(fields.old_price_cents)) : null) : cur.old_price_cents,
    collection_id: fields.collection_id !== undefined
      ? (fields.collection_id ? Number(fields.collection_id) : null) : cur.collection_id,
    sizes: fields.sizes != null ? String(fields.sizes).slice(0, 120) : cur.sizes,
    colors: fields.colors != null ? String(fields.colors).slice(0, 120) : cur.colors,
    stock: fields.stock != null ? Math.max(0, Math.min(9999, Number(fields.stock) || 0)) : cur.stock,
    active: fields.active != null ? (fields.active ? 1 : 0) : cur.active,
    sort: fields.sort != null ? Number(fields.sort) || 0 : cur.sort,
  };
  if (!next.name) throw new Error('Пустое название товара');
  if (!Number.isFinite(next.price_cents) || next.price_cents <= 0) throw new Error('Некорректная цена');
  run(`UPDATE products SET name = ?, description = ?, price_cents = ?, old_price_cents = ?,
       collection_id = ?, sizes = ?, colors = ?, stock = ?, active = ?, sort = ?, updated_at = datetime('now')
       WHERE id = ?`,
    next.name, next.description, next.price_cents, next.old_price_cents, next.collection_id,
    next.sizes, next.colors, next.stock, next.active, next.sort, cur.id);
  return getProduct(cur.id);
}
export function deleteProduct(id) {
  return run('DELETE FROM products WHERE id = ?', Number(id) || 0).changes > 0;
}
export function addProductPhoto(productId, path) {
  const r = run('INSERT INTO product_photos (product_id, path, sort) VALUES (?, ?, ?)',
    Number(productId), String(path), (one('SELECT COALESCE(MAX(sort), 0) AS m FROM product_photos WHERE product_id = ?', Number(productId))?.m || 0) + 1);
  return one('SELECT * FROM product_photos WHERE id = ?', Number(r.lastInsertRowid));
}
export function getPhoto(id) {
  return one('SELECT * FROM product_photos WHERE id = ?', Number(id) || 0);
}
export function deletePhoto(id) {
  return run('DELETE FROM product_photos WHERE id = ?', Number(id) || 0).changes > 0;
}

// --- баннеры ---------------------------------------------------------------
export function listBanners(activeOnly = false) {
  return all(`SELECT * FROM banners ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort, id`);
}
export function getBanner(id) {
  return one('SELECT * FROM banners WHERE id = ?', Number(id) || 0);
}
export function createBanner(data) {
  const r = run('INSERT INTO banners (title, subtitle, link, image_path, sort, active) VALUES (?, ?, ?, ?, ?, ?)',
    String(data.title || '').slice(0, 120), String(data.subtitle || '').slice(0, 300),
    String(data.link || '').slice(0, 300), String(data.image_path || '').slice(0, 300),
    Number(data.sort) || 0, data.active === false ? 0 : 1);
  return getBanner(Number(r.lastInsertRowid));
}
export function updateBanner(id, fields) {
  const cur = getBanner(id);
  if (!cur) throw new Error('Баннер не найден');
  run('UPDATE banners SET title = ?, subtitle = ?, link = ?, image_path = ?, sort = ?, active = ? WHERE id = ?',
    fields.title != null ? String(fields.title).slice(0, 120) : cur.title,
    fields.subtitle != null ? String(fields.subtitle).slice(0, 300) : cur.subtitle,
    fields.link != null ? String(fields.link).slice(0, 300) : cur.link,
    fields.image_path != null ? String(fields.image_path).slice(0, 300) : cur.image_path,
    fields.sort != null ? Number(fields.sort) || 0 : cur.sort,
    fields.active != null ? (fields.active ? 1 : 0) : cur.active,
    cur.id);
  return getBanner(cur.id);
}
export function deleteBanner(id) {
  return run('DELETE FROM banners WHERE id = ?', Number(id) || 0).changes > 0;
}

// --- заказы ----------------------------------------------------------------
// items: [{ productId, size, color, qty }] — цены берём ТОЛЬКО из БД.
export function createOrder({ customer_name, contact = '', note = '', delivery = '', idempotency_key = '', items }) {
  const name = String(customer_name || '').trim().slice(0, 80);
  if (name.length < 2) throw new Error('Укажите имя');
  const idem = String(idempotency_key || '').trim().slice(0, 64);
  const idemKey = /^[A-Za-z0-9_-]{8,64}$/.test(idem) ? idem : '';
  if (idemKey) {
    const existing = one('SELECT id FROM orders WHERE idempotency_key = ?', idemKey);
    if (existing) return getOrder(existing.id);
  }
  const method = delivery === 'pickup' ? 'pickup' : delivery === 'delivery' ? 'delivery' : '';
  if (!Array.isArray(items) || !items.length) throw new Error('Корзина пуста');
  if (items.length > 25) throw new Error('Слишком много позиций');

  const dbh = getDb();
  const prepared = [];
  for (const it of items) {
    const product = getProduct(Number(it.productId));
    if (!product || !product.active) throw new Error('Товар недоступен');
    const qty = Math.max(1, Math.min(20, Number(it.qty) || 1));
    if (product.stock <= 0) throw new Error(`«${product.name}» нет в наличии`);
    if (qty > product.stock) throw new Error(`«${product.name}»: осталось ${product.stock} шт.`);
    prepared.push({ product, qty, size: String(it.size || '').slice(0, 40), color: String(it.color || '').slice(0, 40) });
  }
  const total = prepared.reduce((sum, x) => sum + x.product.price_cents * x.qty, 0);

  dbh.exec('BEGIN IMMEDIATE');
  try {
    const pid = publicId();
    const r = dbh.prepare(`INSERT INTO orders (public_id, customer_name, contact, note, delivery, total_cents, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(pid, name, String(contact || '').slice(0, 120), String(note || '').slice(0, 500), method, total, idemKey || null);
    const orderId = Number(r.lastInsertRowid);
    for (const x of prepared) {
      dbh.prepare('INSERT INTO order_items (order_id, product_id, name, size, color, qty, price_cents) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(orderId, x.product.id, x.product.name, x.size, x.color, x.qty, x.product.price_cents);
      dbh.prepare('UPDATE products SET stock = stock - ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(x.qty, x.product.id);
    }
    dbh.exec('COMMIT');
    return getOrder(orderId);
  } catch (e) {
    dbh.exec('ROLLBACK');
    throw e;
  }
}

export function getOrder(id) {
  const order = one('SELECT * FROM orders WHERE id = ?', Number(id) || 0);
  if (!order) return null;
  order.items = all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', order.id);
  return order;
}
export function getOrderByPublicId(pid) {
  const order = one('SELECT * FROM orders WHERE public_id = ?', String(pid));
  if (!order) return null;
  order.items = all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', order.id);
  return order;
}
export function listOrders({ status = null, limit = 20 } = {}) {
  const rows = status
    ? all('SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT ?', status, limit)
    : all('SELECT * FROM orders ORDER BY id DESC LIMIT ?', limit);
  for (const o of rows) o.items = all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', o.id);
  return rows;
}
export function setOrderStatus(id, status) {
  if (!ORDER_STATUSES.includes(status)) throw new Error('Неизвестный статус');
  run("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?", status, Number(id) || 0);
  return getOrder(id);
}
export function stats() {
  return {
    products: one('SELECT COUNT(*) AS c FROM products').c,
    active: one('SELECT COUNT(*) AS c FROM products WHERE active = 1').c,
    collections: one('SELECT COUNT(*) AS c FROM collections').c,
    orders: one('SELECT COUNT(*) AS c FROM orders').c,
    newOrders: one("SELECT COUNT(*) AS c FROM orders WHERE status = 'new'").c,
    lowStock: one('SELECT COUNT(*) AS c FROM products WHERE active = 1 AND stock <= 2').c,
  };
}
