// Публикация проекта в GitHub через Git Data API.
// Токен вводится скрыто или берётся из GITHUB_TOKEN и никогда не печатается.
// Запуск: npm run publish
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, posix } from 'node:path';
import { createInterface } from 'node:readline';

const OWNER = process.env.GITHUB_OWNER || 'dvizhso';
const REPO = process.env.GITHUB_REPO || 'dvizhshop';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const MESSAGE = process.env.GITHUB_MESSAGE || 'DVIZH FREIBURG: shop + Telegram admin bot';

const INCLUDE_FILES = [
  'README.md',
  'package.json',
  'wrangler.toml',
  'server.mjs',
  'bot.mjs',
  '.gitignore',
  '.env.example',
  'Dockerfile',
  'docker-compose.yml',
  'start.sh',
  'start-shop.bat',
  'start-bot.bat',
];
const INCLUDE_DIRS = ['lib', 'public', 'scripts', 'test', 'worker', '.github'];
const SKIP = /(^|\/)(data|node_modules|\.git)(\/|$)|(^|\/)\.env$|\.png$|\.log$/;

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
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function collectFiles(root) {
  const out = [];
  for (const file of INCLUDE_FILES) {
    try {
      const full = join(root, file);
      if (statSync(full).isFile()) out.push(file);
    } catch { /* файла нет — пропускаем */ }
  }
  for (const dir of INCLUDE_DIRS) {
    const walk = (current) => {
      let entries = [];
      try { entries = readdirSync(join(root, current), { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const rel = posix.join(current.replace(/\\/g, '/'), entry.name);
        if (SKIP.test(rel)) continue;
        if (entry.isDirectory()) walk(rel);
        else if (entry.isFile()) out.push(rel);
      }
    };
    walk(dir);
  }
  return [...new Set(out)].sort();
}

function makeApi(token) {
  return async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dvizh-freiburg-publisher',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const reason = data && data.message ? data.message : `HTTP ${res.status}`;
      throw new Error(`${method} ${path}: ${reason}`);
    }
    return data;
  };
}

async function main() {
  const root = process.cwd();
  const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
    || await askHidden('GitHub PAT (ввод скрыт): ');
  if (!token) {
    console.error('❌ Токен не указан. Ничего не отправлено.');
    process.exitCode = 1;
    return;
  }

  const api = makeApi(token);
  const repoPath = `/repos/${OWNER}/${REPO}`;

  const me = await api('/user');
  console.log(`🔐 GitHub: ${me.login}`);
  console.log(`📦 ${OWNER}/${REPO} · ветка ${BRANCH}`);

  const ref = await api(`${repoPath}/git/ref/heads/${BRANCH}`);
  const parentSha = ref.object.sha;
  const parent = await api(`${repoPath}/git/commits/${parentSha}`);
  const baseTree = parent.tree.sha;

  const files = collectFiles(root);
  if (!files.length) throw new Error('Не найдено файлов для публикации.');
  console.log(`📄 Файлов: ${files.length}`);

  const entries = [];
  for (const file of files) {
    const content = readFileSync(join(root, file));
    const blob = await api(`${repoPath}/git/blobs`, {
      method: 'POST',
      body: { content: content.toString('base64'), encoding: 'base64' },
    });
    entries.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha });
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  const tree = await api(`${repoPath}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseTree, tree: entries },
  });
  const commit = await api(`${repoPath}/git/commits`, {
    method: 'POST',
    body: { message: MESSAGE, tree: tree.sha, parents: [parentSha] },
  });
  await api(`${repoPath}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: { sha: commit.sha, force: false },
  });

  console.log(`\n✅ Опубликовано: https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`);
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  process.exitCode = 1;
});
