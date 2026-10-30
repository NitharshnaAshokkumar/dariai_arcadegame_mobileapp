@echo off
title DaRI AI Arcade - Stop Server
cd /d "%~dp0"

echo Stopping any running DaRI AI Arcade servers on port 8765...
powershell -Command "Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
echo Server stopped. Port 8765 is now free.
timeout /t 2 /nobreak >nul
