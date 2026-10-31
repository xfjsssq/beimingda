@echo off
rem ===========================================================================
rem  beimingda - self check (Windows)
rem    161 unit/page tests + 8 smoke + 114 integration checks
rem    the integration run really calls all 15 MCP tools and probes 6 pages
rem ===========================================================================
setlocal
cd /d "%~dp0"

echo.
echo   === 1/3 unit + page tests  (npm test) ===
call npm test
if errorlevel 1 goto fail

echo.
echo   === 2/3 smoke              (npm run smoke) ===
call npm run smoke
if errorlevel 1 goto fail

echo.
echo   === 3/3 integration        (npm run verify) ===
echo       really calls 15 MCP tools and probes 6 pages
call npm run verify
if errorlevel 1 goto fail

echo.
echo   [OK] All checks passed. The service is healthy.
pause
exit /b 0

:fail
echo.
echo   [FAIL] Something is broken - fix it before the demo.
pause
exit /b 1
