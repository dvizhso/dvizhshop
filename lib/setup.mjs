// Проверка токена у Telegram и безопасное сохранение настроек в .env.
// Токен никогда не возвращается вызывающему коду и не попадает в логи.
import {
  envPath, readEnv, writeEnv, generateSecret, isValidBotToken, normalizeAdminId,
} from './envfile.mjs';

export class SetupError extends Error {
  constructor(message, code = 'setup_error') {
    super(message);
    this.name = 'SetupError';
    this.code = code;
  }
}

export async function verifyBotToken(token, { timeoutMs = 15000 } = {}) {
  const value = String(token || '').trim();
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${value}/getMe`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new SetupError('Не удалось связаться с Telegram. Проверьте интернет и попробуйте ещё раз.', 'network');
  }

  let data = {};
  try { data = await res.json(); } catch { /* не JSON */ }

  if (data && data.ok && data.result && data.result.username) {
    return {
      id: Number(data.result.id) || 0,
      username: String(data.result.username),
      name: String(data.result.first_name || ''),
    };
  }
  if (res.status === 401 || (data && data.error_code === 401)) {
    throw new SetupError('Telegram отклонил токен. Скопируйте его из @BotFather целиком и попробуйте снова.', 'invalid_token');
  }
  throw new SetupError(
    `Telegram вернул ошибку ${(data && data.error_code) || res.status}. Проверьте токен и попробуйте ещё раз.`,
    'telegram_error',
  );
}

export async function saveSetup(input, { verify = true, path = envPath() } = {}) {
  const token = String(input?.token || '').trim();
  if (!isValidBotToken(token)) {
    throw new SetupError('Это не похоже на токен Telegram-бота. Формат: 123456789:AA…', 'invalid_format');
  }

  const adminId = normalizeAdminId(input?.adminId);
  if (adminId === null) {
    throw new SetupError('Telegram ID должен состоять только из цифр.', 'invalid_admin_id');
  }

  const port = Number(input?.port || 8088);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SetupError('Порт должен быть целым числом от 1 до 65535.', 'invalid_port');
  }

  const siteUrl = String(input?.siteUrl || `http://localhost:${port}`).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(siteUrl)) {
    throw new SetupError('Адрес сайта должен начинаться с http:// или https://', 'invalid_site_url');
  }

  const bot = verify ? await verifyBotToken(token) : null;
  const current = readEnv(path);
  const adminToken = current.ADMIN_TOKEN && current.ADMIN_TOKEN.length >= 24
    ? current.ADMIN_TOKEN
    : generateSecret(24);

  const updates = {
    TELEGRAM_BOT_TOKEN: token,
    ADMIN_TOKEN: adminToken,
    PORT: String(port),
    SITE_URL: siteUrl,
  };
  if (adminId) updates.ADMIN_ID = adminId;
  else if (current.ADMIN_ID) updates.ADMIN_ID = current.ADMIN_ID;

  writeEnv(updates, path);

  return {
    path,
    botId: bot ? bot.id : 0,
    botUsername: bot ? bot.username : '',
    adminId: updates.ADMIN_ID || '',
    adminTokenGenerated: !(current.ADMIN_TOKEN && current.ADMIN_TOKEN.length >= 24),
    siteUrl,
    port,
  };
}
