@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js no esta instalado o no esta en PATH.
  echo Instala Node.js LTS o copia una version portable de Node junto a esta app.
  pause
  exit /b 1
)
if not exist "node_modules\better-sqlite3" (
  echo Faltan dependencias. Ejecuta: npm install
  pause
  exit /b 1
)
start "" "http://127.0.0.1:8787"
node server.js
