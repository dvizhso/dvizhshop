// D1-слой магазина. Схема совместима с локальной SQLite-версией.
// Все функции асинхронные: Cloudflare D1 не поддерживает синхронные запросы.

export const ORDER_STATUSES = ['new', 'confirmed', 'processing', 'prepared', 'done', 'cancelled', 'shipped'];
export const STATUS_LABELS = {
  new: '🆕 Новая заявка',
  confirmed: '✅ Подтверждён',
  processing: '⚙️ В обработке',
  prepared: '📦 Подготовлен',
  done: '🏁 Выполнен',
  cancelled: '❌ Отклонён',
  shipped: '🚚 Отправлен',
};
export const DELIVERY_LABELS = {
  delivery: 'Доставка',
  pickup: 'Самовывоз',
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
};

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
  tg_message_id INTEGER,
  tg_chat_id TEXT,
  tg_username TEXT,
  idempotency_key TEXT,
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
CREATE TABLE IF NOT EXISTS order_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notify_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bot_sessions (
  chat_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active, sort, id);
CREATE INDEX IF NOT EXISTS idx_photos_product ON product_photos(product_id, sort);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_hits_ip ON order_hits(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_notify_pending ON notify_queue(sent_at, attempts, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idem ON orders(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_orders_public ON orders(public_id);
CREATE TRIGGER IF NOT EXISTS prevent_negative_stock
BEFORE UPDATE OF stock ON products
WHEN NEW.stock < 0
BEGIN SELECT RAISE(ABORT, 'out_of_stock'); END;
`;

const SEED_PRODUCTS = [
  {
    name: 'Футболка DVIZH', slug: 'futbolka-dvizh',
    description: 'Базовая футболка с логотипом DVIZH FREIBURG. Плотный хлопок 240 г/м², свободный крой.',
    price_cents: 2500, sizes: 'XS,S,M,L,XL,XXL', colors: 'Чёрный,Белый', stock: 12,
  },
  {
    name: 'Худи DVIZH', slug: 'hudi-dvizh',
    description: 'Плотное худи для повседневной носки. Утеплённый футер, свободный крой, вышивка DVIZH.',
    price_cents: 5500, sizes: 'S,M,L,XL,XXL', colors: 'Чёрный,Серый', stock: 8,
  },
  {
    name: 'Зип-худи DVIZH', slug: 'zip-hudi-dvizh',
    description: 'Худи на молнии с высоким воротом. Карманы-кенгуру, фирменная нашивка на груди.',
    price_cents: 6000, sizes: 'S,M,L,XL,XXL', colors: 'Чёрный', stock: 6,
  },
  {
    name: 'Свитшот DVIZH', slug: 'svitshot-dvizh',
    description: 'Минималистичный свитшот с логотипом. Мягкий футер, универсальная посадка.',
    price_cents: 4500, sizes: 'S,M,L,XL', colors: 'Чёрный,Белый', stock: 10,
  },
  {
    name: 'Лонгслив DVIZH', slug: 'longsliv-dvizh',
    description: 'Футболка с длинным рукавом. Тонкий плотный трикотаж, принт на груди и рукаве.',
    price_cents: 3200, sizes: 'S,M,L,XL', colors: 'Чёрный', stock: 9,
  },
  {
    name: 'Кепка DVIZH', slug: 'kepka-dvizh',
    description: 'Кепка с вышивкой DVIZH. Регулируемый ремешок, изогнутый козырёк.',
    price_cents: 2000, sizes: 'ONE SIZE', colors: 'Чёрный', stock: 15,
  },
];

let schemaReady = null;

export function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = init(env).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function init(env) {
  if (!env.DB) throw new Error('D1 binding DB не настроен');
  await env.DB.exec(SCHEMA);
  // Мягкие миграции для баз, созданных до появления новых колонок.
  for (const sql of [
    'ALTER TABLE orders ADD COLUMN tg_message_id INTEGER',
    'ALTER TABLE orders ADD COLUMN tg_chat_id TEXT',
    'ALTER TABLE orders ADD COLUMN tg_username TEXT',
    'ALTER TABLE orders ADD COLUMN idempotency_key TEXT',
    "ALTER TABLE orders ADD COLUMN delivery TEXT NOT NULL DEFAULT ''",
  ]) {
    try { await env.DB.prepare(sql).run(); } catch { /* колонка уже есть */ }
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
  }
  const count = await first(env, 'SELECT COUNT(*) AS c FROM products');
  if (!Number(count?.c || 0)) await seed(env);
}

async function seed(env) {
  await env.DB.prepare('INSERT OR IGNORE INTO collections (name, slug, description, sort) VALUES (?, ?, ?, ?)')
    .bind('Первая коллекция', 'pervaya-kollekciya', 'Базовый дроп DVIZH FREIBURG.', 1).run();
  const collection = await first(env, 'SELECT id FROM collections WHERE slug = ?', 'pervaya-kollekciya');
  for (const item of SEED_PRODUCTS) {
    await env.DB.prepare(`INSERT INTO products
      (name, slug, description, price_cents, collection_id, sizes, colors, stock, active, sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`)
      .bind(item.name, item.slug, item.description, item.price_cents, collection?.id || null,
        item.sizes, item.colors, item.stock).run();
  }
  await env.DB.prepare('INSERT INTO banners (title, subtitle, sort, active) VALUES (?, ?, ?, 1)')
    .bind('COMMUNITY GOODS', 'Официальный мерч DVIZH FREIBURG. Ограниченные серии — пока есть на складе.', 1).run();
}

// --- низкоуровневые помощники ----------------------------------------------
export async function all(env, sql, ...params) {
  const result = await env.DB.prepare(sql).bind(...params).all();
  return result.results || [];
}
export async function first(env, sql, ...params) {
  return (await env.DB.prepare(sql).bind(...params).first()) || null;
}
export async function run(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).run();
}

export function slugify(value) {
  const map = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  return String(value || '').toLowerCase().trim()
    .split('').map((ch) => (map[ch] !== undefined ? map[ch] : ch)).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
}

export function publicId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

// --- настройки -------------------------------------------------------------
export async function getSetting(env, key, fallback = '') {
  const row = await first(env, 'SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}
export async function setSetting(env, key, value) {
  await run(env, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value ?? ''));
}
export async function getSettings(env) {
  const rows = await all(env, 'SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// --- коллекции -------------------------------------------------------------
export async function listCollections(env, activeOnly = false) {
  return all(env, `SELECT * FROM collections ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort, id`);
}
export async function getCollection(env, id) {
  return first(env, 'SELECT * FROM collections WHERE id = ?', Number(id) || 0);
}
export async function createCollection(env, { name, description = '' }) {
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) throw new Error('Пустое название коллекции');
  let slug = slugify(clean);
  if (await first(env, 'SELECT id FROM collections WHERE slug = ?', slug)) slug = `${slug}-${Date.now().toString(36)}`;
  const max = await first(env, 'SELECT COALESCE(MAX(sort), 0) AS m FROM collections');
  const result = await run(env, 'INSERT INTO collections (name, slug, description, sort) VALUES (?, ?, ?, ?)',
    clean, slug, String(description).slice(0, 300), Number(max?.m || 0) + 1);
  return getCollection(env, Number(result.meta.last_row_id));
}
export async function updateCollection(env, id, fields) {
  const cur = await getCollection(env, id);
  if (!cur) throw new Error('Коллекция не найдена');
  const name = fields.name != null ? String(fields.name).trim().slice(0, 80) : cur.name;
  const description = fields.description != null ? String(fields.description).slice(0, 300) : cur.description;
  const active = fields.active != null ? (fields.active ? 1 : 0) : cur.active;
  const sort = fields.sort != null ? Number(fields.sort) || 0 : cur.sort;
  await run(env, 'UPDATE collections SET name = ?, description = ?, active = ?, sort = ? WHERE id = ?', name, description, active, sort, cur.id);
  return getCollection(env, cur.id);
}
export async function deleteCollection(env, id) {
  return (await run(env, 'DELETE FROM collections WHERE id = ?', Number(id) || 0)).meta.changes > 0;
}

// --- товары ----------------------------------------------------------------
async function attachPhotos(env, products) {
  if (!products.length) return products;
  const ids = products.map((p) => p.id);
  const photos = await all(env,
    `SELECT * FROM product_photos WHERE product_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort, id`, ...ids);
  const byProduct = new Map();
  for (const photo of photos) {
    if (!byProduct.has(photo.product_id)) byProduct.set(photo.product_id, []);
    byProduct.get(photo.product_id).push(photo);
  }
  return products.map((p) => ({ ...p, photos: byProduct.get(p.id) || [] }));
}

export async function listProducts(env, { activeOnly = false, collectionId = null } = {}) {
  const where = [];
  const params = [];
  if (activeOnly) where.push('p.active = 1');
  if (collectionId) { where.push('p.collection_id = ?'); params.push(Number(collectionId)); }
  const sql = `SELECT p.*, c.name AS collection_name FROM products p
    LEFT JOIN collections c ON c.id = p.collection_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.sort, p.id`;
  return attachPhotos(env, await all(env, sql, ...params));
}
export async function getProduct(env, id) {
  const rows = await attachPhotos(env, await all(env,
    'SELECT p.*, c.name AS collection_name FROM products p LEFT JOIN collections c ON c.id = p.collection_id WHERE p.id = ?',
    Number(id) || 0));
  return rows[0] || null;
}
export async function createProduct(env, data) {
  const name = String(data.name || '').trim().slice(0, 120);
  if (!name) throw new Error('Пустое название товара');
  const price = Math.round(Number(data.price_cents) || 0);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Некорректная цена');
  let slug = slugify(name);
  if (await first(env, 'SELECT id FROM products WHERE slug = ?', slug)) slug = `${slug}-${Date.now().toString(36)}`;
  const max = await first(env, 'SELECT COALESCE(MAX(sort), 0) AS m FROM products');
  const result = await run(env, `INSERT INTO products
    (name, slug, description, price_cents, old_price_cents, collection_id, sizes, colors, stock, active, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    name, slug, String(data.description || '').slice(0, 2000), price,
    data.old_price_cents ? Math.round(Number(data.old_price_cents)) : null,
    data.collection_id ? Number(data.collection_id) : null,
    String(data.sizes || 'S,M,L,XL').slice(0, 120), String(data.colors || 'Чёрный').slice(0, 120),
    Math.max(0, Math.min(9999, Number(data.stock) || 0)), data.active === false ? 0 : 1,
    Number(data.sort) || Number(max?.m || 0) + 1);
  return getProduct(env, Number(result.meta.last_row_id));
}
export async function updateProduct(env, id, fields) {
  const cur = await getProduct(env, id);
  if (!cur) throw new Error('Товар не найден');
  const next = {
    name: fields.name != null ? String(fields.name).trim().slice(0, 120) : cur.name,
    description: fields.description != null ? String(fields.description).slice(0, 2000) : cur.description,
    price_cents: fields.price_cents != null ? Math.round(Number(fields.price_cents) || 0) : cur.price_cents,
    old_price_cents: fields.old_price_cents !== undefined ? (fields.old_price_cents ? Math.round(Number(fields.old_price_cents)) : null) : cur.old_price_cents,
    collection_id: fields.collection_id !== undefined ? (fields.collection_id ? Number(fields.collection_id) : null) : cur.collection_id,
    sizes: fields.sizes != null ? String(fields.sizes).slice(0, 120) : cur.sizes,
    colors: fields.colors != null ? String(fields.colors).slice(0, 120) : cur.colors,
    stock: fields.stock != null ? Math.max(0, Math.min(9999, Number(fields.stock) || 0)) : cur.stock,
    active: fields.active != null ? (fields.active ? 1 : 0) : cur.active,
    sort: fields.sort != null ? Number(fields.sort) || 0 : cur.sort,
  };
  if (!next.name) throw new Error('Пустое название товара');
  if (!Number.isFinite(next.price_cents) || next.price_cents <= 0) throw new Error('Некорректная цена');
  await run(env, `UPDATE products SET name = ?, description = ?, price_cents = ?, old_price_cents = ?,
    collection_id = ?, sizes = ?, colors = ?, stock = ?, active = ?, sort = ?, updated_at = datetime('now')
    WHERE id = ?`,
    next.name, next.description, next.price_cents, next.old_price_cents, next.collection_id,
    next.sizes, next.colors, next.stock, next.active, next.sort, cur.id);
  return getProduct(env, cur.id);
}
export async function deleteProduct(env, id) {
  return (await run(env, 'DELETE FROM products WHERE id = ?', Number(id) || 0)).meta.changes > 0;
}
export async function addProductPhoto(env, productId, path) {
  const max = await first(env, 'SELECT COALESCE(MAX(sort), 0) AS m FROM product_photos WHERE product_id = ?', Number(productId));
  const result = await run(env, 'INSERT INTO product_photos (product_id, path, sort) VALUES (?, ?, ?)',
    Number(productId), String(path), Number(max?.m || 0) + 1);
  return first(env, 'SELECT * FROM product_photos WHERE id = ?', Number(result.meta.last_row_id));
}
export async function getPhoto(env, id) {
  return first(env, 'SELECT * FROM product_photos WHERE id = ?', Number(id) || 0);
}
export async function deletePhoto(env, id) {
  return (await run(env, 'DELETE FROM product_photos WHERE id = ?', Number(id) || 0)).meta.changes > 0;
}

// --- баннеры ---------------------------------------------------------------
export async function listBanners(env, activeOnly = false) {
  return all(env, `SELECT * FROM banners ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort, id`);
}
export async function getBanner(env, id) {
  return first(env, 'SELECT * FROM banners WHERE id = ?', Number(id) || 0);
}
export async function createBanner(env, data) {
  const result = await run(env, 'INSERT INTO banners (title, subtitle, link, image_path, sort, active) VALUES (?, ?, ?, ?, ?, ?)',
    String(data.title || '').slice(0, 120), String(data.subtitle || '').slice(0, 300),
    String(data.link || '').slice(0, 300), String(data.image_path || '').slice(0, 300),
    Number(data.sort) || 0, data.active === false ? 0 : 1);
  return getBanner(env, Number(result.meta.last_row_id));
}
export async function updateBanner(env, id, fields) {
  const cur = await getBanner(env, id);
  if (!cur) throw new Error('Баннер не найден');
  await run(env, 'UPDATE banners SET title = ?, subtitle = ?, link = ?, image_path = ?, sort = ?, active = ? WHERE id = ?',
    fields.title != null ? String(fields.title).slice(0, 120) : cur.title,
    fields.subtitle != null ? String(fields.subtitle).slice(0, 300) : cur.subtitle,
    fields.link != null ? String(fields.link).slice(0, 300) : cur.link,
    fields.image_path != null ? String(fields.image_path).slice(0, 300) : cur.image_path,
    fields.sort != null ? Number(fields.sort) || 0 : cur.sort,
    fields.active != null ? (fields.active ? 1 : 0) : cur.active,
    cur.id);
  return getBanner(env, cur.id);
}
export async function deleteBanner(env, id) {
  return (await run(env, 'DELETE FROM banners WHERE id = ?', Number(id) || 0)).meta.changes > 0;
}

// --- каталог ---------------------------------------------------------------
export async function publicCatalog(env) {
  await ensureSchema(env);
  const settings = await getSettings(env);
  const safeSettings = {
    brand: settings.brand, hero_badge: settings.hero_badge, hero_title: settings.hero_title,
    hero_subtitle: settings.hero_subtitle, notice_text: settings.notice_text,
    footer_text: settings.footer_text, contact_url: settings.contact_url,
    currency: settings.currency || 'EUR',
    bot_username: String(settings.bot_username || env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''),
  };
  const collections = await listCollections(env, true);
  const products = await listProducts(env, { activeOnly: true });
  const banners = await listBanners(env, true);
  return {
    settings: safeSettings,
    collections: collections.map(({ id, name, slug, description }) => ({ id, name, slug, description })),
    products: products.map((p) => ({
      id: p.id, name: p.name, slug: p.slug, description: p.description,
      price: p.price_cents, oldPrice: p.old_price_cents,
      collection: p.collection_id, collectionName: p.collection_name || '',
      sizes: String(p.sizes || '').split(',').map((x) => x.trim()).filter(Boolean),
      colors: String(p.colors || '').split(',').map((x) => x.trim()).filter(Boolean),
      stock: p.stock,
      photos: (p.photos || []).map((ph) => '/' + ph.path),
    })),
    banners: banners.map((b) => ({
      id: b.id, title: b.title, subtitle: b.subtitle, link: b.link,
      image: b.image_path ? '/' + b.image_path : '',
    })),
  };
}

// --- заказы ----------------------------------------------------------------
export class RateLimitError extends Error {}
export class OutOfStockError extends Error {}

const orderHit = (env, ip) => run(env, 'INSERT INTO order_hits (ip, created_at) VALUES (?, ?)', ip, Date.now());

export async function createOrder(env, input, ip = 'unknown') {
  await ensureSchema(env);

  // Защита от повторной отправки: один и тот же ключ возвращает уже созданный заказ.
  const idem = String(input?.idempotency_key || '').trim().slice(0, 64);
  const idemKey = /^[A-Za-z0-9_-]{8,64}$/.test(idem) ? idem : '';
  if (idemKey) {
    const existing = await first(env, 'SELECT id FROM orders WHERE idempotency_key = ?', idemKey);
    if (existing) return await getOrder(env, existing.id);
  }

  const name = String(input?.customer_name || '').trim().slice(0, 80);
  if (name.length < 2) throw new Error('Укажите имя');
  const contact = String(input?.contact || '').slice(0, 120);
  const note = String(input?.note || '').slice(0, 500);
  const delivery = input?.delivery === 'pickup' ? 'pickup' : input?.delivery === 'delivery' ? 'delivery' : '';
  if (!Array.isArray(input?.items) || !input.items.length) throw new Error('Корзина пуста');
  if (input.items.length > 25) throw new Error('Слишком много позиций');

  const now = Date.now();
  await run(env, 'DELETE FROM order_hits WHERE created_at < ?', now - 10 * 60 * 1000);
  const hits = await first(env, 'SELECT COUNT(*) AS c FROM order_hits WHERE ip = ? AND created_at > ?', ip, now - 10 * 60 * 1000);
  if (Number(hits?.c || 0) >= 5) throw new RateLimitError('Слишком много заказов. Попробуйте позже.');
  await orderHit(env, ip);

  // объединяем одинаковые позиции
  const wanted = new Map();
  for (const item of input.items) {
    const productId = Number(item?.productId);
    const qty = Math.max(1, Math.min(20, Number(item?.qty) || 1));
    const size = String(item?.size || '').slice(0, 40);
    const color = String(item?.color || '').slice(0, 40);
    const key = `${productId}|${size}|${color}`;
    if (wanted.has(key)) wanted.get(key).qty += qty;
    else wanted.set(key, { productId, qty, size, color });
  }

  const ids = [...new Set([...wanted.values()].map((x) => x.productId).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) throw new Error('Товар недоступен');
  const products = await all(env,
    `SELECT * FROM products WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const byId = new Map(products.map((p) => [p.id, p]));

  const prepared = [];
  for (const item of wanted.values()) {
    const product = byId.get(item.productId);
    if (!product) throw new Error('Товар недоступен');
    if (product.stock <= 0) throw new Error(`«${product.name}» нет в наличии`);
    if (item.qty > product.stock) throw new Error(`«${product.name}»: осталось ${product.stock} шт.`);
    prepared.push({ product, ...item });
  }

  // повторная проверка суммарного количества по каждому товару
  const totals = new Map();
  for (const item of prepared) totals.set(item.productId, (totals.get(item.productId) || 0) + item.qty);
  for (const [productId, qty] of totals) {
    const product = byId.get(productId);
    if (qty > product.stock) throw new Error(`«${product.name}»: осталось ${product.stock} шт.`);
  }

  const total = prepared.reduce((sum, x) => sum + x.product.price_cents * x.qty, 0);
  const pid = publicId();
  const statements = [
    env.DB.prepare(`INSERT INTO orders
      (public_id, customer_name, contact, note, delivery, total_cents, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(pid, name, contact, note, delivery, total, idemKey || null),
  ];
  for (const item of prepared) {
    statements.push(env.DB.prepare(`INSERT INTO order_items
      (order_id, product_id, name, size, color, qty, price_cents)
      SELECT id, ?, ?, ?, ?, ?, ? FROM orders WHERE public_id = ?`)
      .bind(item.product.id, item.product.name, item.size, item.color, item.qty, item.product.price_cents, pid));
    statements.push(env.DB.prepare("UPDATE products SET stock = stock - ?, updated_at = datetime('now') WHERE id = ?")
      .bind(item.qty, item.product.id));
  }
  // Уведомление ставится в очередь в той же транзакции, что и заявка:
  // даже если Worker упадёт сразу после ответа, заявка не останется без уведомления.
  statements.push(env.DB.prepare(`INSERT INTO notify_queue (order_id)
    SELECT id FROM orders WHERE public_id = ?
    AND NOT EXISTS (SELECT 1 FROM notify_queue WHERE order_id = orders.id)`)
    .bind(pid));

  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (/out_of_stock/i.test(String(error?.message || error))) {
      throw new OutOfStockError('Товар закончился. Обновите каталог и попробуйте снова.');
    }
    // Параллельный запрос с тем же ключом уже создал заказ — возвращаем его.
    if (idemKey && /unique|constraint/i.test(String(error?.message || error))) {
      const existing = await first(env, 'SELECT id FROM orders WHERE idempotency_key = ?', idemKey);
      if (existing) return await getOrder(env, existing.id);
    }
    throw error;
  }

  const created = await first(env, 'SELECT id FROM orders WHERE public_id = ?', pid);
  return {
    id: created?.id || null,
    public_id: pid,
    customer_name: name,
    contact,
    note,
    delivery,
    total_cents: total,
    status: 'new',
    items: prepared.map((x) => ({
      product_id: x.product.id, name: x.product.name, size: x.size,
      color: x.color, qty: x.qty, price_cents: x.product.price_cents,
    })),
  };
}

export async function getOrder(env, id) {
  const order = await first(env, 'SELECT * FROM orders WHERE id = ?', Number(id) || 0);
  if (!order) return null;
  order.items = await all(env, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY id', order.id);
  return order;
}

export async function getOrderByPublicId(env, publicIdValue) {
  const order = await first(env, 'SELECT * FROM orders WHERE public_id = ?', String(publicIdValue || ''));
  if (!order) return null;
  order.items = await all(env, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY id', order.id);
  return order;
}

// Покупатель запустил бота по ссылке из оформления заказа — запоминаем чат,
// чтобы присылать ему только статусы его собственного заказа.
export async function linkOrderChat(env, orderId, chatId, username = '') {
  await run(env,
    "UPDATE orders SET tg_chat_id = ?, tg_username = ?, updated_at = datetime('now') WHERE id = ?",
    String(chatId), String(username || '').slice(0, 64), Number(orderId) || 0);
  return getOrder(env, orderId);
}
export async function listOrders(env, { status = null, limit = 100 } = {}) {
  const orders = status
    ? await all(env, 'SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT ?', status, Number(limit) || 100)
    : await all(env, 'SELECT * FROM orders ORDER BY id DESC LIMIT ?', Number(limit) || 100);
  if (!orders.length) return orders;
  const ids = orders.map((o) => o.id);
  const items = await all(env,
    `SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ...ids);
  const byOrder = new Map();
  for (const item of items) {
    if (!byOrder.has(item.order_id)) byOrder.set(item.order_id, []);
    byOrder.get(item.order_id).push(item);
  }
  return orders.map((o) => ({ ...o, items: byOrder.get(o.id) || [] }));
}
export async function setOrderStatus(env, id, status) {
  if (!ORDER_STATUSES.includes(status)) throw new Error('Неизвестный статус');
  const order = await getOrder(env, id);
  if (!order) throw new Error('Заказ не найден');
  await run(env, "UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?", status, order.id);
  return getOrder(env, order.id);
}
export async function stats(env) {
  const products = await first(env, 'SELECT COUNT(*) AS c FROM products');
  const active = await first(env, 'SELECT COUNT(*) AS c FROM products WHERE active = 1');
  const collections = await first(env, 'SELECT COUNT(*) AS c FROM collections');
  const orders = await first(env, 'SELECT COUNT(*) AS c FROM orders');
  const newOrders = await first(env, "SELECT COUNT(*) AS c FROM orders WHERE status = 'new'");
  const lowStock = await first(env, 'SELECT COUNT(*) AS c FROM products WHERE active = 1 AND stock <= 2');
  return {
    products: Number(products?.c || 0), active: Number(active?.c || 0),
    collections: Number(collections?.c || 0), orders: Number(orders?.c || 0),
    newOrders: Number(newOrders?.c || 0), lowStock: Number(lowStock?.c || 0),
  };
}
