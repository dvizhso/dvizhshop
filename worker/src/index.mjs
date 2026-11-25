// DVIZH FREIBURG — Cloudflare Worker.
// Публичный API для GitHub Pages, приём заказов, Telegram-уведомления,
// защищённый admin API и опциональное хранение фото в R2.
import {
  ensureSchema, publicCatalog, createOrder, getSetting, getSettings, setSetting,
  listProducts, getProduct, createProduct, updateProduct, deleteProduct,
  addProductPhoto, getPhoto, deletePhoto,
  listCollections, getCollection, createCollection, updateCollection, deleteCollection,
  listBanners, getBanner, createBanner, updateBanner, deleteBanner,
  listOrders, getOrder, setOrderStatus, stats, ORDER_STATUSES,
  RateLimitError, OutOfStockError,
} from './db.mjs';
import { notifyNewOrder, flushNotifications, notificationsConfigured, pendingNotificationCount, notifyBuyerStatus } from './notify.mjs';
import { handleUpdate, setWebhook } from './bot.mjs';
import { hasBot, tg } from './telegram.mjs';

const MAX_BODY = 1_000_000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...CORS,
      ...extra,
    },
  });
}

function html(text, status = 200) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...CORS },
  });
}

function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY) throw new Error('Слишком большой запрос');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('Слишком большой запрос');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error('Некорректный JSON'); }
}

function adminAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  return safeEqual(request.headers.get('X-Admin-Token') || '', env.ADMIN_TOKEN);
}

// Хранилище фото необязательно. Когда биндинг BUCKET подключён, код работает
// как раньше; без него заказы, каталог и бот продолжают работать нормально.
export class PhotoStorageError extends Error {}

function photosEnabled(env) {
  return Boolean(env.BUCKET);
}

function imageExtension(mime) {
  return { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[mime] || null;
}

async function savePhoto(env, data, mime) {
  const ext = imageExtension(mime);
  if (!ext) throw new Error('Неподдерживаемый формат (только JPEG/PNG/WEBP)');
  if (!photosEnabled(env)) throw new PhotoStorageError('Хранение фото не подключено');
  let bytes;
  try { bytes = Uint8Array.from(atob(String(data || '')), (c) => c.charCodeAt(0)); }
  catch { throw new Error('Некорректное фото'); }
  if (!bytes.length || bytes.length > 6 * 1024 * 1024) throw new Error('Некорректный размер фото');
  const key = `uploads/p-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`;
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
  return key;
}

async function deletePhotoObject(env, path) {
  if (!photosEnabled(env) || !path) return; // без бакета просто чистим запись в БД
  try { await env.BUCKET.delete(String(path).replace(/^\/+/, '')); } catch { /* уже нет */ }
}

async function handleAdmin(request, env, url, path) {
  if (!adminAuthorized(request, env)) return json({ error: 'Не авторизован' }, 401);
  const parts = path.replace('/api/admin/', '').split('/');
  const method = request.method;

  if (parts[0] === 'summary' && method === 'GET') {
    return json({ stats: await stats(env), settings: await getSettings(env) });
  }

  if (parts[0] === 'orders') {
    if (parts.length === 1 && method === 'GET') {
      return json({ orders: await listOrders(env, { status: url.searchParams.get('status') || null, limit: 100 }) });
    }
    if (parts.length === 2 && method === 'GET') {
      const order = await getOrder(env, parts[1]);
      return order ? json({ order }) : json({ error: 'Заказ не найден' }, 404);
    }
    if (parts.length === 2 && method === 'PATCH') {
      const body = await readJson(request);
      if (!ORDER_STATUSES.includes(body.status)) return json({ error: 'Неизвестный статус' }, 400);
      const order = await setOrderStatus(env, parts[1], body.status);
      await notifyBuyerStatus(env, order);
      return json({ order });
    }
  }

  if (parts[0] === 'products') {
    if (parts.length === 1 && method === 'GET') {
      return json({ products: await listProducts(env) });
    }
    if (parts.length === 1 && method === 'POST') {
      const body = await readJson(request);
      return json({ product: await createProduct(env, body) }, 201);
    }
    if (parts.length === 2 && method === 'GET') {
      const product = await getProduct(env, parts[1]);
      return product ? json({ product }) : json({ error: 'Товар не найден' }, 404);
    }
    if (parts.length === 2 && method === 'PATCH') {
      const body = await readJson(request);
      return json({ product: await updateProduct(env, parts[1], body) });
    }
    if (parts.length === 2 && method === 'DELETE') {
      const product = await getProduct(env, parts[1]);
      if (product) for (const photo of product.photos || []) await deletePhotoObject(env, photo.path);
      return json({ ok: await deleteProduct(env, parts[1]) });
    }
    if (parts.length === 3 && parts[2] === 'photos' && method === 'POST') {
      const product = await getProduct(env, parts[1]);
      if (!product) return json({ error: 'Товар не найден' }, 404);
      const body = await readJson(request);
      try {
        const key = await savePhoto(env, body.data, body.mime);
        const photo = await addProductPhoto(env, product.id, key);
        return json({ photo }, 201);
      } catch (error) {
        if (error instanceof PhotoStorageError) {
          return json({ error: 'Хранение фото не подключено. Добавьте R2-биндинг BUCKET в wrangler.toml.' }, 503);
        }
        throw error;
      }
    }
  }

  if (parts[0] === 'photos' && parts.length === 2 && method === 'DELETE') {
    const photo = await getPhoto(env, parts[1]);
    if (!photo) return json({ error: 'Фото не найдено' }, 404);
    await deletePhotoObject(env, photo.path);
    return json({ ok: await deletePhoto(env, photo.id) });
  }

  if (parts[0] === 'collections') {
    if (parts.length === 1 && method === 'GET') return json({ collections: await listCollections(env) });
    if (parts.length === 1 && method === 'POST') return json({ collection: await createCollection(env, await readJson(request)) }, 201);
    if (parts.length === 2 && method === 'GET') {
      const collection = await getCollection(env, parts[1]);
      return collection ? json({ collection }) : json({ error: 'Коллекция не найдена' }, 404);
    }
    if (parts.length === 2 && method === 'PATCH') return json({ collection: await updateCollection(env, parts[1], await readJson(request)) });
    if (parts.length === 2 && method === 'DELETE') return json({ ok: await deleteCollection(env, parts[1]) });
  }

  if (parts[0] === 'banners') {
    if (parts.length === 1 && method === 'GET') return json({ banners: await listBanners(env) });
    if (parts.length === 1 && method === 'POST') return json({ banner: await createBanner(env, await readJson(request)) }, 201);
    if (parts.length === 2 && method === 'GET') {
      const banner = await getBanner(env, parts[1]);
      return banner ? json({ banner }) : json({ error: 'Баннер не найден' }, 404);
    }
    if (parts.length === 2 && method === 'PATCH') return json({ banner: await updateBanner(env, parts[1], await readJson(request)) });
    if (parts.length === 2 && method === 'DELETE') {
      const banner = await getBanner(env, parts[1]);
      if (banner?.image_path) await deletePhotoObject(env, banner.image_path);
      return json({ ok: await deleteBanner(env, parts[1]) });
    }
  }

  if (parts[0] === 'settings' && parts.length === 1) {
    if (method === 'GET') return json({ settings: await getSettings(env) });
    if (method === 'PATCH') {
      const body = await readJson(request);
      for (const [key, value] of Object.entries(body)) {
        if (/^[a-z_]{1,40}$/i.test(key)) await setSetting(env, key, String(value ?? ''));
      }
      return json({ settings: await getSettings(env) });
    }
  }

  // Регистрация webhook бота и ручной догон очереди уведомлений.
  if (parts[0] === 'telegram') {
    if (parts[1] === 'webhook' && method === 'POST') {
      if (!env.TELEGRAM_BOT_TOKEN) return json({ error: 'TELEGRAM_BOT_TOKEN не задан' }, 400);
      if (!env.TELEGRAM_WEBHOOK_SECRET) return json({ error: 'TELEGRAM_WEBHOOK_SECRET не задан' }, 400);
      if (!notificationsConfigured(env)) return json({ error: 'ADMIN_ID не задан' }, 400);
      const body = await readJson(request);
      const base = String(body.url || url.origin).replace(/\/+$/, '');
      const result = await setWebhook(env, base, env.TELEGRAM_WEBHOOK_SECRET);
      // Запоминаем username бота, чтобы сайт мог дать покупателю ссылку на подписку.
      let botUsername = '';
      try {
        const me = await tg(env, 'getMe', {});
        botUsername = String(me?.username || '');
        if (botUsername) await setSetting(env, 'bot_username', botUsername);
      } catch (error) {
        console.error('[bot] getMe failed:', error?.message || error);
      }
      return json({ ok: true, webhook: result, url: `${base}/telegram/webhook`, bot: botUsername ? `@${botUsername}` : '' });
    }
    if (parts[1] === 'retry' && method === 'POST') {
      return json({ ok: true, ...(await flushNotifications(env, { limit: 25 })) });
    }
  }

  return json({ error: 'Not Found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const method = request.method;

    try {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

      if (path === '/' ) {
        return html(`<!doctype html><meta charset="utf-8"><title>DVIZH FREIBURG API</title>
          <body style="font:16px system-ui;background:#0b0b0a;color:#f4f2e9;padding:40px">
          <h1>DVIZH FREIBURG API</h1><p>Сервер работает.</p>
          <p><a style="color:#f3d21b" href="/api/catalog">/api/catalog</a> · <a style="color:#f3d21b" href="/health">/health</a></p></body>`);
      }

      if (path === '/health') {
        await ensureSchema(env);
        return json({
          ok: true,
          time: new Date().toISOString(),
          telegram: notificationsConfigured(env),
          bot: hasBot(env),
          photos: photosEnabled(env),
          pendingNotifications: await pendingNotificationCount(env),
        });
      }

      // Telegram присылает сюда обновления. Проверяем секретный заголовок,
      // чтобы посторонние не могли подделать сообщения боту.
      if (path === '/telegram/webhook' && method === 'POST') {
        const secret = String(env.TELEGRAM_WEBHOOK_SECRET || '');
        const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
        if (!secret || !safeEqual(got, secret)) return json({ ok: false }, 401);
        let update;
        try { update = await readJson(request); } catch { return json({ ok: false }, 400); }
        ctx.waitUntil(handleUpdate(env, update).catch((error) => {
          console.error('[bot]', error?.message || error);
        }));
        return json({ ok: true });
      }

      if (path === '/api/catalog' && method === 'GET') {
        const data = await publicCatalog(env);
        return json(data, 200, { 'Cache-Control': 'public, max-age=15' });
      }

      if (path === '/api/orders' && method === 'POST') {
        const body = await readJson(request);
        const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
        try {
          const order = await createOrder(env, body, ip.split(',')[0].trim());
          // Заявка уже сохранена и поставлена в очередь. Отправку не ждём,
          // чтобы покупатель не зависел от доступности Telegram.
          ctx.waitUntil(notifyNewOrder(env, order.id).catch((error) => {
            console.error('[notify]', error?.message || error);
          }));
          return json({ ok: true, order: { public_id: order.public_id, total: order.total_cents } }, 201);
        } catch (error) {
          if (error instanceof RateLimitError) return json({ error: error.message }, 429);
          if (error instanceof OutOfStockError) return json({ error: error.message }, 409);
          return json({ error: error.message || 'Не удалось оформить заказ' }, 400);
        }
      }

      if (path.startsWith('/uploads/') && method === 'GET') {
        if (!photosEnabled(env)) return json({ error: 'Хранение фото не подключено' }, 503);
        const key = path.slice(1);
        const object = await env.BUCKET.get(key);
        if (!object) return json({ error: 'Фото не найдено' }, 404);
        return new Response(object.body, {
          headers: {
            'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Content-Type-Options': 'nosniff',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      if (path.startsWith('/api/admin/')) return await handleAdmin(request, env, url, path);

      return json({ error: 'Not Found' }, 404);
    } catch (error) {
      console.error('[worker]', error.message);
      return json({ error: error.message || 'Внутренняя ошибка' }, 500);
    }
  },

  // Cron Trigger: повторяем отправку заявок, которые не удалось отправить сразу.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(flushNotifications(env, { limit: 25 }).then((summary) => {
      if (summary.failed || summary.reason) console.error('[notify] retry', JSON.stringify(summary));
    }).catch((error) => {
      console.error('[notify] retry failed:', error?.message || error);
    }));
  },
};
