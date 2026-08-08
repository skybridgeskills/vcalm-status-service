#!/usr/bin/env bash
# Full validation for the vcalm-status-service workspace.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT"

echo "==> workspace: format"
pnpm exec prettier --check .

echo "==> workspace: lint"
pnpm lint

echo "==> workspace: build"
pnpm build

echo "==> workspace: test"
pnpm test

echo "==> validate: OK"
