@echo off
rem Double-click launcher for pack-and-deploy.ps1 (ps1 files open in Notepad by default).
rem Window stays open at the end so output/errors stay readable.
setlocal
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%pack-and-deploy.ps1" %*
endlocal & pause
