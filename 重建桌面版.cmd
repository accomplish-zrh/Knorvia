@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build_windows_desktop.ps1"
if errorlevel 1 (
  echo.
  echo Build failed. See the message above.
  pause
)
