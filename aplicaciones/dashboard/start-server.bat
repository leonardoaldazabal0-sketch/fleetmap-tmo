@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js no esta instalado o no esta en PATH.
  exit /b 1
)
if not exist "node_modules\better-sqlite3" (
  echo Faltan dependencias. Ejecuta: npm install
  exit /b 1
)
node server.js
