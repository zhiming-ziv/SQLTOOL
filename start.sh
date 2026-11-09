#!/usr/bin/env bash
# SQLTool 一键启动（macOS / Linux / Git Bash）
set -e
cd "$(dirname "$0")"

PORT="${1:-8777}"
URL="http://127.0.0.1:${PORT}/app/index.html"

open_browser() {
  sleep 1
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 || true
  elif command -v start >/dev/null 2>&1; then start "$URL" >/dev/null 2>&1 || true
  fi
}

if command -v node >/dev/null 2>&1; then
  if [ ! -d node_modules/mysql2 ]; then
    echo ""
    echo "  [!] node_modules 未安装 —— 远程数据库（MySQL / PostgreSQL / SQL Server）不可用。"
    echo "      执行一次 npm install 即可启用；浏览器内 SQLite 不受影响。"
    echo ""
  fi
  open_browser &
  exec node server.js "$PORT"
elif command -v python3 >/dev/null 2>&1; then
  echo ""
  echo "  [!] 未找到 Node.js —— 回退到 Python 静态服务器。"
  echo "      只有浏览器内 SQLite 引擎可用；远程数据库需要 node server.js。"
  echo ""
  open_browser &
  exec python3 -m http.server "$PORT" --bind 127.0.0.1
elif command -v python >/dev/null 2>&1; then
  echo ""
  echo "  [!] 未找到 Node.js —— 回退到 Python 静态服务器。"
  echo "      只有浏览器内 SQLite 引擎可用；远程数据库需要 node server.js。"
  echo ""
  open_browser &
  exec python -m http.server "$PORT" --bind 127.0.0.1
else
  echo "未找到 Node.js 或 Python，请先安装其中之一。"
  exit 1
fi
