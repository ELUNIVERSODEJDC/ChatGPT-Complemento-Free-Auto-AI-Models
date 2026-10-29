@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Necesitas instalar Node.js 22 o posterior antes de continuar.
  pause
  exit /b 1
)
node "%~dp0scripts\install.mjs"
if errorlevel 1 (
  echo No se ha completado la instalacion. Revisa el mensaje anterior.
  pause
  exit /b 1
)
pause
