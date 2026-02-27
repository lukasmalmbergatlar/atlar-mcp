# Atlar MCP Server

MCP server that connects Claude Desktop to the Atlar Treasury API. Provides tools for accounts, transactions, forecasted transactions, estimates, and scenarios.

## Prerequisites

- **Node.js** (v18+) — install from [nodejs.org](https://nodejs.org) or `brew install node`
- **Claude Desktop** — installed and opened at least once

## Quick Setup (via Cursor)

Clone this repo, open it in Cursor, and paste this prompt:

> Clone https://github.com/lukasmalmbergatlar/atlar-mcp.git and open it. Then run `ATLAR_API_KEY=YOUR_KEY ATLAR_API_SECRET=YOUR_SECRET ./setup.sh` to install dependencies, build the project, and configure Claude Desktop. Once it's done, remind me to restart Claude Desktop.

Replace `YOUR_KEY` and `YOUR_SECRET` with the actual Atlar API credentials.

## Manual Setup

```bash
# 1. Clone and install
git clone https://github.com/lukasmalmbergatlar/atlar-mcp.git
cd atlar-mcp
npm install
npm run build

# 2. Configure Claude Desktop
# Edit ~/Library/Application Support/Claude/claude_desktop_config.json
```

Add this to the `mcpServers` object in the config file:

```json
{
  "mcpServers": {
    "atlar-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/atlar-mcp/build/index.js"],
      "env": {
        "ATLAR_API_KEY": "your_key",
        "ATLAR_API_SECRET": "your_secret"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

## Available Tools

| Tool | Description |
|------|-------------|
| `get_accounts` | List bank accounts with balances |
| `list_entities` | List entities (companies/subsidiaries) |
| `get_entity` | Get a single entity by ID |
| `get_transactions` | List recent bank transactions |
| `list_forecasted_transactions` | List forecasted transactions and/or estimates |
| `get_forecasted_transaction` | Get a single forecasted transaction by ID |
| `create_forecasted_transaction` | Create a forecasted transaction or estimate |
| `update_forecasted_transaction` | Update a forecasted transaction or estimate |
| `delete_forecasted_transaction` | Delete a forecasted transaction or estimate |
| `list_scenarios` | List forecast scenarios |
| `get_scenario` | Get a single scenario by ID |
| `create_scenario` | Create a scenario with optional adjustments |
| `update_scenario` | Update a scenario |
| `delete_scenario` | Delete a scenario |
| `read_saved_data` | Query/filter saved temp files from list tools |

List tools return compact summaries and save full data to temp files. Use `read_saved_data` to drill into the full data with filtering, sorting, and pagination.
