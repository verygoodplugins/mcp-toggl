# Toggl MCP Local Setup

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- `TOGGL_API_TOKEN`: your token from <https://track.toggl.com/profile>

Optional:

- `TOGGL_DEFAULT_WORKSPACE_ID`: avoids workspace selection when multiple workspaces exist
- `TOGGL_PROJECT_ALIASES_FILE`: absolute path to an alternate alias JSON file

## Install And Verify

```bash
git clone https://github.com/verygoodplugins/mcp-toggl.git
cd mcp-toggl
npm install
npm run build
npm test
TOGGL_API_TOKEN="$(cat ~/.config/toggl/api_token)" npm run test:live
```

The live test creates temporary one-second entries, verifies the MCP tools against Toggl API v9,
and deletes the test entries afterward. It does not interrupt an already-running user timer.

## Project Aliases

Copy the example, then replace the sample IDs with project IDs from your Toggl workspace:

```bash
cp config/project-aliases.example.json config/project-aliases.json
```

The real `config/project-aliases.json` is gitignored so personal workspace IDs are not published.
Keys are case-insensitive short aliases and values are Toggl project IDs:

```json
{
  "writing": 123456789,
  "service": 987654321
}
```

Use aliases with `toggl_start_timer` or `toggl_create_time_entry` via `project_alias`.

## Claude Desktop

Merge the `mcpServers.toggl` object from `claude_desktop_config.example.json` into:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Replace `your_api_token_here`, then restart Claude Desktop.

## Claude Code

Claude Code defines project MCP servers in `.mcp.json`, not directly in `.claude/settings.json`.
Copy or merge `.mcp.json.example` into the project root as `.mcp.json`, replace its absolute paths,
export `TOGGL_API_TOKEN`, and approve the server when Claude Code prompts.

To explicitly enable this project MCP from `.claude/settings.json`, add:

```json
{
  "enabledMcpjsonServers": ["toggl"]
}
```

## Core Tools

- `toggl_start_timer`: start a timer using `project_id` or `project_alias`
- `toggl_stop_timer`: stop the current timer
- `toggl_get_current_entry`: get the current timer
- `toggl_get_time_entries`: list recent entries
- `toggl_list_projects`: list projects
- `toggl_create_time_entry`: create a completed entry with description, duration, and project
- `toggl_list_project_aliases`: inspect configured aliases
