// Общие утилиты: env, логи, деньги, слаги, безопасный fetch.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// .env рядом с проектом (в проде — переменные окружения)
export function loadEnv(file = '.env') {
  try {
    const raw = readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch { /* .env не обязателен */ }
}

export function log(tag, ...parts) {
  console.log(`[${new Date().toISOString()}] [${tag}]`, ...parts);
}

// Деньги: центы → "55.00"
export function money(cents) {
  return (Math.round(Number(cents) || 0) / 100).toFixed(2);
}

// "55", "55.50", "55,50", "55 €" → 5500 центов
export function parsePriceToCents(input) {
  const s = String(input).replace(/\s/g, '').replace(',', '.').replace(/[^\d.]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  return Math.round(n * 100);
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya', є: 'ye', і: 'i', ї: 'yi', ґ: 'g',
};

export function slugify(text) {
  const base = String(text || '')
    .toLowerCase()
    .split('').map((ch) => TRANSLIT[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'item';
}

export function publicId() {
  return Date.now().toString(36).toUpperCase() + randomBytes(3).toString('hex').toUpperCase();
}

export function normList(input, fallback = '') {
  const parts = String(input || '')
    .split(/[,;/]+/).map((x) => x.trim()).filter(Boolean)
    .slice(0, 20);
  return parts.length ? parts.join(',') : fallback;
}

export function splitList(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

// fetch JSON с таймаутом и предохранителем размера
export async function fetchJson(url, opts = {}, timeoutMs = 20000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, data };
}

export function constantTimeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
