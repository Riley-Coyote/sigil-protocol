#!/usr/bin/env bash
set -euo pipefail

PROFILE_ROOT="$HOME/Library/Caches/ms-playwright"

pkill -f "user-data-dir=$PROFILE_ROOT/mcp-chrome" 2>/dev/null || true
pkill -f "user-data-dir=$PROFILE_ROOT/mcp-chrome-" 2>/dev/null || true

if [ -d "$PROFILE_ROOT" ]; then
  find "$PROFILE_ROOT" -maxdepth 3 -name 'Singleton*' -exec rm -f {} + 2>/dev/null || true
fi

echo "Playwright MCP Chrome profile locks cleared."
