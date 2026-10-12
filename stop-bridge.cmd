@echo off
setlocal
cd /d "%~dp0"

rem ===========================================================
rem   WorkBuddy bridge - stop
rem
rem   Stops the background bridge that start-bridge.cmd launched.
rem   Messages are ASCII on purpose (see start-bridge.cmd).
rem
rem   Exit codes: 0 stopped, 4 nothing was running, 1 failed.
rem ===========================================================

echo.
echo   WorkBuddy bridge - stop
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*wb-connect.js*' -and $_.CommandLine -like '*serve*' }); if ($p.Count -eq 0) { Write-Host '  The bridge is not running.'; exit 4 }; $bad = 0; foreach ($x in $p) { try { Stop-Process -Id $x.ProcessId -Force -ErrorAction Stop; Write-Host ('  Stopped - node PID ' + $x.ProcessId) } catch { Write-Host ('  Failed  - node PID ' + $x.ProcessId + ': ' + $_.Exception.Message); $bad = 1 } }; if ($bad -eq 0) { Write-Host ''; Write-Host '  Bridge stopped.' } else { exit 1 }"
set "CODE=%ERRORLEVEL%"

echo.
pause
exit /b %CODE%
