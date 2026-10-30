@echo off
title DaRI AI Arcade - Desktop Application
cd /d "%~dp0"

echo ==============================================================
echo           DaRI AI Arcade - Desktop Application
echo ==============================================================
echo.

if exist "node_modules\electron" (
    echo Launching native Desktop window with Electron...
    npx electron .
) else (
    echo Electron not installed locally yet. Starting local server...
    start /b "" node server.js
    timeout /t 1 /nobreak >nul
    echo Opening DaRI AI Arcade in app window mode...
    start "" msedge --app=http://127.0.0.1:8765 || start "" chrome --app=http://127.0.0.1:8765 || start http://127.0.0.1:8765
)

echo App is running!
