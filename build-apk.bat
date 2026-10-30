@echo off
title DaRI AI Arcade - Build Android APK
cd /d "%~dp0"

echo ==============================================================
echo           DaRI AI Arcade - Android APK Builder
echo ==============================================================
echo.

:: Ensure exact JDK and Android SDK paths
set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
if not exist "%JAVA_HOME%" (
    if exist "C:\Program Files\Eclipse Adoptium\jdk-25.0.0.36-hotspot" (
        set "JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-25.0.0.36-hotspot"
    )
)
set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%PATH%"

echo Using JAVA_HOME: %JAVA_HOME%
echo Using ANDROID_HOME: %ANDROID_HOME%
echo.

echo [Step 1/3] Syncing latest web app assets...
call npx cap sync android
if %errorlevel% neq 0 (
    echo [ERROR] Capacitor sync failed.
    pause
    exit /b %errorlevel%
)

echo.
echo [Step 2/3] Assembling Debug APK with Gradle...
cd android
call gradlew.bat assembleDebug
if %errorlevel% neq 0 (
    echo [ERROR] Gradle compilation failed.
    cd ..
    pause
    exit /b %errorlevel%
)
cd ..

echo.
echo [Step 3/3] Finalizing APK package...
if not exist "android\app\build\outputs\apk\debug\app-debug.apk" goto build_fail

copy /y "android\app\build\outputs\apk\debug\app-debug.apk" "dariai-arcade-mobile.apk" >nul

echo.
echo ==============================================================
echo   SUCCESS: Android Mobile APK Created Successfully
echo   Location: %cd%\dariai-arcade-mobile.apk
echo ==============================================================
echo.
echo How to run/install on your phone:
echo   1. Transfer dariai-arcade-mobile.apk to your Android phone
echo      using USB, Google Drive, WhatsApp, or Bluetooth.
echo   2. On your phone, tap the APK file and choose Install.
echo   3. Launch DaRI AI Arcade and enjoy playing.
echo.
goto end

:build_fail
echo [WARNING] APK was not found at android\app\build\outputs\apk\debug\app-debug.apk

:end
