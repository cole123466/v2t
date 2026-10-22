@echo off
setlocal enabledelayedexpansion
rem ===========================================================================
rem  V2T 启动脚本（Windows）
rem  用法：
rem    scripts\start.bat                 构建 + 生产模式（默认 4317 端口）
rem    scripts\start.bat --skip-build    跳过构建，直接运行已有产物
rem    scripts\start.bat --dev           开发模式（热更新）
rem    scripts\start.bat --port 8080     指定端口
rem  端口也可用环境变量 V2T_PORT 覆盖
rem ===========================================================================
cd /d "%~dp0.."

set "PORT=%V2T_PORT%"
if not defined PORT set "PORT=4317"
set "MODE=prod"
set "SKIP_BUILD=0"

:parse
if "%~1"=="" goto :parsed
if /i "%~1"=="--dev" (
  set "MODE=dev"
  shift
  goto :parse
)
if /i "%~1"=="--skip-build" (
  set "SKIP_BUILD=1"
  shift
  goto :parse
)
if /i "%~1"=="--port" (
  if "%~2"=="" (
    echo [v2t] [错误] --port 需要一个端口号
    goto :fail
  )
  set "PORT=%~2"
  shift
  shift
  goto :parse
)
if /i "%~1"=="-h" goto :help
if /i "%~1"=="--help" goto :help
echo [v2t] [错误] 未知参数：%~1（用 --help 查看用法）
goto :fail

:help
echo 用法：
echo   scripts\start.bat                 构建 + 生产模式（默认 4317 端口）
echo   scripts\start.bat --skip-build    跳过构建，直接运行已有产物
echo   scripts\start.bat --dev           开发模式（热更新）
echo   scripts\start.bat --port 8080     指定端口
exit /b 0

:parsed
rem 校验端口是纯数字
set "PORT_TEST=!PORT!"
if "!PORT_TEST!"=="" (
  echo [v2t] [错误] 端口不能为空
  goto :fail
)
for /f "delims=0123456789" %%x in ("!PORT_TEST!") do (
  echo [v2t] [错误] 端口必须是数字：!PORT!
  goto :fail
)
if !PORT! LSS 1 (
  echo [v2t] [错误] 端口超出范围（1-65535）：!PORT!
  goto :fail
)
if !PORT! GTR 65535 (
  echo [v2t] [错误] 端口超出范围（1-65535）：!PORT!
  goto :fail
)

if not exist node_modules (
  echo [v2t] [错误] 依赖尚未安装，请先运行：scripts\setup.bat
  goto :fail
)
if not exist .env echo [v2t] [提示] .env 不存在，转写与文案生成会因缺少 API Key 而失败

where ffmpeg >nul 2>&1
if errorlevel 1 echo [v2t] [提示] 未找到 ffmpeg，抽取音频会失败
where ffprobe >nul 2>&1
if errorlevel 1 echo [v2t] [提示] 未找到 ffprobe，探测视频时长会失败

if /i "%MODE%"=="dev" (
  echo [v2t] 开发模式启动：http://localhost:!PORT!
  call npx next dev -p !PORT!
  goto :done
)

if "%SKIP_BUILD%"=="1" (
  if not exist .next (
    echo [v2t] [错误] .next 不存在，无法跳过构建；请去掉 --skip-build
    goto :fail
  )
  echo [v2t] 跳过构建，复用现有产物
) else (
  echo [v2t] 构建生产包...
  call npm run build
  if errorlevel 1 (
    echo [v2t] [错误] 构建失败
    goto :fail
  )
)

echo [v2t] 生产模式启动：http://localhost:!PORT!
call npx next start -p !PORT!
goto :done

:done
echo.
echo [v2t] 服务已停止。
echo.
exit /b 0

:fail
echo.
exit /b 1
