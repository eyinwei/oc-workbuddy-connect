@echo off
setlocal
cd /d "%~dp0"

rem ===========================================================
rem   WorkBuddy bridge - start (background)
rem
rem   Usage: start-bridge.cmd [quiet]
rem
rem   Starts the bridge in its own hidden console and then exits,
rem   so this window can be closed without stopping the bridge.
rem   Stop it with stop-bridge.cmd.
rem
rem   quiet - do not wait for a keypress at the end. Use it for
rem           autostart, where nobody is there to press one.
rem
rem   The launch deliberately passes no -RedirectStandard* to
rem   Start-Process: those force a CreateProcess that inherits the
rem   caller's console, and closing that window would then kill the
rem   bridge via CTRL_CLOSE_EVENT. Letting cmd do the redirection
rem   gives the bridge a console of its own instead.
rem
rem   Messages are ASCII on purpose: cmd.exe parses this file with
rem   the OEM code page, so non-ASCII text is unreliable.
rem ===========================================================

set "PORT=8787"
set "WAIT=pause"
if /i "%~1"=="quiet" set "WAIT=rem"

rem  To require a bearer token, uncomment the next line and set the
rem  same value as the API key configured in OpenChamber / OpenCode.
rem set "WB_CONNECT_API_KEY=your-secret"

echo.
echo   WorkBuddy bridge - start
echo.

rem ---- Node.js available? ----
where node >nul 2>nul
if errorlevel 1 (
    echo   [ERROR] Node.js not found in PATH.
    echo           Install Node.js 20.6 or newer: https://nodejs.org/
    echo.
    %WAIT%
    exit /b 1
)

rem ---- Running from the project root? ----
if not exist "bin\wb-connect.js" (
    echo   [ERROR] bin\wb-connect.js not found.
    echo           Keep this file next to bin\ and src\.
    echo.
    %WAIT%
    exit /b 1
)

rem ---- Start in its own hidden console, output to bridge.log ----
powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir = (Get-Location).Path; $p = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*wb-connect.js*' -and $_.CommandLine -like '*serve*' }); if ($p.Count -gt 0) { Write-Host ('  Already running - node PID ' + (($p | ForEach-Object { $_.ProcessId }) -join ', ')); exit 3 }; Start-Process -FilePath 'cmd' -ArgumentList '/c','node bin\wb-connect.js serve --port %PORT% > bridge.log 2>&1' -WorkingDirectory $dir -WindowStyle Hidden | Out-Null; Start-Sleep -Seconds 4; $n = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*wb-connect.js*' -and $_.CommandLine -like '*serve*' }); if ($n.Count -eq 0) { Write-Host '  Failed  - the bridge process did not appear; see bridge.log'; exit 1 }; Write-Host ('  Started - node PID ' + (($n | ForEach-Object { $_.ProcessId }) -join ', ')); try { Invoke-RestMethod 'http://127.0.0.1:%PORT%/healthz' -TimeoutSec 6 | Out-Null; Write-Host ('  Status  - ok, http://127.0.0.1:%PORT%/v1') } catch { Write-Host '  Status  - not responding; see bridge.log'; exit 1 }"
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" (
    echo   Running in the background - you can close this window.
    echo   Log  : bridge.log
    echo   Stop : stop-bridge.cmd
) else if "%CODE%"=="3" (
    echo   Nothing was started. Use stop-bridge.cmd to restart.
) else (
    echo   The bridge did not start. See bridge.log.
)
echo.
%WAIT%
exit /b %CODE%
