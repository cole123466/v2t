@echo off
setlocal enabledelayedexpansion
rem ===========================================================================
rem  V2T 一键环境搭建（Windows）
rem  用法：双击运行，或在命令行执行  scripts\setup.bat
rem  作用：校验 Node / ffmpeg -> 安装依赖 -> 准备 .env
rem ===========================================================================
cd /d "%~dp0.."

echo.
echo [v2t] V2T 环境搭建开始
echo.

rem ---------------------------------------------------------------------------
rem 1. Node.js / npm
rem ---------------------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo [v2t] [错误] 未找到 node，请先安装 Node.js 22.5+：https://nodejs.org
  goto :fail
)
where npm >nul 2>&1
if errorlevel 1 (
  echo [v2t] [错误] 未找到 npm，请重新安装 Node.js（含 npm）
  goto :fail
)

for /f "tokens=1,2 delims=." %%a in ('node -v') do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
set "NODE_MAJOR=!NODE_MAJOR:v=!"
rem node:sqlite 需要 Node 22.5+（内置 SQLite，免原生编译）
set "NODE_TOO_OLD=0"
if !NODE_MAJOR! LSS 22 set "NODE_TOO_OLD=1"
if !NODE_MAJOR! EQU 22 if !NODE_MINOR! LSS 5 set "NODE_TOO_OLD=1"
if !NODE_TOO_OLD! EQU 1 (
  echo [v2t] [错误] Node.js 版本过低，需要 22.5 或更高
  node -v
  goto :fail
)
echo [v2t] Node.js 版本检查通过

rem ---------------------------------------------------------------------------
rem 2. ffmpeg / ffprobe（运行时硬依赖）
rem ---------------------------------------------------------------------------
set "MISSING="
where ffmpeg >nul 2>&1
if errorlevel 1 set "MISSING=!MISSING! ffmpeg"
where ffprobe >nul 2>&1
if errorlevel 1 set "MISSING=!MISSING! ffprobe"
if defined MISSING (
  echo [v2t] [错误] 缺少依赖：!MISSING!
  echo        下载 https://www.gyan.dev/ffmpeg/builds/ 后把 bin 目录加入 PATH
  goto :fail
)
echo [v2t] ffmpeg / ffprobe 检查通过

rem ---------------------------------------------------------------------------
rem 3. 安装 npm 依赖
rem ---------------------------------------------------------------------------
if exist package-lock.json (
  echo [v2t] 安装依赖（npm ci）...
  call npm ci --no-audit --no-fund
) else (
  echo [v2t] 安装依赖（npm install）...
  call npm install --no-audit --no-fund
)
if errorlevel 1 (
  echo [v2t] [错误] 依赖安装失败，请检查网络或代理设置
  goto :fail
)

rem ---------------------------------------------------------------------------
rem 4. 准备 .env
rem ---------------------------------------------------------------------------
if not exist .env (
  copy /y .env.example .env >nul
  echo [v2t] [提示] 已从 .env.example 生成 .env，请填入真实 API Key 后再启动
) else (
  echo [v2t] .env 已存在，保留现有配置
)

findstr /c:"sk-your-siliconflow-key" .env >nul 2>&1
if not errorlevel 1 (
  echo [v2t] [提示] .env 中仍有占位 API Key，启动后转写与生成会失败
)
findstr /c:"your-bigmodel-key" .env >nul 2>&1
if not errorlevel 1 (
  echo [v2t] [提示] .env 中仍有占位 LLM API Key，启动后文案生成会失败
)

echo.
echo [v2t] 环境搭建完成。
echo       开发模式：scripts\start.bat --dev
echo       生产模式：scripts\start.bat
echo.
exit /b 0

:fail
echo.
echo [v2t] 环境搭建失败，请按上面的提示处理后重试。
echo.
exit /b 1
