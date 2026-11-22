@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".env" (
  echo Первый запуск: сначала безопасно подключите Telegram-бота.
  echo Открываю локальный мастер настройки...
  call npm run setup
  if errorlevel 1 (
    echo.
    echo Настройка не завершена. Запустите start-bot.bat снова.
    pause
    exit /b 1
  )
)

if not exist "data" mkdir "data"

echo Запускаю Telegram-бота DVIZH FREIBURG...
node --experimental-sqlite bot.mjs
pause
