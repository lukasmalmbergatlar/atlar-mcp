#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

# Preflight: check for node and npm
if ! command -v node &> /dev/null; then
  echo "Error: Node.js is not installed. Install it from https://nodejs.org or via 'brew install node'."
  exit 1
fi
if ! command -v npm &> /dev/null; then
  echo "Error: npm is not installed."
  exit 1
fi

NODE_PATH="$(command -v node)"

echo "=== Atlar MCP Setup ==="
echo "Using node: $NODE_PATH"
echo ""

# 1. Install dependencies and build
echo "[1/3] Installing dependencies..."
npm install --prefix "$REPO_DIR"

echo "[2/3] Building..."
npm run build --prefix "$REPO_DIR"

# 2. Collect API credentials (via env vars — interactive prompts don't work in Cursor/CI)
echo ""
echo "[3/3] Configuring Claude Desktop..."
echo ""

if [ -z "$ATLAR_API_KEY" ] || [ -z "$ATLAR_API_SECRET" ]; then
  echo "Error: ATLAR_API_KEY and ATLAR_API_SECRET must be set as environment variables."
  echo ""
  echo "Usage: ATLAR_API_KEY=your_key ATLAR_API_SECRET=your_secret ./setup.sh"
  exit 1
fi

# 3. Update Claude Desktop config
SERVER_ENTRY=$(cat <<EOF
{
  "command": "$NODE_PATH",
  "args": ["$REPO_DIR/build/index.js"],
  "env": {
    "ATLAR_API_KEY": "$ATLAR_API_KEY",
    "ATLAR_API_SECRET": "$ATLAR_API_SECRET"
  }
}
EOF
)

if [ ! -f "$CLAUDE_CONFIG" ]; then
  mkdir -p "$(dirname "$CLAUDE_CONFIG")"
  echo "{\"mcpServers\":{}}" > "$CLAUDE_CONFIG"
fi

# Use node to safely merge into existing config (avoids jq dependency)
node -e "
  const fs = require('fs');
  const configPath = process.argv[1];
  const entry = JSON.parse(process.argv[2]);
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers['atlar-mcp'] = entry;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log('Updated: ' + configPath);
" "$CLAUDE_CONFIG" "$SERVER_ENTRY"

echo ""
echo "=== Done ==="
echo "Restart Claude Desktop to activate the Atlar MCP connection."
