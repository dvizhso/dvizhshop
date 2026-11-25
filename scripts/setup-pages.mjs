// Настраивает GitHub Pages одним запуском:
// 1) Source = GitHub Actions, 2) переменная SHOP_API_BASE, 3) перезапуск workflow.
// Токен вводится скрытно или берётся из GITHUB_TOKEN и никогда не печатается.
import { createInterface } from 'node:readline';

const OWNER = process.env.GITHUB_OWNER || 'dvizhso';
const REPO = process.env.GITHUB_REPO || 'dvizhshop';
const API_BASE = process.env.SHOP_API_BASE || 'https://dvizhshop.sashapopivchuk.workers.dev';

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
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') { cleanup(); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
  || await askHidden('GitHub PAT (ввод скрыт): ');
if (!token) {
  console.error('Токен не указан. Ничего не изменено.');
  process.exit(1);
}

function api(path, method = 'GET', body = null) {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dvizh-pages-setup',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function step(label, path, method, body, okStatuses) {
  const res = await api(path, method, body);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  const ok = okStatuses.includes(res.status);
  console.log(`${ok ? 'OK' : 'FAIL'} ${label}: HTTP ${res.status}${ok ? '' : ' ' + String(data?.message || data || '').slice(0, 200)}`);
  return ok;
}

const repo = `/repos/${OWNER}/${REPO}`;
const results = [];
results.push(await step('Pages source = GitHub Actions', `${repo}/pages`, 'PUT', { build_type: 'workflow', source: { branch: 'main', path: '/' } }, [200, 201, 204]));

let variableOk = await step('Variable SHOP_API_BASE (update)', `${repo}/actions/variables/SHOP_API_BASE`, 'PATCH', { value: API_BASE }, [200, 204]);
if (!variableOk) {
  variableOk = await step('Variable SHOP_API_BASE (create)', `${repo}/actions/variables`, 'POST', { name: 'SHOP_API_BASE', value: API_BASE }, [201]);
}
results.push(variableOk);

results.push(await step('Workflow dispatch', `${repo}/actions/workflows/pages.yml/dispatches`, 'POST', { ref: 'main' }, [204]));

console.log(results.every(Boolean) ? '\n✅ GitHub Pages настроен' : '\n❌ Некоторые шаги не удались');
process.exit(results.every(Boolean) ? 0 : 1);
