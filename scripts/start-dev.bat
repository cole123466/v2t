@echo off
rem Dev mode (hot reload, no build): scripts\start-dev.bat [--port 8080]
call "%~dp0start.bat" --dev %*
exit /b %errorlevel%
