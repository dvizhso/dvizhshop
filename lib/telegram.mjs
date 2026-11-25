// Telegram Bot API: минимальная обёртка без зависимостей.
import { log } from './core.mjs';

const API_BASE = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

export function botTokenPresent() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

async function call(method, params = {}, timeoutMs = 40000, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.min(4000, 1200 * attempt)));
    try {
      const res = await fetch(`${API_BASE()}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json();
      if (data.ok) return data.result;
      const err = new Error(`Telegram ${method}: ${data.error_code} ${data.description}`);
      err.code = data.error_code;
      err.retryAfter = (data.parameters && data.parameters.retry_after) || 0;
      if (err.code === 429) {
        await new Promise((r) => setTimeout(r, (err.retryAfter || 2) * 1000));
        lastErr = err;
        continue;
      }
      if (err.code >= 500) { lastErr = err; continue; }
      throw err;
    } catch (e) {
      if (e.code && e.code !== 429 && e.code < 500) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error(`Telegram ${method}: все попытки неудачны`);
}

export const getMe = () => call('getMe', {});
export const getUpdates = (params) => call('getUpdates', params, (Number(params.timeout) || 0) * 1000 + 20000);
export const sendMessage = (params) => call('sendMessage', params);
export const editMessageText = (params) => call('editMessageText', params);
export const editMessageReplyMarkup = (params) => call('editMessageReplyMarkup', params);
export const answerCallbackQuery = (params) => call('answerCallbackQuery', params);
export const deleteMessage = (params) => call('deleteMessage', params);
export const getFile = (fileId) => call('getFile', { file_id: fileId });

// Скачать файл (фото) по file_id → Buffer
export async function downloadFile(fileId, timeoutMs = 60000) {
  const info = await getFile(fileId);
  const path = info.file_path;
  const res = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Скачивание файла: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Файл больше 8 МБ');
  return { bytes, path };
}

// Уведомление администратора о новом заказе (HTML). Можно передать inline-кнопки.
export async function notifyAdmin(text, adminId = '', replyMarkup = null) {
  const admin = String(adminId || process.env.ADMIN_ID || '').trim();
  if (!admin) { log('notify', 'ADMIN_ID не задан — уведомление пропущено'); return false; }
  try {
    await sendMessage({
      chat_id: admin,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    return true;
  } catch (e) {
    log('notify', `не удалось отправить уведомление: ${e.message}`);
    return false;
  }
}
