@echo off
chcp 65001 >nul 2>nul
setlocal
cd /d "%~dp0"

set PORT=8777
if not "%~1"=="" set PORT=%~1

set NODE_BIN=
where node >nul 2>nul && set NODE_BIN=node
if "%NODE_BIN%"=="" if exist "%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-6\node.exe" set NODE_BIN=%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-6\node.exe

if not "%NODE_BIN%"=="" (
  if not exist "node_modules\mysql2" (
    echo.
    echo   [!] node_modules not found - remote databases ^(MySQL / PostgreSQL / SQL Server^) will be unavailable.
    echo       Run "npm install" once to enable them. Browser-side SQLite still works.
    echo.
  )
  start "" "http://127.0.0.1:%PORT%/app/index.html"
  "%NODE_BIN%" server.js %PORT%
  goto :end
)

where py >nul 2>nul
if %errorlevel%==0 (
  echo.
  echo   [!] Node.js not found - falling back to Python static server.
  echo       Only the browser-side SQLite engine will work; remote databases need "node server.js".
  echo.
  start "" "http://127.0.0.1:%PORT%/app/index.html"
  py -3 -m http.server %PORT% --bind 127.0.0.1
  goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
  echo.
  echo   [!] Node.js not found - falling back to Python static server.
  echo       Only the browser-side SQLite engine will work; remote databases need "node server.js".
  echo.
  start "" "http://127.0.0.1:%PORT%/app/index.html"
  python -m http.server %PORT% --bind 127.0.0.1
  goto :end
)

echo.
echo   Node.js or Python not found.
echo   Please install Node.js (https://nodejs.org) or Python, then run this again.
echo.
pause

:end
endlocal
