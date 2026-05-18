#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# 0. 先提交已有改动（确保工作区干净，npm version 才能成功）
if [ -n "$(git status --porcelain)" ]; then
  echo "==> 提交未暂存的改动..."
  git add -A
  git commit -m "chore: pre-release commit"
fi

# 1. 升版本（以 server 为准，agent 同步）
# 支持参数: ./scripts/release.sh          → patch
#           ./scripts/release.sh minor     → minor
#           ./scripts/release.sh 0.2.0     → 指定版本
BUMP="${1:-patch}"
cd "$ROOT_DIR/apps/server"
VERSION=$(npm version "$BUMP" | sed 's/^v//')
echo "==> 版本: $VERSION"

cd "$ROOT_DIR/apps/agent"
npm version --no-git-tag-version "$VERSION" > /dev/null
cd "$ROOT_DIR"

# 2. 恢复测试文件（git show 可能不在 dist 里）
git show HEAD:apps/server/src/index.test.ts > apps/server/src/index.test.ts 2>/dev/null || true
git show HEAD:packages/shared/src/index.test.ts > packages/shared/src/index.test.ts 2>/dev/null || true

# 3. 构建 + 测试
echo "==> 构建..."
pnpm build

echo "==> 测试..."
pnpm test 2>&1 | tail -3

# 4. 提交 + tag + push
echo "==> 提交并推送..."
git add -A
git commit --amend -m "release: v$VERSION"
git tag "v$VERSION"
git push origin main --tags --force-with-lease

echo ""
echo "==> v$VERSION 已推送，CI 将自动发布到 npm"
echo "    https://github.com/siliconbeat/ai-teams/actions"
