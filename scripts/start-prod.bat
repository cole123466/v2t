@echo off
rem Prod mode (build + start): scripts\start-prod.bat [--skip-build] [--port 8080]
call "%~dp0start.bat" %*
exit /b %errorlevel%
