#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# 1. 升版本（以 server 为准，agent 同步）
cd "$ROOT_DIR/apps/server"
VERSION=$(npm version patch | sed 's/^v//')
echo "==> 版本: $VERSION"

cd "$ROOT_DIR/apps/agent"
npm version --no-git-tag-version "$VERSION" > /dev/null

# 2. 构建 + 测试
echo "==> 构建..."
pnpm build

echo "==> 测试..."
pnpm test 2>&1 | tail -3

# 3. 提交 + tag + push
echo "==> 提交并推送..."
git add -A
git commit -m "release: v$VERSION"
git tag "v$VERSION"
git push origin main --tags

echo ""
echo "==> v$VERSION 已推送，CI 将自动发布到 npm"
echo "    https://github.com/siliconbeat/ai-teams/actions"
