// Локальный мастер настройки: одноразовая страница только на 127.0.0.1.
// Токен бота вводится здесь и сохраняется в .env; наружу не передаётся.
// Запуск: npm run setup
import { createServer } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEnv, envPath } from '../lib/envfile.mjs';
import { saveSetup, SetupError } from '../lib/setup.mjs';

const MAX_BODY = 32 * 1024;
const MAX_ATTEMPTS = 8;

function sameKey(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

function isLoopback(req) {
  const addr = String(req.socket.remoteAddress || '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function hostAllowed(req) {
  const host = String(req.headers.host || '');
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host);
}

function page(hasToken) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>DVIZH FREIBURG — безопасная настройка</title>
<style>
:root{--bg:#0b0b0a;--panel:#141412;--line:#343329;--line2:#55513b;--ink:#f4f2e9;--muted:#a8a596;--muted2:#7c7a6e;--yellow:#f3d21b}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background-color:var(--bg);background-image:radial-gradient(#ffffff0b .7px,transparent .7px);background-size:5px 5px;color:var(--ink);font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5}
.wrap{width:100%;max-width:560px}
.brand{display:flex;align-items:baseline;gap:7px;font-weight:950;letter-spacing:2.6px;font-size:15px;margin-bottom:22px}
.brand b{color:var(--yellow)}.brand i{font-style:normal;color:var(--muted2);font-size:9px;transform:translateY(-6px)}
.card{border:1px solid var(--line2);border-radius:8px;background:#11110e;padding:26px 22px;box-shadow:0 30px 80px #0008}
.eyebrow{display:inline-block;background:var(--yellow);color:#111;font-size:9px;font-weight:950;letter-spacing:2px;padding:5px 8px;transform:rotate(-1deg);margin-bottom:16px}
h1{margin:0 0 10px;font-size:clamp(30px,7vw,44px);line-height:.9;letter-spacing:-.04em;text-transform:uppercase;font-weight:1000}
h1 span{color:var(--yellow)}
.lead{margin:0 0 20px;color:var(--muted);font-size:12.5px;line-height:1.65}
label{display:grid;gap:6px;margin-bottom:14px}
label>span{font-size:9px;letter-spacing:1.3px;text-transform:uppercase;font-weight:900;color:var(--muted)}
label>span em{color:var(--yellow);font-style:normal}
.field{position:relative;display:flex;align-items:stretch}
input{width:100%;padding:12px 13px;border:1px solid #3a3a32;border-radius:4px;background:#171713;color:var(--ink);outline:none;font:inherit;font-size:13px;transition:border-color .16s}
input:focus{border-color:var(--yellow)}
input::placeholder{color:#5e5c50}
.eye{flex:0 0 auto;margin-left:6px;border:1px solid #3a3a32;background:#171713;color:var(--muted);border-radius:4px;padding:0 10px;font-size:9px;font-weight:900;letter-spacing:.8px}
.eye:hover{color:var(--yellow);border-color:var(--yellow)}
.hint{font-size:10px;line-height:1.5;color:var(--muted2);margin:-6px 0 14px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:460px){.row{grid-template-columns:1fr}}
button.submit{width:100%;margin-top:6px;border:0;border-radius:4px;background:var(--yellow);color:#111;padding:13px 16px;font-size:11px;font-weight:950;letter-spacing:1.2px;text-transform:uppercase;box-shadow:3px 3px 0 #766718;cursor:pointer}
button.submit:hover{background:#ffe23e}
button.submit:disabled{opacity:.55;cursor:wait;box-shadow:none}
.status{margin-top:14px;border-radius:4px;padding:10px 12px;font-size:11.5px;line-height:1.55;display:none}
.status.show{display:block}
.status.err{border:1px solid #6d2a22;background:#2a1210;color:#ffb3a8}
.status.ok{border:1px solid #3f5a32;background:#141d10;color:#c9e3b6}
.status.warn{border:1px solid #6b622a;background:#1e1b0d;color:#e8dc9a}
.note{margin-top:16px;border-top:1px solid #2a2921;padding-top:13px;font-size:10px;line-height:1.6;color:var(--muted2)}
.note b{color:var(--muted)}
code{font-family:"JetBrains Mono",Consolas,monospace;background:#1b1b16;border:1px solid #2f2e26;border-radius:3px;padding:1px 5px;font-size:10.5px;color:#e8e4cf}
.steps{margin:14px 0 0;padding:0;list-style:none;display:grid;gap:7px}
.steps li{display:flex;gap:8px;font-size:11.5px;color:var(--muted)}
.steps b{color:var(--yellow);font-family:Consolas,monospace}
.bot{font-size:13px;color:var(--yellow);font-weight:900;letter-spacing:.5px}
.hidden{display:none!important}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">DVIZH <b>FREIBURG</b> <i>®</i></div>
  <section class="card">
    <div class="eyebrow">SECURE SETUP · LOCAL ONLY</div>
    <h1>ПОДКЛЮЧИМ<br><span>БОТА.</span></h1>
    <p class="lead">Вставьте токен бота из <b>@BotFather</b>. Он сохранится только на этом компьютере в файл <code>.env</code> и будет отправлен лишь в Telegram для проверки. В чат, код сайта или репозиторий токен не попадает.</p>
    ${hasToken ? '<div class="status warn show">Токен уже сохранён. Вставьте новый, чтобы заменить его.</div>' : ''}

    <form id="form" autocomplete="off">
      <label>
        <span>Токен Telegram-бота <em>*</em></span>
        <div class="field">
          <input id="token" name="bot_token" type="password" placeholder="123456789:AAH…" autocomplete="new-password" spellcheck="false" autocapitalize="off" required>
          <button class="eye" type="button" id="eye" aria-label="Показать токен">ПОКАЗАТЬ</button>
        </div>
      </label>
      <p class="hint">BotFather → /mybots → ваш бот → API Token. Скопируйте строку целиком.</p>

      <div class="row">
        <label>
          <span>Ваш Telegram ID</span>
          <input id="adminId" name="admin_id" inputmode="numeric" placeholder="932949230" autocomplete="off">
        </label>
        <label>
          <span>Порт сайта</span>
          <input id="port" name="port" inputmode="numeric" value="8088" autocomplete="off">
        </label>
      </div>
      <p class="hint">ID можно узнать у @userinfobot. Если оставить пустым — администратором станет тот, кто первым напишет боту /start.</p>

      <label>
        <span>Публичный адрес сайта</span>
        <input id="siteUrl" name="site_url" value="http://localhost:8088" autocomplete="off" spellcheck="false">
      </label>

      <button class="submit" type="submit" id="submit">ПРОВЕРИТЬ И СОХРАНИТЬ</button>
      <div class="status" id="status" role="status" aria-live="polite"></div>

      <div class="note">
        <b>Что произойдёт:</b> токен будет проверен через Telegram, затем записан в <code>.env</code> с правами только для вашего пользователя. После этого запустите сайт и бота:
        <ul class="steps">
          <li><b>npm start</b><span>— сайт на указанном порту</span></li>
          <li><b>npm run bot</b><span>— бот-администратор</span></li>
        </ul>
      </div>
    </form>

    <div id="success" class="hidden">
      <div class="status ok show" id="successStatus"></div>
      <p class="lead" style="margin:14px 0 0">Токен сохранён в <code>.env</code>. Теперь запустите сайт и бота — эта страница больше не нужна, её можно закрыть.</p>
      <ul class="steps">
        <li><b>npm start</b><span>— магазин</span></li>
        <li><b>npm run bot</b><span>— управление из Telegram</span></li>
      </ul>
    </div>
  </section>
  <p class="note" style="border:0;text-align:center">DVIZH FREIBURG · локальная настройка · соединение только с 127.0.0.1</p>
</div>
<script>
(function(){
  var form = document.getElementById('form');
  var token = document.getElementById('token');
  var eye = document.getElementById('eye');
  var submit = document.getElementById('submit');
  var status = document.getElementById('status');
  var success = document.getElementById('success');
  var key = new URLSearchParams(location.search).get('key') || '';

  eye.addEventListener('click', function(){
    var show = token.type === 'password';
    token.type = show ? 'text' : 'password';
    eye.textContent = show ? 'СКРЫТЬ' : 'ПОКАЗАТЬ';
    eye.setAttribute('aria-label', show ? 'Скрыть токен' : 'Показать токен');
  });

  function setStatus(kind, text){
    status.className = 'status show ' + kind;
    status.textContent = text;
  }
  function busy(on){
    submit.disabled = on;
    submit.textContent = on ? 'ПРОВЕРЯЕМ ТОКЕН…' : 'ПРОВЕРИТЬ И СОХРАНИТЬ';
  }

  form.addEventListener('submit', async function(e){
    e.preventDefault();
    var value = token.value.trim();
    if (!value) { setStatus('err', 'Вставьте токен бота.'); token.focus(); return; }
    busy(true);
    status.className = 'status';
    try {
      var res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Setup-Key': key },
        body: JSON.stringify({
          token: value,
          adminId: document.getElementById('adminId').value.trim(),
          port: document.getElementById('port').value.trim(),
          siteUrl: document.getElementById('siteUrl').value.trim()
        })
      });
      var data = await res.json().catch(function(){ return {}; });
      if (!res.ok) throw new Error(data.error || 'Не удалось сохранить настройки');
      token.value = '';
      form.classList.add('hidden');
      success.classList.remove('hidden');
      var who = data.botUsername ? '@' + data.botUsername : 'бот';
      var extra = data.adminId ? ' Администратор: ' + data.adminId + '.' : ' Теперь напишите боту /start, чтобы закрепить администратора.';
      document.getElementById('successStatus').textContent = 'Готово: ' + who + ' подключён.' + extra;
    } catch (err) {
      setStatus('err', err.message || 'Ошибка. Попробуйте ещё раз.');
      token.focus();
    } finally {
      busy(false);
    }
  });
})();
</script>
</body>
</html>`;
}

export async function startSetupServer({
  port = 0,
  key = randomBytes(18).toString('hex'),
  openBrowser = false,
  autoCloseOnSuccess = true,
  onDone = null,
  quiet = false,
} = {}) {
  let state = { attempts: 0, completed: false, key };

  const server = createServer(async (req, res) => {
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    };
    const send = (status, body, type = 'text/plain; charset=utf-8', extra = {}) => {
      res.writeHead(status, { ...headers, 'Content-Type': type, ...extra });
      res.end(body);
    };

    if (!isLoopback(req) || !hostAllowed(req)) return send(403, 'Forbidden');

    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') return send(204, '');

    if (req.method === 'GET' && url.pathname === '/setup') {
      if (!sameKey(url.searchParams.get('key'), state.key)) return send(404, 'Not Found');
      return send(200, page(Boolean(readEnv(envPath()).TELEGRAM_BOT_TOKEN)), 'text/html; charset=utf-8', {
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      if (!sameKey(url.searchParams.get('key'), state.key)) return send(404, 'Not Found');
      return send(302, '', 'text/plain; charset=utf-8', { Location: `/setup?key=${encodeURIComponent(state.key)}` });
    }

    if (req.method === 'POST' && url.pathname === '/api/setup') {
      if (state.completed) return send(410, JSON.stringify({ error: 'Мастер уже завершён. Запустите npm run setup снова.' }), 'application/json; charset=utf-8');
      if (state.attempts >= MAX_ATTEMPTS) return send(429, JSON.stringify({ error: 'Слишком много попыток. Перезапустите мастер.' }), 'application/json; charset=utf-8');
      if (!sameKey(req.headers['x-setup-key'], state.key)) {
        state.attempts += 1;
        return send(403, JSON.stringify({ error: 'Неверный ключ настройки' }), 'application/json; charset=utf-8');
      }
      state.attempts += 1;

      const chunks = [];
      let size = 0;
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) throw new Error('too_large');
          chunks.push(chunk);
        }
      } catch {
        return send(413, JSON.stringify({ error: 'Слишком большой запрос' }), 'application/json; charset=utf-8');
      }

      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return send(400, JSON.stringify({ error: 'Некорректный запрос' }), 'application/json; charset=utf-8'); }

      try {
        const saved = await saveSetup(body);
        state.completed = true;
        state.key = '';
        send(200, JSON.stringify({
          ok: true,
          botUsername: saved.botUsername,
          botId: saved.botId,
          adminId: saved.adminId,
          siteUrl: saved.siteUrl,
          port: saved.port,
          adminTokenGenerated: saved.adminTokenGenerated,
        }), 'application/json; charset=utf-8');
        if (!quiet) console.log(`[setup] токен сохранён, бот @${saved.botUsername} проверен`);
        if (autoCloseOnSuccess) {
          setTimeout(() => server.close(() => { if (onDone) onDone(saved); }), 1200);
        }
      } catch (e) {
        const message = e instanceof SetupError ? e.message : 'Не удалось сохранить настройки';
        if (!(e instanceof SetupError)) console.error('[setup] ошибка:', e.message);
        return send(400, JSON.stringify({ error: message }), 'application/json; charset=utf-8');
      }
      return;
    }

    return send(404, 'Not Found');
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolvePromise);
  });

  const actualPort = server.address().port;
  const setupUrl = `http://127.0.0.1:${actualPort}/setup?key=${encodeURIComponent(key)}`;

  if (openBrowser) {
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', setupUrl], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [setupUrl], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [setupUrl], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch { /* браузер не открылся — ссылка напечатана */ }
  }

  return {
    server,
    port: actualPort,
    key,
    url: setupUrl,
    close: () => new Promise((r) => server.close(r)),
  };
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  console.log('\n🔐  DVIZH FREIBURG — безопасная настройка токена');
  const instance = await startSetupServer({
    openBrowser: process.env.SETUP_NO_OPEN !== '1',
    onDone: () => {
      console.log('\n✅ Мастер завершён. Теперь запустите:');
      console.log('   npm start      — сайт');
      console.log('   npm run bot    — бот-администратор\n');
      process.exit(0);
    },
  });
  console.log('Откройте ссылку (одноразовая, только этот компьютер):');
  console.log('   ' + instance.url);
  console.log('\nТокен вводится на странице и сохраняется в .env. Ctrl+C — отмена.\n');
  process.on('SIGINT', () => {
    console.log('\nОтменено. Ничего не сохранено.');
    process.exit(130);
  });
}
