@echo off
cd /d "%~dp0"

echo.
echo  StellaSnipes - starting...
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

if not exist node_modules (
    echo  Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo.
        echo  ERROR: Dependency installation failed.
        pause
        exit /b 1
    )
    echo.
)

if not defined PORT set "PORT=3000"
start "" "http://127.0.0.1:%PORT%"
node server.js

echo.
echo  StellaSnipes has stopped.
pause
