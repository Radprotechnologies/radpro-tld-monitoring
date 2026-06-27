@echo off
setlocal EnableExtensions
cd /d "%~dp0tld-monitoring-deployable"

echo ================================================================
echo  Radpro TLD Personal Monitoring Service
echo ================================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not in PATH.
  echo Install Node.js LTS from https://nodejs.org/
  pause
  exit /b 1
)

echo Node:
node -v
echo npm:
npm -v
echo.

npm config set registry https://registry.npmjs.org/

if not exist .env (
  copy .env.example .env
)

if not exist data mkdir data
if not exist data\uploads mkdir data\uploads

echo Cleaning old failed install files...
if exist package-lock.json del /f /q package-lock.json
if exist node_modules rmdir /s /q node_modules

echo Installing packages from public npm registry...
call npm install --registry=https://registry.npmjs.org/ --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo NPM INSTALL FAILED. Please send screenshot of this window.
  pause
  exit /b 1
)

echo.
echo Starting server...
echo Open: http://localhost:3000
echo Login: rso / rso123
echo Keep this window open.
echo.
start "" "http://localhost:3000"
node server.js

echo.
echo SERVER STOPPED OR FAILED. Send screenshot of this window.
pause
