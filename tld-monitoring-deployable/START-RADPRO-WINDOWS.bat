@echo off
setlocal EnableExtensions
title Radpro TLD Launcher

echo ================================================================
echo  Radpro TLD Personal Monitoring Service - Windows Launcher
echo ================================================================
echo.

REM This file can be run from the root extracted folder.
set "ROOT=%~dp0"
set "APPDIR=%ROOT%tld-monitoring-deployable"

if not exist "%APPDIR%\package.json" (
  echo ERROR: App folder was not found:
  echo %APPDIR%
  echo.
  echo Please extract the ZIP fully first. Do NOT run from WinRAR/Temp.
  echo Example folder: F:\RadproTLD\radpro-tld-monitoring-notifications-rsc-edition\
  echo.
  pause
  exit /b 1
)

cd /d "%APPDIR%"

echo App folder:
echo %CD%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found.
  echo Install Node.js LTS from https://nodejs.org/ and reopen this launcher.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm was not found.
  echo Reinstall Node.js LTS from https://nodejs.org/ and reopen this launcher.
  pause
  exit /b 1
)

echo Node version:
node -v
echo npm version:
npm -v
echo.

if not exist ".env" (
  if exist ".env.example" (
    echo Creating .env from .env.example...
    copy ".env.example" ".env" >nul
  ) else (
    echo WARNING: .env.example not found. Continuing with default settings.
  )
) else (
  echo .env already exists.
)

if not exist "data" mkdir "data"
if not exist "data\uploads" mkdir "data\uploads"

REM Install dependencies if node_modules is missing or incomplete.
if not exist "node_modules\dotenv" (
  echo.
  echo Installing required Node packages...
  echo This can take a few minutes on first run.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    echo Please copy/screenshot the error shown above and send it.
    pause
    exit /b 1
  )
) else (
  echo Node packages already installed.
)

echo.
echo Starting Radpro TLD Monitoring Service...
echo Keep this black window open while using the software.
echo.
echo Browser URL: http://localhost:3000
echo Login: rso / rso123
echo.

start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Sleep -Seconds 5; Start-Process 'http://localhost:3000'"

node server.js

echo.
echo Server stopped or failed to start.
echo If there is an error above, send a screenshot of this full window.
pause
