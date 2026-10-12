@echo off
setlocal
cd /d "%~dp0"

rem ===========================================================
rem   WorkBuddy bridge -- double-click to start, close to stop
rem   Messages are ASCII on purpose: cmd.exe parses this file
rem   with the OEM code page, so non-ASCII text is unreliable.
rem ===========================================================

set "PORT=8787"

rem  To require a bearer token, uncomment the next line and set the
rem  same value as the API key configured in OpenChamber / OpenCode.
rem set "WB_CONNECT_API_KEY=your-secret"

rem ---- Node.js available? ----
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [ERROR] Node.js not found in PATH.
    echo           Install Node.js 20.6 or newer: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

rem ---- Running from the project root? ----
if not exist "bin\wb-connect.js" (
    echo.
    echo   [ERROR] bin\wb-connect.js not found.
    echo           Keep this file next to bin\ and src\.
    echo.
    pause
    exit /b 1
)

rem ---- Already running? ----
powershell -NoProfile -Command "try { Invoke-RestMethod 'http://127.0.0.1:%PORT%/healthz' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
    echo.
    echo   The bridge is already running on http://127.0.0.1:%PORT%
    echo   Nothing to do.
    echo.
    pause
    exit /b 0
)

rem ---- Start ----
echo.
echo   WorkBuddy bridge
echo   URL  : http://127.0.0.1:%PORT%/v1
echo   Stop : close this window
echo.
echo   Keep this window open while using OpenChamber.
echo.

node "bin\wb-connect.js" serve --port %PORT%
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" (
    echo   Bridge stopped.
) else (
    echo   Bridge exited with code %CODE%.
    echo   Run "node bin\wb-connect.js doctor" to diagnose.
)
echo.
pause
