#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="/tmp/ai-teams-test-$(date +%s)"

echo "==> 构建..."
cd "$ROOT_DIR"
pnpm build

echo "==> 打包..."
cd "$ROOT_DIR/apps/server" && npm pack --pack-destination "$TEST_DIR" 2>&1 | tail -1
cd "$ROOT_DIR/apps/agent" && npm pack --pack-destination "$TEST_DIR" 2>&1 | tail -1

SERVER_TGZ="$TEST_DIR/csdwd-ai-teams-server-$(node -p "require('$ROOT_DIR/apps/server/package.json').version").tgz"
AGENT_TGZ="$TEST_DIR/csdwd-ai-teams-agent-$(node -p "require('$ROOT_DIR/apps/agent/package.json').version").tgz"

echo "==> 安装到 $TEST_DIR ..."
npm install -g "$SERVER_TGZ" "$AGENT_TGZ"

echo ""
echo "==> 验证版本号..."
echo -n "  server: " && ai-teams-server -v
echo -n "  agent:  " && ai-teams-agent -v

echo ""
echo "==> 验证 Web UI 静态文件..."
SERVER_LIB="$(which ai-teams-server | xargs realpath | xargs dirname)/../lib/node_modules/@csdwd/ai-teams-server"
if [ -d "$SERVER_LIB/dist/web" ]; then
  echo "  dist/web/ 存在，文件："
  find "$SERVER_LIB/dist/web" -type f | sed 's/^/    /'
else
  echo "  ❌ dist/web/ 不存在！Web UI 将不可用"
fi

echo ""
echo "==> 启动 server 测试（5秒后自动停止）..."
timeout 5 ai-teams-server --token test-local-123 --port 3789 2>&1 || true

echo ""
echo "==> 全部验证完成"
echo "    测试目录: $TEST_DIR"
echo "    手动测试: ai-teams-server --token your-token --port 3789"
