// Серверная проверка Telegram WebApp initData.
// Данные с frontend NEVER не считаем доверенными: подпись проверяется
// HMAC-SHA256 с токеном бота из секретов Worker.
const encoder = new TextEncoder();

async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data));
}

function constantTimeEqual(a, b) {
  if (String(a).length !== String(b).length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function validateInitData(env, rawInitData, maxAgeSeconds = 86400) {
  const initData = String(rawInitData || '');
  if (!initData || !env.TELEGRAM_BOT_TOKEN) return { ok: false, reason: 'нет данных или токена' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'нет подписи' };

  const check = [];
  for (const [key, value] of params.entries()) {
    if (key !== 'hash') check.push(`${key}=${value}`);
  }
  check.sort();

  const secretKey = await hmac(encoder.encode(env.TELEGRAM_BOT_TOKEN), encoder.encode('WebAppData'));
  const signature = await hmac(secretKey, encoder.encode(check.join('\n')));
  const hex = Array.from(signature, (b) => b.toString(16).padStart(2, '0')).join('');
  if (!constantTimeEqual(hex, hash.toLowerCase())) return { ok: false, reason: 'неверная подпись' };

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > maxAgeSeconds) {
    return { ok: false, reason: 'устаревшие данные' };
  }

  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { /* ignore */ }
  if (!user || !Number(user.id)) return { ok: false, reason: 'нет пользователя' };

  return {
    ok: true,
    user: {
      id: Number(user.id),
      username: String(user.username || ''),
      first_name: String(user.first_name || ''),
    },
    authDate,
  };
}
