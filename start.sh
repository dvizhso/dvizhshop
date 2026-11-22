#!/usr/bin/env bash
# Запуск магазина DVIZH FREIBURG (сайт + бот) в двух процессах.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "Первый запуск: безопасно подключите Telegram-бота."
  node scripts/setup.mjs
fi
mkdir -p data

node --experimental-sqlite server.mjs &
SERVER_PID=$!
node --experimental-sqlite bot.mjs &
BOT_PID=$!

trap 'kill $SERVER_PID $BOT_PID 2>/dev/null || true' INT TERM EXIT
wait
