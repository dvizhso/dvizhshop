// Telegram Bot API для Cloudflare Worker.
// Токен берётся только из секретов Worker и никогда не возвращается наружу.
import { STATUS_LABELS, DELIVERY_LABELS } from './db.mjs';

export function hasBot(env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

export async function tg(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не задан');
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    const desc = data && data.description ? data.description : `HTTP ${res.status}`;
    const error = new Error(`Telegram ${method}: ${desc}`);
    error.retryAfter = Number(data?.parameters?.retry_after || 0) || 0;
    throw error;
  }
  return data.result;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function money(cents) {
  const n = Number(cents || 0) / 100;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.new;
}

export function orderNo(order) {
  return String(order?.id || 0).padStart(5, '0');
}

// Время из D1 приходит в UTC строкой "YYYY-MM-DD HH:MM:SS".
export function formatOrderTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const date = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return raw;
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Berlin',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(date) + ' (Берлин)';
  } catch {
    return date.toISOString();
  }
}

function telegramHandle(contact) {
  const value = String(contact || '').trim();
  const direct = /^@([A-Za-z0-9_]{3,32})$/.exec(value);
  if (direct) return `@${direct[1]}`;
  const link = /(?:^|\/\/|\.)t\.me\/([A-Za-z0-9_]{3,32})/i.exec(value);
  if (link) return `@${link[1]}`;
  return '';
}

// Кнопки под уведомлением о заявке. Данные callback разбирает bot.mjs.
export function orderKeyboard(order) {
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

// Полное уведомление владельцу о новой заявке.
export function orderMessage(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const contact = String(order.contact || '').trim();
  const handle = telegramHandle(contact);

  const lines = [
    '🛍 <b>НОВЫЙ ЗАКАЗ — DVIZH SHOP</b>',
    '',
    `📦 Заказ №: <b>${orderNo(order)}</b>`,
    `👤 Покупатель: ${escapeHtml(order.customer_name)}`,
  ];
  if (handle) lines.push(`🔗 Telegram: ${escapeHtml(handle)}`);

  lines.push('', '📋 <b>Товары:</b>');
  items.forEach((item, index) => {
    lines.push(`${index + 1}. <b>${escapeHtml(item.name)}</b>`);
    if (item.size) lines.push(`   📏 Размер: ${escapeHtml(item.size)}`);
    if (item.color) lines.push(`   🎨 Цвет: ${escapeHtml(item.color)}`);
    lines.push(`   🔢 Количество: ${Number(item.qty) || 0}`);
    lines.push(`   💶 Цена: ${money(item.price_cents)} €${Number(item.qty) > 1 ? ' за штуку' : ''}`);
  });

  lines.push('', `💰 <b>Общая сумма: ${money(order.total_cents)} €</b>`);
  if (order.delivery) lines.push(`📍 Способ получения: ${DELIVERY_LABELS[order.delivery] || escapeHtml(order.delivery)}`);
  lines.push(`📞 Контакт покупателя: ${contact ? escapeHtml(contact) : 'не указан'}`);
  if (order.note) lines.push(`💬 Комментарий: ${escapeHtml(order.note)}`);
  if (order.created_at) lines.push(`🕒 Время оформления: ${escapeHtml(formatOrderTime(order.created_at))}`);

  lines.push('', `Статус: <b>${statusLabel(order.status)}</b>`);
  return lines.join('\n');
}

// Короткое сообщение покупателю, который запустил бота по ссылке из заказа.
export function buyerStatusMessage(order) {
  const lines = [
    '🛍 <b>DVIZH SHOP</b> — статус заказа',
    '',
    `📦 Заказ №: <b>${orderNo(order)}</b>`,
    `Статус: <b>${statusLabel(order.status)}</b>`,
    '',
  ];
  if (order.status === 'cancelled') lines.push('Заявка отклонена. Если это ошибка — напишите нам в ответ на это сообщение.');
  else if (order.status === 'done') lines.push('Заказ выполнен. Спасибо, что выбрал DVIZH FREIBURG!');
  else lines.push('Спасибо! Мы свяжемся с тобой, если понадобится уточнение.');
  return lines.join('\n');
}

export async function notifyAdmin(env, text, chatId, replyMarkup = null) {
  if (!hasBot(env)) return false;
  const id = chatId || env.ADMIN_ID || '';
  if (!id) return false;
  await tg(env, 'sendMessage', {
    chat_id: id,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return true;
}
