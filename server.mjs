// DVIZH FREIBURG — backend: статический магазин + публичный API + защищённый admin API.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  loadEnv, log, escapeHtml, money, constantTimeEqual,
} from './lib/core.mjs';
import {
  getDb, closeDb, getSettings, getSetting, setSetting, listCollections, getCollection, createCollection, updateCollection, deleteCollection,
  listProducts, getProduct, createProduct, updateProduct, deleteProduct,
  addProductPhoto, getPhoto, deletePhoto, listBanners, getBanner, createBanner, updateBanner, deleteBanner,
  createOrder, listOrders, getOrder, setOrderStatus, stats, UPLOADS_DIR,
  photoAbsolutePath,
} from './lib/db.mjs';
import { notifyAdmin } from './lib/telegram.mjs';

loadEnv();

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(ROOT, 'public');
const PORT = Number(process.env.PORT || 8088);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    ...headers,
  });
  res.end(isBuf ? body : body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolvePromise(raw ? JSON.parse(raw) : {});
      } catch { reject(new Error('Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

function publicCatalog() {
  const s = getSettings();
  const safeSettings = {
    brand: s.brand, hero_badge: s.hero_badge, hero_title: s.hero_title, hero_subtitle: s.hero_subtitle,
    notice_text: s.notice_text, footer_text: s.footer_text, contact_url: s.contact_url, currency: s.currency || 'EUR',
  };
  return {
    settings: safeSettings,
    collections: listCollections(true).map(({ id, name, slug, description }) => ({ id, name, slug, description })),
    products: listProducts({ activeOnly: true }).map((p) => ({
      id: p.id, name: p.name, slug: p.slug, description: p.description,
      price: p.price_cents, oldPrice: p.old_price_cents,
      collection: p.collection_id, collectionName: p.collection_name || '',
      sizes: String(p.sizes || '').split(',').map((x) => x.trim()).filter(Boolean),
      colors: String(p.colors || '').split(',').map((x) => x.trim()).filter(Boolean),
      stock: p.stock,
      photos: (p.photos || []).map((ph) => '/' + ph.path),
    })),
    banners: listBanners(true).map((b) => ({
      id: b.id, title: b.title, subtitle: b.subtitle, link: b.link, image: b.image_path ? '/' + b.image_path : '',
    })),
  };
}

// --- rate limit для заказов -------------------------------------------------
const orderHits = new Map(); // ip -> timestamps
function orderRateLimited(ip) {
  const now = Date.now();
  const arr = (orderHits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now);
  orderHits.set(ip, arr);
  if (orderHits.size > 5000) orderHits.clear();
  return arr.length > 5;
}

function adminAuthorized(req, url) {
  if (!ADMIN_TOKEN) return false;
  const header = req.headers['x-admin-token'] || url.searchParams.get('token') || '';
  return constantTimeEqual(header, ADMIN_TOKEN);
}

function saveUploadedBase64(data, mime) {
  const allowed = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  if (!allowed[mime]) throw new Error('Неподдерживаемый формат (только JPEG/PNG/WEBP)');
  const bytes = Buffer.from(String(data || ''), 'base64');
  if (!bytes.length || bytes.length > 6 * 1024 * 1024) throw new Error('Некорректный размер фото');
  const name = `p-${Date.now()}-${randomBytes(4).toString('hex')}${allowed[mime]}`;
  writeFileSync(join(UPLOADS_DIR, name), bytes);
  return `uploads/${name}`;
}

function orderText(order) {
  const labels = {
    new: '🆕 Новая заявка', confirmed: '✅ Принята', shipped: '📦 Отправлена',
    done: '🏁 Выполнена', cancelled: '❌ Отклонена',
  };
  const items = Array.isArray(order.items) ? order.items : [];
  const lines = ['🛍 <b>НОВАЯ ЗАЯВКА — DVIZH SHOP</b>', ''];
  if (order.public_id) lines.push(`🧾 Номер: <code>${escapeHtml(order.public_id)}</code>`);
  lines.push(`👤 Имя: ${escapeHtml(order.customer_name)}`);
  items.forEach((i) => {
    lines.push(`📦 Товар: ${escapeHtml(i.name)}`);
    lines.push(`🎨 Цвет: ${escapeHtml(i.color || '—')}`);
    lines.push(`📏 Размер: ${escapeHtml(i.size || '—')}`);
    lines.push(`🔢 Количество: ${i.qty}`);
    lines.push(`💶 Цена: ${money(i.price_cents * i.qty)} €`);
  });
  const contact = String(order.contact || '').trim();
  lines.push(`📞 Контакт: ${contact ? escapeHtml(contact) : 'не указан'}`);
  if (order.note) lines.push(`💬 Комментарий: ${escapeHtml(order.note)}`);
  if (items.length > 1) lines.push(`💰 Сумма: <b>${money(order.total_cents)} €</b>`);
  lines.push('', `Статус: <b>${labels[order.status] || labels.new}</b>`);
  return lines.join('\n');
}

function orderKeyboard(order) {
  const id = Number(order.id) || 0;
  return {
    inline_keyboard: [
      [{ text: '☑ Принять заявку', callback_data: `ost:${id}:confirmed` }],
      [{ text: '❌ Отклонить заявку', callback_data: `ost:${id}:cancelled` }],
      [{ text: '📋 Посмотреть подробности', callback_data: `o:${id}` }],
      [{ text: '📦 Отметить как выполненную', callback_data: `ost:${id}:done` }],
    ],
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = decodeURIComponent(url.pathname);

  try {
    // --- API ---------------------------------------------------------------
    if (path === '/health') return json(res, 200, { ok: true, time: new Date().toISOString() });

    if (path === '/api/catalog' && req.method === 'GET') {
      const data = publicCatalog();
      return send(res, 200, JSON.stringify(data), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=20', // быстрое обновление после правок из бота
      });
    }

    if (path === '/api/orders' && req.method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
      if (orderRateLimited(ip)) return json(res, 429, { error: 'Слишком много заказов. Попробуйте позже.' });
      const body = await readBody(req);
      try {
        const order = createOrder({
          customer_name: body.customer_name,
          contact: body.contact,
          note: body.note,
          delivery: body.delivery,
          idempotency_key: body.idempotency_key,
          items: body.items,
        });
        notifyAdmin(orderText(order), process.env.ADMIN_ID || getSetting('admin_id'), orderKeyboard(order)).catch(() => {});
        return json(res, 201, { ok: true, order: { public_id: order.public_id, total: order.total_cents } });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // --- admin API ---------------------------------------------------------
    if (path.startsWith('/api/admin/')) {
      if (!adminAuthorized(req, url)) return json(res, 401, { error: 'Не авторизован' });
      const parts = path.replace('/api/admin/', '').split('/');

      if (parts[0] === 'summary' && req.method === 'GET') {
        return json(res, 200, { stats: stats(), settings: getSettings() });
      }

      if (parts[0] === 'orders') {
        if (parts.length === 1 && req.method === 'GET') {
          return json(res, 200, { orders: listOrders({ status: url.searchParams.get('status') || null, limit: 100 }) });
        }
        if (parts.length === 2 && req.method === 'GET') {
          const o = getOrder(parts[1]);
          return o ? json(res, 200, { order: o }) : json(res, 404, { error: 'Заказ не найден' });
        }
        if (parts.length === 2 && req.method === 'PATCH') {
          const body = await readBody(req);
          try { return json(res, 200, { order: setOrderStatus(parts[1], body.status) }); }
          catch (e) { return json(res, 400, { error: e.message }); }
        }
      }

      if (parts[0] === 'products') {
        if (parts.length === 1 && req.method === 'GET') return json(res, 200, { products: listProducts() });
        if (parts.length === 1 && req.method === 'POST') {
          const body = await readBody(req);
          try { return json(res, 201, { product: createProduct(body) }); }
          catch (e) { return json(res, 400, { error: e.message }); }
        }
        if (parts.length === 2 && req.method === 'GET') {
          const p = getProduct(parts[1]);
          return p ? json(res, 200, { product: p }) : json(res, 404, { error: 'Товар не найден' });
        }
        if (parts.length === 2 && req.method === 'PATCH') {
          const body = await readBody(req);
          try { return json(res, 200, { product: updateProduct(parts[1], body) }); }
          catch (e) { return json(res, 400, { error: e.message }); }
        }
        if (parts.length === 2 && req.method === 'DELETE') {
          const p = getProduct(parts[1]);
          if (!p) return json(res, 404, { error: 'Товар не найден' });
          for (const ph of p.photos || []) {
            try { unlinkSync(photoAbsolutePath(ph.path)); } catch { /* файла нет */ }
          }
          deleteProduct(p.id);
          return json(res, 200, { ok: true });
        }
        if (parts.length === 3 && parts[2] === 'photos' && req.method === 'POST') {
          const body = await readBody(req, 9_000_000);
          try {
            if (!getProduct(parts[1])) return json(res, 404, { error: 'Товар не найден' });
            const p = saveUploadedBase64(body.data, body.mime);
            return json(res, 201, { photo: addProductPhoto(parts[1], p) });
          } catch (e) { return json(res, 400, { error: e.message }); }
        }
      }

      if (parts[0] === 'photos' && parts.length === 2 && req.method === 'DELETE') {
        const ph = getPhoto(parts[1]);
        if (!ph) return json(res, 404, { error: 'Фото не найдено' });
        try { unlinkSync(photoAbsolutePath(ph.path)); } catch { /* нет файла */ }
        deletePhoto(parts[1]);
        return json(res, 200, { ok: true });
      }

      if (parts[0] === 'collections') {
        if (parts.length === 1 && req.method === 'GET') return json(res, 200, { collections: listCollections() });
        if (parts.length === 1 && req.method === 'POST') {
          const body = await readBody(req);
          try { return json(res, 201, { collection: createCollection(body) }); }
          catch (e) { return json(res, 400, { error: e.message }); }
        }
        if (parts.length === 2 && req.method === 'PATCH') {
          const body = await readBody(req);
          try { return json(res, 200, { collection: updateCollection(parts[1], body) }); }
          catch (e) { return json(res, 400, { error: e.message }); }
        }
        if (parts.length === 2 && req.method === 'DELETE') {
          return deleteCollection(parts[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Коллекция не найдена' });
        }
      }

      if (parts[0] === 'banners') {
        if (parts.length === 1 && req.method === 'GET') return json(res, 200, { banners: listBanners() });
        if (parts.length === 1 && req.method === 'POST') {
          const body = await readBody(req, 9_000_000);
          try {
            if (body.image_base64) body.image_path = saveUploadedBase64(body.image_base64, body.image_mime || 'image/jpeg');
            return json(res, 201, { banner: createBanner(body) });
          } catch (e) { return json(res, 400, { error: e.message }); }
        }
        if (parts.length === 2 && req.method === 'PATCH') {
          const body = await readBody(req, 9_000_000);
          try {
            if (body.image_base64) body.image_path = saveUploadedBase64(body.image_base64, body.image_mime || 'image/jpeg');
            return json(res, 200, { banner: updateBanner(parts[1], body) });
          } catch (e) { return json(res, 400, { error: e.message }); }
        }
        if (parts.length === 2 && req.method === 'DELETE') {
          const b = getBanner(parts[1]);
          if (!b) return json(res, 404, { error: 'Баннер не найден' });
          if (b.image_path) {
            try { unlinkSync(photoAbsolutePath(b.image_path)); } catch { /* файла нет */ }
          }
          deleteBanner(b.id);
          return json(res, 200, { ok: true });
        }
      }

      if (parts[0] === 'settings') {
        if (parts.length === 1 && req.method === 'GET') return json(res, 200, { settings: getSettings() });
        if (parts.length === 1 && req.method === 'PATCH') {
          const body = await readBody(req);
          for (const [k, v] of Object.entries(body || {})) {
            if (/^[a-z_]{2,40}$/.test(k)) setSetting(k, String(v).slice(0, 2000));
          }
          return json(res, 200, { settings: getSettings() });
        }
      }

      return json(res, 404, { error: 'Неизвестный admin-метод' });
    }

    // --- статика -----------------------------------------------------------
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain; charset=utf-8' });

    let filePath;
    if (path.startsWith('/uploads/')) {
      filePath = normalize(join(UPLOADS_DIR, path.replace('/uploads/', '')));
      if (!filePath.startsWith(UPLOADS_DIR)) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
    } else {
      const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      filePath = normalize(join(PUBLIC_DIR, rel));
      if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      // SPA: неизвестный маршрут → index.html
      const index = join(PUBLIC_DIR, 'index.html');
      if (existsSync(index) && !extname(path)) {
        return send(res, 200, readFileSync(index), { 'Content-Type': 'text/html; charset=utf-8' });
      }
      return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    const ext = extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const cache = path.startsWith('/uploads/') ? 'public, max-age=86400' : (ext === '.html' ? 'no-cache' : 'public, max-age=300');
    return send(res, 200, readFileSync(filePath), { 'Content-Type': type, 'Cache-Control': cache });
  } catch (e) {
    log('http', `${req.method} ${path} → ${e.message}`);
    return json(res, 500, { error: 'Внутренняя ошибка сервера' });
  }
});

getDb();
server.listen(PORT, HOST, () => {
  log('server', `DVIZH FREIBURG shop запущен: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!ADMIN_TOKEN) log('server', '⚠️ ADMIN_TOKEN не задан — admin API отключён (бот работает напрямую с БД)');
});

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('server', `${signal}: остановка…`);
  const done = () => { closeDb(); process.exit(0); };
  server.close(done);
  setTimeout(done, 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
