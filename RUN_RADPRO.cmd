@echo off
setlocal
cd /d "%~dp0tld-monitoring-deployable"
echo ==============================================
echo   Radpro TLD Monitoring - Multi Hospital Edition
echo ==============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Please install Node.js 22 LTS and run again.
  pause
  exit /b 1
)
node -v
npm config set registry https://registry.npmjs.org/
if exist package-lock.json del package-lock.json
if not exist .env copy .env.example .env
if not exist node_modules (
  echo Installing npm packages. This may take a few minutes...
  npm install --registry=https://registry.npmjs.org/
  if errorlevel 1 (
    echo.
    echo npm install failed. Check internet connection or npm registry.
    pause
    exit /b 1
  )
)
echo.
echo Starting Radpro TLD server...
echo Open: http://localhost:3000
echo Radpro panel: radpro / radpro123
echo Demo RSO: rso / rso123
echo Keep this window open.
start "" http://localhost:3000
npm start
pause
