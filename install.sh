#!/usr/bin/env bash
# claude-context-size-guard — install shim.
# Delegates to bin/install.js.

set -e

if ! command -v node >/dev/null 2>&1; then
  echo "claude-context-size-guard: node is required (Node.js 18+)"
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/bin/install.js" "$@"
