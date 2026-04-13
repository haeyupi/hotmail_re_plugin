@echo off
setlocal
cd /d "%~dp0"
powershell -NoLogo -NoExit -ExecutionPolicy Bypass -File "%~dp0start_hotmail_service.ps1"
