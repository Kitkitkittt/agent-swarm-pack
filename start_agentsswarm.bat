@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title AgentSwarm

set "RUN_DEV=0"
set "DO_UPDATE=0"
set "RESYNC_ENV=0"
set "RUN_DOCTOR=0"
set "RUN_UI=1"

:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--dev" set "RUN_DEV=1"
if /i "%~1"=="--update" set "DO_UPDATE=1"
if /i "%~1"=="--resync-env" set "RESYNC_ENV=1"
if /i "%~1"=="--doctor" set "RUN_DOCTOR=1"
if /i "%~1"=="--no-ui" set "RUN_UI=0"
shift
goto parse_args

:args_done
if not exist "%~dp0agentsswarm" (
  echo [ERROR] agentsswarm directory not found.
  exit /b 1
)

set "NEEDS_SETUP=0"
if not exist "%~dp0agentsswarm\.env" set "NEEDS_SETUP=1"
if not exist "%~dp0agentsswarm\node_modules" set "NEEDS_SETUP=1"

if "%NEEDS_SETUP%"=="1" (
  echo [INFO] Bootstrap required. Running setup_agentsswarm.bat...
  set "SETUP_ARGS=--skip-tests"
  if "%DO_UPDATE%"=="1" set "SETUP_ARGS=!SETUP_ARGS! --update"
  if "%RESYNC_ENV%"=="1" set "SETUP_ARGS=!SETUP_ARGS! --resync-env"
  call "%~dp0setup_agentsswarm.bat" !SETUP_ARGS!
  if errorlevel 1 exit /b 1
)

cd /d "%~dp0agentsswarm"
if errorlevel 1 (
  echo [ERROR] Could not enter agentsswarm directory.
  exit /b 1
)

if "%RESYNC_ENV%"=="1" (
  call node "scripts\bootstrap-env.mjs" --startup --strict --resync-env
) else (
  call node "scripts\bootstrap-env.mjs" --startup --strict
)
if errorlevel 1 (
  echo [ERROR] Missing required AgentSwarm environment values.
  exit /b 1
)

set "HAS_STARTUP_CHECK=0"
call node -e "const fs=require('node:fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));process.exit(pkg.scripts&&pkg.scripts['startup-check']?0:1)" >nul 2>&1
if not errorlevel 1 set "HAS_STARTUP_CHECK=1"

if "%HAS_STARTUP_CHECK%"=="1" (
  call npm run startup-check
) else (
  echo [WARN] startup-check script not found, falling back to preflight.
  call npm run preflight
)
if errorlevel 1 (
  echo [ERROR] AgentSwarm startup checks failed. Fix the blocking issues above, then retry.
  exit /b 1
)

set "TASK_EXECUTION_BACKEND=standalone"
for /f "tokens=1,2 delims==" %%A in ('findstr /b /c:"TASK_EXECUTION_BACKEND=" ".env" 2^>nul') do set "TASK_EXECUTION_BACKEND=%%B"
set "CONNECTOR_BACKEND=none"
for /f "tokens=1,2 delims==" %%A in ('findstr /b /c:"CONNECTOR_BACKEND=" ".env" 2^>nul') do set "CONNECTOR_BACKEND=%%B"

if /i "%TASK_EXECUTION_BACKEND%"=="remote_api" call :is_port_in_use 8790
if /i "%TASK_EXECUTION_BACKEND%"=="remote_api" if errorlevel 1 (
  echo [WARN] Remote execution API is not detected on port 8790.
  echo [WARN] AgentSwarm will still start, but remote execution flows will fail until REMOTE_API_URL is reachable.
)

set "BRIDGE_PORT=7799"
for /f "tokens=1,2 delims==" %%A in ('findstr /b /c:"BRIDGE_PORT=" ".env" 2^>nul') do set "BRIDGE_PORT=%%B"
set "UI_PORT=7800"
for /f "tokens=1,2 delims==" %%A in ('findstr /b /c:"UI_PORT=" ".env" 2^>nul') do set "UI_PORT=%%B"
call :find_port_pid !BRIDGE_PORT!
if defined PORT_PID (
  echo [INFO] Stopping existing AgentSwarm process on port !BRIDGE_PORT! ^(pid=!PORT_PID!^)...
  taskkill /PID !PORT_PID! /F >nul 2>&1
  timeout /t 1 >nul
  set "PORT_PID="
)

if "%RUN_UI%"=="1" (
  if not exist "%~dp0agentsswarm\ui" (
    echo [WARN] UI directory not found. Skipping SPA UI launch.
    set "RUN_UI=0"
  ) else (
    if not exist "%~dp0agentsswarm\ui\node_modules" (
      echo [INFO] Installing UI dependencies...
      call npm --prefix "ui" install
      if errorlevel 1 (
        echo [WARN] UI dependency install failed. Skipping SPA UI launch.
        set "RUN_UI=0"
      )
    )
  )
)

if "%RUN_UI%"=="1" (
  call :find_port_pid !UI_PORT!
  if defined PORT_PID (
    echo [INFO] Stopping existing UI process on port !UI_PORT! ^(pid=!PORT_PID!^)...
    taskkill /PID !PORT_PID! /F >nul 2>&1
    timeout /t 1 >nul
    set "PORT_PID="
  )
)

if "%DO_UPDATE%"=="1" if "%NEEDS_SETUP%"=="0" (
  echo [INFO] Applying npm update before launch...
  call npm update
  if errorlevel 1 echo [WARN] npm update failed. Continuing with existing versions.
)

if "%RUN_DOCTOR%"=="1" (
  echo [INFO] Startup checks passed. Doctor will be available after AgentSwarm is listening.
)

echo ================================================
echo   AgentSwarm starting
echo   Service: secure local control plane with browser dashboard
echo   Execution Backend: !TASK_EXECUTION_BACKEND!
echo   Connector Backend: !CONNECTOR_BACKEND!
echo   Dashboard: http://127.0.0.1:!BRIDGE_PORT!/
if "%RUN_UI%"=="1" (
  echo   SPA UI:  http://127.0.0.1:!UI_PORT!/dashboard ^(auto-started^)
) else (
  echo   SPA UI:  disabled ^(--no-ui^)
)
echo   Health:  http://127.0.0.1:!BRIDGE_PORT!/health
echo   Tasks:   http://127.0.0.1:!BRIDGE_PORT!/tasks
echo   Routes:  set BRIDGE_URL=http://127.0.0.1:!BRIDGE_PORT! ^&^& npm run cli -- routes
echo   Resolve: set BRIDGE_URL=http://127.0.0.1:!BRIDGE_PORT! ^&^& npm run cli -- resolve-route --channel engineering
echo   Summary: set BRIDGE_URL=http://127.0.0.1:!BRIDGE_PORT! ^&^& npm run cli -- summary
echo ================================================

if "%RUN_UI%"=="1" (
  echo [INFO] Launching SPA UI on http://127.0.0.1:!UI_PORT!/dashboard ...
  start "AgentSwarm UI" cmd /k "cd /d ""%~dp0agentsswarm\ui"" && npm run dev -- --port !UI_PORT!"
  timeout /t 1 >nul
)

if "%RUN_DEV%"=="1" (
  echo [INFO] Running in dev/watch mode.
  echo [INFO] Open dashboard: http://127.0.0.1:!BRIDGE_PORT!/dashboard
  call npm run dev
) else (
  set "BRIDGE_URL=http://127.0.0.1:!BRIDGE_PORT!"
  if "%RUN_DOCTOR%"=="1" (
    call npm run cli -- doctor
    if errorlevel 1 (
      echo [ERROR] Doctor checks failed. Resolve reported issues before start.
      exit /b 1
    )
  )
  echo [INFO] Launching AgentSwarm runtime in this window...
  echo [INFO] Dashboard: http://127.0.0.1:!BRIDGE_PORT!/dashboard
  call npm start
)

endlocal
exit /b 0

:find_port_pid
set "PORT_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr /C:":%~1 "') do (
  if not defined PORT_PID set "PORT_PID=%%p"
)
exit /b 0

:is_port_in_use
call :find_port_pid %~1
if defined PORT_PID exit /b 0
exit /b 1
