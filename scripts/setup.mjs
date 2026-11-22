// Настройка токена бота в терминале со скрытым вводом.
// Запуск: npm run setup:cli
import { createInterface } from 'node:readline';
import { envPath, readEnv } from '../lib/envfile.mjs';
import { saveSetup, SetupError } from '../lib/setup.mjs';

function askVisible(prompt, fallback = '') {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const suffix = fallback ? ` [${fallback}]` : '';
    rl.question(`${prompt}${suffix}: `, (answer) => {
      rl.close();
      const value = String(answer || '').trim();
      resolve(value || fallback);
    });
  });
}

// Ввод без эха: токен не отображается в терминале и не попадает в историю.
function askHidden(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      process.stdout.write(prompt);
      rl.question('', (answer) => { rl.close(); resolve(String(answer || '').trim()); });
      return;
    }
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';

    const cleanup = () => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(false); } catch { /* ignore */ }
      stdin.pause();
    };

    const onData = (chunk) => {
      const text = String(chunk);
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= ' ') value += ch;
      }
    };

    stdin.on('data', onData);
  });
}

async function main() {
  const current = readEnv();
  console.log('\n🔐  DVIZH FREIBURG — настройка токена бота');
  console.log('    Ввод скрыт. Токен сохранится только в .env.\n');

  const token = await askHidden(
    current.TELEGRAM_BOT_TOKEN
      ? 'Токен бота (Enter — оставить сохранённый): '
      : 'Токен бота из @BotFather: ',
  );
  const finalToken = token || current.TELEGRAM_BOT_TOKEN || '';
  if (!finalToken) {
    console.error('\n❌ Токен не указан. Ничего не сохранено.\n');
    process.exitCode = 1;
    return;
  }

  const adminId = await askVisible('Ваш Telegram ID (можно пустым)', current.ADMIN_ID || '');
  const port = await askVisible('Порт сайта', current.PORT || '8088');
  const siteUrl = await askVisible('Публичный адрес сайта', current.SITE_URL || `http://localhost:${port}`);

  process.stdout.write('\nПроверяю токен у Telegram… ');
  try {
    const saved = await saveSetup({ token: finalToken, adminId, port, siteUrl });
    console.log('готово.');
    console.log(`\n✅ Бот @${saved.botUsername} подключён и сохранён в ${envPath()}`);
    if (saved.adminId) console.log(`   Администратор: ${saved.adminId}`);
    else console.log('   ADMIN_ID пуст — напишите боту /start, чтобы закрепить администратора.');
    if (saved.adminTokenGenerated) console.log('   ADMIN_TOKEN сгенерирован автоматически.');
    console.log('\nЗапуск:');
    console.log('   npm start      — сайт');
    console.log('   npm run bot    — бот-администратор\n');
  } catch (e) {
    console.log('ошибка.');
    const message = e instanceof SetupError ? e.message : 'Не удалось сохранить настройки';
    console.error(`\n❌ ${message}\n`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('\n❌ Ошибка:', e.message, '\n');
  process.exitCode = 1;
});
