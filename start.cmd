@echo off
rem Platypus: doppio clic per avviare (Windows)
cd /d "%~dp0"
rem niente blocchi "( ... )": una ")" nel messaggio chiuderebbe il blocco e il messaggio uscirebbe sempre
where node >NUL 2>&1
if not errorlevel 1 goto run
echo Serve Node.js 22.13 o piu recente: winget install OpenJS.NodeJS.LTS  (oppure https://nodejs.org)
echo Node.js 22.13 or newer is required: winget install OpenJS.NodeJS.LTS  (or https://nodejs.org)
pause
exit /b 1
:run
rem la versione la controlla scripts\launch.js, che spiega come aggiornare Node.js se serve
node scripts\launch.js --background %*
if errorlevel 1 pause
