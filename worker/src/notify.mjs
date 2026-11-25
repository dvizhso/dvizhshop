// Отдельный модуль Telegram-уведомлений.
// Заявка сначала попадает в D1, затем в notify_queue. Если Telegram недоступен,
// запись остаётся в очереди и Worker повторяет отправку по расписанию (scheduled).
import { all, first, run, getOrder } from './db.mjs';
import { tg, hasBot, orderMessage, orderKeyboard, buyerStatusMessage } from './telegram.mjs';

const MAX_ATTEMPTS = 10;

// Бот строго личный: получатель берётся только из секрета ADMIN_ID.
export function ownerId(env) {
  const id = String(env.ADMIN_ID || '').trim();
  return /^\d{1,20}$/.test(id) ? id : '';
}

export function notificationsConfigured(env) {
  return hasBot(env) && Boolean(ownerId(env));
}

// Поставить заявку в очередь (идемпотентно: одна строка на заявку).
export async function enqueueNotification(env, orderId) {
  await run(env, `INSERT INTO notify_queue (order_id)
    SELECT id FROM orders WHERE id = ?
    AND NOT EXISTS (SELECT 1 FROM notify_queue WHERE order_id = orders.id)`,
  Number(orderId) || 0);
}

async function markSent(env, queueId) {
  await run(env, "UPDATE notify_queue SET sent_at = datetime('now'), last_error = NULL WHERE id = ?", queueId);
}

async function markFailed(env, queueId, attempts, error) {
  await run(env,
    'UPDATE notify_queue SET attempts = ?, last_error = ? WHERE id = ?',
    attempts, String(error || '').slice(0, 400), queueId);
}

// Отправляет все готовые к отправке уведомления. Возвращает сводку для тестов и логов.
export async function flushNotifications(env, { limit = 10, orderId = null } = {}) {
  const result = { sent: 0, failed: 0, skipped: 0, reason: '', errors: [] };
  if (!hasBot(env)) { result.reason = 'TELEGRAM_BOT_TOKEN не задан'; return result; }
  const chatId = ownerId(env);
  if (!chatId) { result.reason = 'ADMIN_ID не задан'; return result; }

  const params = [MAX_ATTEMPTS];
  let sql = `SELECT id AS queue_id, order_id, attempts FROM notify_queue
    WHERE sent_at IS NULL AND attempts < ?`;
  if (orderId) { sql += ' AND order_id = ?'; params.push(Number(orderId)); }
  sql += ' ORDER BY id LIMIT ?';
  params.push(Math.max(1, Math.min(50, Number(limit) || 10)));

  const pending = await all(env, sql, ...params);
  for (const row of pending) {
    // Захватываем строку атомарно: cron и мгновенная отправка не отправят дважды.
    const claimed = await run(env,
      'UPDATE notify_queue SET attempts = attempts + 1 WHERE id = ? AND sent_at IS NULL AND attempts = ?',
      row.queue_id, Number(row.attempts || 0));
    if (!Number(claimed?.meta?.changes || 0)) { result.skipped += 1; continue; }

    const order = await getOrder(env, row.order_id);
    if (!order) {
      await markSent(env, row.queue_id);
      result.skipped += 1;
      continue;
    }
    try {
      const sent = await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: orderMessage(order),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: orderKeyboard(order),
      });
      if (sent && sent.message_id) {
        await run(env, 'UPDATE orders SET tg_message_id = ? WHERE id = ?', Number(sent.message_id), order.id);
      }
      await markSent(env, row.queue_id);
      result.sent += 1;
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      await markFailed(env, row.queue_id, attempts, error?.message || error);
      result.failed += 1;
      result.errors.push(String(error?.message || error));
    }
  }
  return result;
}

// Заявка уже поставлена в очередь в той же транзакции, что и заказ.
// Здесь только пробуем отправить её сразу. Ошибки не выбрасываются:
// заявка сохранена, а очередь догонит отправку позже.
export async function notifyNewOrder(env, orderId) {
  try {
    return await flushNotifications(env, { orderId, limit: 1 });
  } catch (error) {
    console.error('[notify] immediate send failed:', error?.message || error);
    return { sent: 0, failed: 1, skipped: 0, reason: '', errors: [String(error?.message || error)] };
  }
}

export async function pendingNotificationCount(env) {
  const row = await first(env,
    'SELECT COUNT(*) AS c FROM notify_queue WHERE sent_at IS NULL AND attempts < ?', MAX_ATTEMPTS);
  return Number(row?.c || 0);
}

// Уведомление покупателю о смене статуса. Отправляем только если он сам
// запустил бота по ссылке из оформления заказа. Ошибки (заблокировал бота,
// не начинал диалог) не должны ломать смену статуса.
export async function notifyBuyerStatus(env, order) {
  if (!order || !order.tg_chat_id || !hasBot(env)) return false;
  if (String(order.tg_chat_id) === ownerId(env)) return false;
  try {
    await tg(env, 'sendMessage', {
      chat_id: order.tg_chat_id,
      text: buyerStatusMessage(order),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return true;
  } catch (error) {
    console.error('[notify] buyer status failed:', error?.message || error);
    return false;
  }
}
