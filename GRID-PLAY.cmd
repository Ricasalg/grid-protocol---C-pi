@echo off
rem ===========================================================================
rem  GRID PROTOCOL — launcher
rem
rem  This file exists because Windows has no file association for .mjs, so
rem  double-clicking serve.mjs opens it in a text editor and the window closes
rem  instantly. .cmd is associated with the command processor by default, so
rem  this is the version you can actually double-click.
rem
rem  It only locates node.exe and hands over to serve.mjs. All the logic — the
rem  build, the static server, the browser launch — lives in serve.mjs.
rem ===========================================================================

setlocal

set "GRID_DIR=%~dp0"
set "NODE_EXE="

rem Prefer the copy of Node that npm put on PATH; fall back to the standard
rem install location so the launcher still works if PATH was never set up.
where node >nul 2>&1 && set "NODE_EXE=node"

if not defined NODE_EXE (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_EXE=C:\Program Files\nodejs\node.exe"
  )
)

if not defined NODE_EXE (
  echo.
  echo   GRID PROTOCOL — node not found
  echo.
  echo   Node.js is required to run this. Install it from:
  echo     https://nodejs.org
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "%GRID_DIR%serve.mjs" %*
set "GRID_EXIT=%ERRORLEVEL%"

rem If the server exited on its own rather than through Ctrl+C, the window
rem would close before anything could be read. Hold it open so any error stays
rem visible.
if not "%GRID_EXIT%"=="0" (
  echo.
  echo   exited with code %GRID_EXIT%
  pause
)

endlocal & exit /b %GRID_EXIT%