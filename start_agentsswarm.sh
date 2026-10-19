#!/usr/bin/env bash
set -e

RUN_DEV=0
DO_UPDATE=0
RESYNC_ENV=0
RUN_DOCTOR=0
RUN_UI=1

for arg in "$@"; do
  case "$arg" in
    --dev) RUN_DEV=1 ;;
    --update) DO_UPDATE=1 ;;
    --resync-env) RESYNC_ENV=1 ;;
    --doctor) RUN_DOCTOR=1 ;;
    --no-ui) RUN_UI=0 ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="${ROOT_DIR}/agentsswarm"

if [ ! -d "${BRIDGE_DIR}" ]; then
  echo "[ERROR] agentsswarm directory not found."
  exit 1
fi

NEEDS_SETUP=0
[ -f "${BRIDGE_DIR}/.env" ] || NEEDS_SETUP=1
[ -d "${BRIDGE_DIR}/node_modules" ] || NEEDS_SETUP=1

if [ "${NEEDS_SETUP}" -eq 1 ]; then
  echo "[INFO] Bootstrap required. Running setup_agentsswarm.sh..."
  SETUP_ARGS=(--skip-tests)
  [ "${DO_UPDATE}" -eq 1 ] && SETUP_ARGS+=(--update)
  [ "${RESYNC_ENV}" -eq 1 ] && SETUP_ARGS+=(--resync-env)
  "${ROOT_DIR}/setup_agentsswarm.sh" "${SETUP_ARGS[@]}"
fi

cd "${BRIDGE_DIR}"
if [ "${RESYNC_ENV}" -eq 1 ]; then
  node "scripts/bootstrap-env.mjs" --startup --strict --resync-env
else
  node "scripts/bootstrap-env.mjs" --startup --strict
fi

if node -e "const fs=require('node:fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));process.exit(pkg.scripts&&pkg.scripts['startup-check']?0:1)" >/dev/null 2>&1; then
  if ! npm run startup-check; then
    echo "[ERROR] AgentSwarm startup checks failed. Fix the blocking issues above, then retry."
    exit 1
  fi
else
  echo "[WARN] startup-check script not found, falling back to preflight."
  if ! npm run preflight; then
    echo "[ERROR] AgentSwarm preflight failed. Fix the blocking issues above, then retry."
    exit 1
  fi
fi

TASK_EXECUTION_BACKEND="$(awk -F= '/^TASK_EXECUTION_BACKEND=/{print $2; exit}' .env 2>/dev/null)"
TASK_EXECUTION_BACKEND="${TASK_EXECUTION_BACKEND:-standalone}"
CONNECTOR_BACKEND="$(awk -F= '/^CONNECTOR_BACKEND=/{print $2; exit}' .env 2>/dev/null)"
CONNECTOR_BACKEND="${CONNECTOR_BACKEND:-none}"

check_port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1
    return $?
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn | grep -q ":${port} "
    return $?
  fi
  return 1
}

find_port_pid() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1
    return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | awk -v target=":${port}" '$4 ~ target {print $NF}' | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | head -n 1
    return 0
  fi
  return 1
}

if [ "${TASK_EXECUTION_BACKEND}" = "remote_api" ] && ! check_port_in_use 8790; then
  echo "[WARN] Remote execution API is not detected on port 8790."
  echo "[WARN] AgentSwarm will still start, but remote execution flows will fail until REMOTE_API_URL is reachable."
fi

BRIDGE_PORT="$(awk -F= '/^BRIDGE_PORT=/{print $2; exit}' .env 2>/dev/null)"
BRIDGE_PORT="${BRIDGE_PORT:-7799}"
UI_PORT="$(awk -F= '/^UI_PORT=/{print $2; exit}' .env 2>/dev/null)"
UI_PORT="${UI_PORT:-7800}"

if check_port_in_use "${BRIDGE_PORT}"; then
  EXISTING_PID="$(find_port_pid "${BRIDGE_PORT}" || true)"
  echo "[INFO] Stopping existing AgentSwarm process on port ${BRIDGE_PORT}${EXISTING_PID:+ (pid=${EXISTING_PID})} ..."
  if [ -n "${EXISTING_PID}" ]; then
    kill "${EXISTING_PID}" >/dev/null 2>&1 || true
  else
    pkill -f "node src/index.js" >/dev/null 2>&1 || true
  fi
  sleep 1
fi

if [ "${RUN_UI}" -eq 1 ]; then
  if [ ! -d "ui" ]; then
    echo "[WARN] UI directory not found. Skipping SPA UI launch."
    RUN_UI=0
  elif [ ! -d "ui/node_modules" ]; then
    echo "[INFO] Installing UI dependencies..."
    npm --prefix "ui" install || {
      echo "[WARN] UI dependency install failed. Skipping SPA UI launch."
      RUN_UI=0
    }
  fi
fi

if [ "${RUN_UI}" -eq 1 ] && check_port_in_use "${UI_PORT}"; then
  EXISTING_UI_PID="$(find_port_pid "${UI_PORT}" || true)"
  echo "[INFO] Stopping existing UI process on port ${UI_PORT}${EXISTING_UI_PID:+ (pid=${EXISTING_UI_PID})} ..."
  if [ -n "${EXISTING_UI_PID}" ]; then
    kill "${EXISTING_UI_PID}" >/dev/null 2>&1 || true
  fi
  sleep 1
fi

if [ "${DO_UPDATE}" -eq 1 ] && [ "${NEEDS_SETUP}" -eq 0 ]; then
  echo "[INFO] Applying npm update before launch..."
  npm update || echo "[WARN] npm update failed. Continuing with existing versions."
fi

if [ "${RUN_DOCTOR}" -eq 1 ]; then
  echo "[INFO] Startup checks passed. Doctor will be available after AgentSwarm is listening."
fi

echo "================================================"
echo "  AgentSwarm starting"
echo "  Service: secure local control plane with browser dashboard"
echo "  Execution Backend: ${TASK_EXECUTION_BACKEND}"
echo "  Connector Backend: ${CONNECTOR_BACKEND}"
echo "  Dashboard: http://127.0.0.1:${BRIDGE_PORT}/"
if [ "${RUN_UI}" -eq 1 ]; then
  echo "  SPA UI:  http://127.0.0.1:${UI_PORT}/dashboard (auto-started)"
else
  echo "  SPA UI:  disabled (--no-ui)"
fi
echo "  Health:  http://127.0.0.1:${BRIDGE_PORT}/health"
echo "  Tasks:   http://127.0.0.1:${BRIDGE_PORT}/tasks"
echo "  Routes:  BRIDGE_URL=http://127.0.0.1:${BRIDGE_PORT} npm run cli -- routes"
echo "  Resolve: BRIDGE_URL=http://127.0.0.1:${BRIDGE_PORT} npm run cli -- resolve-route --channel engineering"
echo "  Summary: BRIDGE_URL=http://127.0.0.1:${BRIDGE_PORT} npm run cli -- summary"
echo "================================================"

if [ "${RUN_UI}" -eq 1 ]; then
  echo "[INFO] Launching SPA UI on http://127.0.0.1:${UI_PORT}/dashboard ..."
  nohup npm --prefix "ui" run dev -- --port "${UI_PORT}" >/tmp/agentsswarm-ui.log 2>&1 &
  sleep 1
fi

if [ "${RUN_DEV}" -eq 1 ]; then
  echo "[INFO] Running in dev/watch mode."
  echo "[INFO] Open dashboard: http://127.0.0.1:${BRIDGE_PORT}/dashboard"
  npm run dev
else
  BRIDGE_URL="http://127.0.0.1:${BRIDGE_PORT}"
  if [ "${RUN_DOCTOR}" -eq 1 ]; then
    if ! npm run cli -- doctor; then
      echo "[ERROR] Doctor checks failed. Resolve reported issues before start."
      exit 1
    fi
  fi

  echo "[INFO] Launching AgentSwarm runtime in this shell..."
  echo "[INFO] Dashboard: http://127.0.0.1:${BRIDGE_PORT}/dashboard"
  npm start
fi
