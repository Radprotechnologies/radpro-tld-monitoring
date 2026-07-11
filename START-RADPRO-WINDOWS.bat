@echo off
setlocal EnableExtensions
title Radpro TLD PostgreSQL Launcher
cd /d "%~dp0"
if not exist package.json (echo ERROR: package.json not found.& pause & exit /b 1)
where node >nul 2>nul || (echo ERROR: Node.js 22 LTS or newer is required.& pause & exit /b 1)
if not exist .env (copy .env.example .env >nul & echo Configure DATABASE_URL and SESSION_SECRET in .env.& notepad .env & pause & exit /b 1)
findstr /B /C:"DATABASE_URL=postgresql://" .env >nul || (echo ERROR: Configure DATABASE_URL in .env first.& pause & exit /b 1)
if not exist node_modules\pg call npm install --no-audit --no-fund
if errorlevel 1 pause & exit /b 1
if not exist data mkdir data
if not exist data\uploads mkdir data\uploads
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Sleep -Seconds 5; Start-Process 'http://localhost:3000'"
node server.js
pause
