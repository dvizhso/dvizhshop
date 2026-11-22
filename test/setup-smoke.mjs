// Проверка безопасной настройки: .env, проверка токена, локальный мастер.
// Реальный токен не используется — Telegram подменяется заглушкой.
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnv, writeEnv } from '../lib/envfile.mjs';
import { saveSetup, SetupError } from '../lib/setup.mjs';
import { startSetupServer } from '../scripts/setup-web.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dvizh-setup-'));
const envFile = join(dir, '.env');
process.env.SETUP_ENV_FILE = envFile;

const realFetch = globalThis.fetch;
const FAKE_TOKEN = '123456789:' + 'A'.repeat(35);
const checks = {};

function mockTelegram(mode) {
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.telegram.org')) {
      if (mode === 'ok') {
        return new Response(JSON.stringify({ ok: true, result: { id: 987654321, username: 'dvizh_secure_bot', first_name: 'DVIZH' } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };
}

try {
  // 1. .env: сохраняем комментарии и посторонние ключи
  writeFileSync(envFile, '# комментарий\nTELEGRAM_BOT_TOKEN=old\nADMIN_ID=111\n\n# ещё\nPORT=8080\n');
  writeEnv({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN, PORT: '8090' });
  const text = readFileSync(envFile, 'utf8');
  checks.commentPreserved = text.includes('# комментарий') && text.includes('# ещё');
  checks.tokenReplaced = readEnv(envFile).TELEGRAM_BOT_TOKEN === FAKE_TOKEN;
  checks.adminKept = readEnv(envFile).ADMIN_ID === '111';
  if (process.platform !== 'win32') {
    checks.permissions600 = (statSync(envFile).mode & 0o777) === 0o600;
  } else {
    checks.permissions600 = true;
  }

  // 2. неверный формат токена — отказ без записи
  let formatRejected = false;
  try { await saveSetup({ token: 'not-a-token' }, { verify: false }); }
  catch (e) { formatRejected = e instanceof SetupError; }
  checks.formatRejected = formatRejected;

  // 3. Telegram 401 — ошибка, токен не перезаписан
  mockTelegram('401');
  const before = readEnv(envFile).TELEGRAM_BOT_TOKEN;
  let unauthorizedRejected = false;
  try { await saveSetup({ token: FAKE_TOKEN }, { verify: true }); }
  catch (e) { unauthorizedRejected = e instanceof SetupError && /отклонил/.test(e.message); }
  checks.unauthorizedRejected = unauthorizedRejected;
  checks.tokenNotOverwrittenOnError = readEnv(envFile).TELEGRAM_BOT_TOKEN === before;

  // 4. успешное сохранение через saveSetup
  mockTelegram('ok');
  const saved = await saveSetup({ token: FAKE_TOKEN, adminId: '222333444', port: '8123', siteUrl: 'https://shop.example.com' });
  checks.savedUsername = saved.botUsername === 'dvizh_secure_bot';
  checks.savedAdmin = saved.adminId === '222333444';
  checks.savedPort = readEnv(envFile).PORT === '8123';
  checks.savedUrl = readEnv(envFile).SITE_URL === 'https://shop.example.com';
  checks.adminTokenGenerated = saved.adminTokenGenerated === true
    && Boolean(readEnv(envFile).ADMIN_TOKEN && readEnv(envFile).ADMIN_TOKEN.length >= 48);

  // 5. локальный мастер: страница, одноразовый ключ, POST, отсутствие токена в ответах
  const key = 'test-setup-key-123456';
  const instance = await startSetupServer({ port: 0, key, openBrowser: false, autoCloseOnSuccess: false, quiet: true });
  const pageRes = await realFetch(`${instance.url}`);
  const html = await pageRes.text();
  checks.pageServed = pageRes.status === 200 && html.includes('type="password"');
  checks.pageNoToken = !html.includes(FAKE_TOKEN);
  checks.pageNoKeyInHtml = !html.includes(key);

  const wrongKey = await realFetch(`http://127.0.0.1:${instance.port}/api/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Setup-Key': 'wrong' },
    body: JSON.stringify({ token: FAKE_TOKEN }),
  });
  checks.wrongKeyRejected = wrongKey.status === 403;

  const badToken = await realFetch(`http://127.0.0.1:${instance.port}/api/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Setup-Key': key },
    body: JSON.stringify({ token: 'bad-token', adminId: '', port: '8088', siteUrl: 'http://localhost:8088' }),
  });
  checks.badTokenRejected = badToken.status === 400;

  const okRes = await realFetch(`http://127.0.0.1:${instance.port}/api/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Setup-Key': key },
    body: JSON.stringify({ token: FAKE_TOKEN, adminId: '', port: '8088', siteUrl: 'http://localhost:8088' }),
  });
  const okBody = await okRes.json();
  const okText = JSON.stringify(okBody);
  checks.setupOk = okRes.status === 200 && okBody.ok === true && okBody.botUsername === 'dvizh_secure_bot';
  checks.responseNoToken = !okText.includes(FAKE_TOKEN);
  checks.oneTimeKey = (await realFetch(`http://127.0.0.1:${instance.port}/api/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Setup-Key': key },
    body: JSON.stringify({ token: FAKE_TOKEN }),
  })).status === 410;

  await instance.close();
} finally {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
}

const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(JSON.stringify({ checks, failed }, null, 2));
process.exit(failed.length ? 1 : 0);
