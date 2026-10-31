@echo off
rem ===========================================================================
rem  beimingda - campus service agent  /  one-click start (Windows)
rem  Double-click this file. It will:
rem     1) check Node.js   2) install deps if needed
rem     3) seed demo data if no database   4) start server + open browser
rem  Default port 3080 (3000 is often taken on this machine).
rem  Change port:   set PORT=8080  then run start.cmd
rem  Stop:          Ctrl+C, or just close this window.
rem  Docs:          HANDOVER.md  (Chinese: see the other .md in this folder)
rem  NOTE: this file is ASCII-only on purpose. cmd.exe parses .cmd files in the
rem  console code page, and non-ASCII bytes can collide with cmd control
rem  characters such as ) | and break the script.
rem ===========================================================================
setlocal
cd /d "%~dp0"

set "PORT=%PORT%"
if not defined PORT set "PORT=3080"
rem NOTE: trim spaces only when PORT is defined - when it is undefined,
rem       %PORT: =% expands to a single space and would break the URL.
if defined PORT set "PORT=%PORT: =%"
if "%PORT%"=="" set "PORT=3080"
set "URL=http://127.0.0.1:%PORT%/"

echo.
echo   ============================================
echo    beimingda . campus service agent (track 17)
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode
for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
echo   [1/4] Node version: %NODEV%

if exist "node_modules\express" goto depsok
echo   [2/4] Installing dependencies (npm install) ...
call npm install --no-audit --no-fund
if errorlevel 1 goto depfail
goto seedcheck

:depsok
echo   [2/4] Dependencies ready.

:seedcheck
if exist "data\beimingda.db" goto dbok
echo   [3/4] Creating database and seeding demo data ...
call npm run seed
if errorlevel 1 goto seedfail
goto run

:dbok
echo   [3/4] Database found: data\beimingda.db
echo         reset demo data before a demo: npm run seed -- --reset

:run
echo   [4/4] Starting server: %URL%
echo.
echo   ---- open these ----
echo     Home        %URL%
echo     Agent       %URL%agent
echo     Takeout     %URL%takeout
echo     Buddy       %URL%buddy
echo     Map / 3D    %URL%welcome
echo     Schedule    %URL%schedule
echo   --------------------
echo     add ?demo=1 to show the "demo mode" badge (fake data)
echo     health check: %URL%api/health
echo     stop: Ctrl+C or close this window
echo.

if defined NO_BROWSER set "NO_BROWSER=%NO_BROWSER: =%"
if /i "%NO_BROWSER%"=="1" goto nobrowser
start "" "%URL%"

:nobrowser
node src/server.js

echo.
echo   Server stopped.
pause
exit /b 0

:nonode
echo   [x] Node.js not found. Please install Node.js 20 or newer:
echo       https://nodejs.org/
echo       Then double-click this file again.
echo.
pause
exit /b 1

:depfail
echo   [x] npm install failed. Check your network, or try:
echo       npm config set registry https://registry.npmmirror.com
echo.
pause
exit /b 1

:seedfail
echo   [x] Seeding failed. See the error above.
echo.
pause
exit /b 1
