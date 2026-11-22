// Безопасная работа с .env: чтение, слияние, атомарная запись, права доступа.
// Секреты никогда не логируются и не возвращаются наружу.
import {
  readFileSync, writeFileSync, renameSync, existsSync, chmodSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export function envPath() {
  return process.env.SETUP_ENV_FILE
    ? resolve(process.env.SETUP_ENV_FILE)
    : resolve(process.cwd(), '.env');
}

export function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

export function readEnv(path = envPath()) {
  if (!existsSync(path)) return {};
  try { return parseEnv(readFileSync(path, 'utf8')); } catch { return {}; }
}

function serialize(value) {
  const v = String(value == null ? '' : value);
  if (/[\s#"']/.test(v)) return '"' + v.replace(/"/g, '') + '"';
  return v;
}

// Обновляет только переданные ключи, сохраняя комментарии и порядок остальных строк.
export function writeEnv(updates, path = envPath()) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates).map(([k, v]) => [k, String(v == null ? '' : v)]));
  const result = [];

  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/i);
    if (m && pending.has(m[1])) {
      result.push(`${m[1]}=${serialize(pending.get(m[1]))}`);
      pending.delete(m[1]);
    } else {
      result.push(line);
    }
  }
  // убираем лишние пустые строки в конце, затем добавляем новые ключи
  while (result.length && result[result.length - 1].trim() === '') result.pop();
  if (pending.size) {
    if (result.length) result.push('');
    for (const [k, v] of pending) result.push(`${k}=${serialize(v)}`);
  }
  const text = result.join('\n') + '\n';

  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  hardenPermissions(path);
  return path;
}

// На POSIX — 600. На Windows — убираем наследование и оставляем доступ текущему пользователю.
export function hardenPermissions(path) {
  try { chmodSync(path, 0o600); } catch { /* Windows */ }
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    if (!user) return;
    try {
      spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], {
        windowsHide: true, stdio: 'ignore', timeout: 5000,
      });
    } catch { /* нет icacls — не критично */ }
  }
}

export function generateSecret(bytes = 24) {
  return randomBytes(bytes).toString('hex');
}

// Токен BotFather: <bot_id>:<35+ символов>
export function isValidBotToken(token) {
  const value = String(token || '').trim();
  return /^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(value) && !/\s/.test(value);
}

export function normalizeAdminId(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (!/^\d{5,20}$/.test(v)) return null;
  return v;
}
