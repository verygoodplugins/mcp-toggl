# MCP Toggl Server

A Model Context Protocol (MCP) server for Toggl Track integration, providing time tracking and reporting capabilities with intelligent caching for optimal performance.

<a href="https://glama.ai/mcp/servers/@verygoodplugins/mcp-toggl">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@verygoodplugins/mcp-toggl/badge" alt="Toggl Server MCP server" />
</a>

## Features

- **Time Tracking**: Start/stop timers, get current and past time entries
- **Smart Reporting**: Daily/weekly reports with project and workspace breakdowns  
- **Performance Optimized**: Intelligent caching system minimizes API calls
- **Data Hydration**: Automatically enriches time entries with project/workspace/client names
- **Flexible Filtering**: Query by date ranges, workspaces, or projects
- **Automation Ready**: Structured JSON output perfect for Automation Hub workflows

## Quick Start (Recommended)

Use via npx without cloning or building locally.

### Claude Desktop
Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "mcp-toggl": {
      "command": "npx @verygoodplugins/mcp-toggl@latest",
      "env": {
        "TOGGL_API_KEY": "your_api_key_here",
        "TOGGL_DEFAULT_WORKSPACE_ID": "123456",
        "TOGGL_CACHE_TTL": "3600000",
        "TOGGL_CACHE_SIZE": "1000"
      }
    }
  }
}
```

### Cursor
Add this to your Cursor MCP settings (e.g., `~/.cursor/mcp.json`):
```json
{
  "mcp": {
    "servers": {
      "mcp-toggl": {
        "command": "npx",
        "args": ["@verygoodplugins/mcp-toggl@latest"],
        "env": {
          "TOGGL_API_KEY": "your_api_key_here",
          "TOGGL_DEFAULT_WORKSPACE_ID": "123456",
          "TOGGL_CACHE_TTL": "3600000",
          "TOGGL_CACHE_SIZE": "1000"
        }
      }
    }
  }
}
```

## Manual Installation

```bash
npm install
npm run build
```

## Configuration

1. Get your Toggl API key from: https://track.toggl.com/profile

2. Create a `.env` file:
```env
TOGGL_API_KEY=your_api_key_here

# Aliases also supported (use one of these only if needed):
# TOGGL_API_TOKEN=your_api_key_here
# TOGGL_TOKEN=your_api_key_here

# Optional configuration
TOGGL_DEFAULT_WORKSPACE_ID=123456  # Your default workspace
TOGGL_CACHE_TTL=3600000            # Cache TTL in ms (default: 1 hour)
TOGGL_CACHE_SIZE=1000              # Max cached entities (default: 1000)
```

3. Add to your MCP configuration:

### Claude Desktop
Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "mcp-toggl": {
      "command": "node",
      "args": ["/path/to/mcp-toggl/dist/index.js"],
      "env": {
        "TOGGL_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Cursor
Edit `.mcp.json` in your project:
```json
{
  "mcpServers": {
    "mcp-toggl": {
      "command": "node",
      "args": ["./mcp-servers/mcp-toggl/dist/index.js"],
      "env": {
        "TOGGL_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

## Available Tools

### Time Tracking

#### `toggl_get_time_entries`
Get time entries with optional filters.
```json
{
  "period": "today",  // or: yesterday, week, lastWeek, month, lastMonth
  "workspace_id": 123456,
  "project_id": 789012
}
```

#### `toggl_get_current_entry`
Get the currently running timer.

#### `toggl_start_timer`
Start a new time entry.
```json
{
  "description": "Working on MCP server",
  "project_id": 123456,
  "tags": ["development", "mcp"]
}
```

#### `toggl_stop_timer`
Stop the currently running timer.

### Reporting

#### `toggl_daily_report`
Generate a daily report with project/workspace breakdowns.
```json
{
  "date": "2024-09-01",
  "format": "json"  // or "text" for formatted output
}
```

#### `toggl_weekly_report`
Generate a weekly report with daily breakdowns.
```json
{
  "week_offset": 0,  // 0 = this week, -1 = last week
  "format": "json"
}
```

#### `toggl_project_summary`
Get total hours per project for a date range.
```json
{
  "period": "month",
  "workspace_id": 123456
}
```

#### `toggl_workspace_summary`
Get total hours per workspace.

### Management

#### `toggl_list_workspaces`
List all available workspaces.

#### `toggl_list_projects`
List projects in a workspace.
```json
{
  "workspace_id": 123456
}
```

#### `toggl_list_clients`
List clients in a workspace.

### Cache Management

#### `toggl_warm_cache`
Pre-fetch workspace/project/client data for better performance.

#### `toggl_cache_stats`
View cache performance metrics.

#### `toggl_clear_cache`
Clear all cached data.

## Performance Optimization

The server uses an intelligent caching system to minimize API calls:

1. **First Run**: Warms cache by fetching workspaces, projects, and clients
2. **Subsequent Calls**: Uses cached names for hydration (95%+ cache hit rate)
3. **Smart Invalidation**: TTL-based expiry with configurable duration
4. **Memory Efficient**: LRU eviction keeps memory usage under 10MB

### Typical Performance
- First report: 2-3 API calls (warm cache + get entries)
- Subsequent reports: 1 API call (just time entries)
- Cache hit rate: >95% for typical usage

## Usage Examples

### Daily Standup Report
```javascript
// Get today's time entries with full details
toggl_daily_report({ "format": "text" })
```

### Weekly Summary for Automation Hub
```javascript
// Get last week's data as JSON
toggl_weekly_report({ "week_offset": -1 })
```

### Project Hours Tracking
```javascript
// Get this month's hours by project
toggl_project_summary({ "period": "month" })
```

## Integration with Automation Hub

The server returns structured JSON perfect for Automation Hub workflows:

```javascript
// Example daily report output
{
  "date": "2024-09-01",
  "total_hours": 8.5,
  "by_project": [
    {
      "project_name": "MCP Development",
      "client_name": "Internal",
      "total_hours": 4.5,
      "billable_hours": 0
    }
  ],
  "by_workspace": [
    {
      "workspace_name": "Very Good Plugins",
      "total_hours": 8.5,
      "project_count": 3
    }
  ]
}
```

## Troubleshooting

### API Key Issues
- Ensure your API key is correct (get from https://track.toggl.com/profile)
- API key goes in the username field, "api_token" as password for basic auth
- Trim whitespace: copy/paste can include trailing spaces/newlines which cause 401/403
- Accepted env var names: `TOGGL_API_KEY` (preferred), `TOGGL_API_TOKEN`, or `TOGGL_TOKEN`
- If you see 401/403, regenerate the token on your Toggl profile and update your MCP config

### Security & Token Lifecycle
- This server uses Basic Auth with a Toggl API token, not OAuth; there is no refresh token to manage.
- Toggl API tokens do not expire automatically. They only change if you manually regenerate them or if Toggl invalidates them during a security event.
- If you regenerate your token, the old one stops working immediately. Update the `TOGGL_API_KEY` in your Claude/Cursor config and restart the client.
- Never commit real secrets to version control. Use placeholders like `your_api_key_here` in docs and examples.
- Claude Desktop stores the env value in `claude_desktop_config.json` on your machine. Treat that file as sensitive and do not share it.

### Quick Auth Check
You can verify connectivity by calling the `toggl_check_auth` tool, which pings `/me` and lists your available workspaces without exposing your token.

### Rate Limiting
- The server implements automatic retry with exponential backoff
- Respects Toggl's rate limits (max 1 request per second)

### Cache Issues
- Run `toggl_clear_cache` if data seems stale
- Adjust `TOGGL_CACHE_TTL` for your needs (default: 1 hour)

## Development

```bash
# Run in development mode
npm run dev

# Build for production
npm run build

# Test the server
npm test
```

## License

GPL-3.0

## Support

For issues or questions, please open an issue on GitHub.

---

Built with 🧡 for the open source community by [Very Good Plugins](https://verygoodplugins.com)