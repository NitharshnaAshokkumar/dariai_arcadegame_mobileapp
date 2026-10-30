@echo off
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
    start "Prompt Mirror server" python app.py
    goto opened
)

where py >nul 2>nul
if %errorlevel%==0 (
    start "Prompt Mirror server" py app.py
    goto opened
)

echo Python was not found on this computer.
echo Install Python 3 from https://www.python.org/downloads/ ^(check "Add python.exe to PATH" during install^), then run this file again.
pause
exit /b 1

:opened
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8765/"
