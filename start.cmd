@echo off
rem Platypus: doppio clic per avviare (Windows)
cd /d "%~dp0"
where node >NUL 2>&1
if errorlevel 1 (
  echo Serve Node.js 22.13 o piu recente: winget install OpenJS.NodeJS.LTS  (oppure https://nodejs.org)
  echo Node.js 22.13 or newer is required: winget install OpenJS.NodeJS.LTS  (or https://nodejs.org)
  pause
  exit /b 1
)
node scripts\launch.js --background %*
if errorlevel 1 pause
