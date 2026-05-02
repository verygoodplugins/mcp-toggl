#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from 'dotenv';
import { TogglAPI, TimelineNotEnabledError, TogglAPIError } from './toggl-api.js';
import { buildTimelineResponse } from './timeline.js';
import { CacheManager } from './cache-manager.js';
import { WorkspaceResolutionError, parseWorkspaceId, resolveWorkspaceId } from './workspace.js';
import {
  getDateRange,
  generateDailyReport,
  generateWeeklyReport,
  formatReportForDisplay,
  secondsToHours,
  groupEntriesByProject,
  groupEntriesByWorkspace,
  generateProjectSummary,
  generateWorkspaceSummary,
  toLocalYMD,
  parseLocalYMD,
  localDateRangeFromArgs,
} from './utils.js';
import type {
  CacheConfig,
  CreateProjectRequest,
  ProjectDeleteMode,
  TimelineEvent,
  TimeEntry,
  UpdateProjectRequest,
  UpdateTimeEntryRequest,
} from './types.js';

function parseInclusiveEndDate(value: string): Date {
  const date = parseLocalYMD(value);
  date.setDate(date.getDate() + 1);
  return date;
}

function jsonResponse(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An error occurred';
}

function isUserInputError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;

  return [
    'Invalid date format:',
    'Invalid calendar date:',
    'Invalid period:',
    'Invalid argument:',
    'start_date must',
    'end_date must',
    'title_mode must',
    'start is required',
    'Provide either stop or duration',
    'entry_id is required',
    'No fields to update',
    'project_id is required',
    'Project name is required',
  ].some((prefix) => error.message.startsWith(prefix));
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof TogglAPIError) {
    const payload: Record<string, unknown> = {
      error: true,
      message: error.message,
      code: error.code,
      status: error.status,
    };
    payload.code = error.code;
    if (error.retry_after_seconds !== undefined) {
      payload.retry_after_seconds = error.retry_after_seconds;
    }
    if (error.tip) {
      payload.tip = error.tip;
    }
    return payload;
  }

  if (error instanceof WorkspaceResolutionError) {
    return {
      error: true,
      message: error.message,
      code: error.code,
      tip: error.tip,
      available_workspaces: error.available_workspaces,
    };
  }

  if (isUserInputError(error)) {
    return {
      error: true,
      code: 'INVALID_ARGUMENT',
      message: errorMessage(error),
    };
  }

  console.error('Unhandled tool error:', error);
  return {
    error: true,
    code: 'INTERNAL_ERROR',
    message: 'Internal server error. Check server logs for details.',
  };
}

// Version for CLI output and server metadata
const VERSION = '1.1.0';

// Basic CLI flags: --help / -h and --version / -v
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  console.error(`mcp-toggl version ${VERSION}`);
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.error(
    `mcp-toggl - Toggl MCP Server\n\n` +
      `Usage:\n` +
      `  npx @verygoodplugins/mcp-toggl@latest [--help] [--version]\n\n` +
      `Environment:\n` +
      `  TOGGL_API_KEY                Required Toggl API token (or TOGGL_API_TOKEN)\n` +
      `  TOGGL_DEFAULT_WORKSPACE_ID   Optional default workspace id\n` +
      `  TOGGL_CACHE_TTL              Cache TTL in ms (default: 3600000)\n` +
      `  TOGGL_CACHE_SIZE             Max cached entities (default: 1000)\n\n` +
      `  TRANSPORT                    stdio or http (default: stdio)\n` +
      `  MCP_HTTP_AUTH_TOKEN          Required bearer token when TRANSPORT=http\n` +
      `  PORT                         HTTP port when TRANSPORT=http (default: 3000)\n\n` +
      `Claude Desktop (claude_desktop_config.json):\n` +
      `  {\n` +
      `    "mcpServers": {\n` +
      `      "mcp-toggl": {\n` +
      `        "command": "npx @verygoodplugins/mcp-toggl@latest",\n` +
      `        "env": { "TOGGL_API_KEY": "your_api_key_here" }\n` +
      `      }\n` +
      `    }\n` +
      `  }\n\n` +
      `Cursor (~/.cursor/mcp.json):\n` +
      `  {\n` +
      `    "mcp": {\n` +
      `      "servers": {\n` +
      `        "mcp-toggl": {\n` +
      `          "command": "npx",\n` +
      `          "args": ["@verygoodplugins/mcp-toggl@latest"],\n` +
      `          "env": { "TOGGL_API_KEY": "your_api_key_here" }\n` +
      `        }\n` +
      `      }\n` +
      `    }\n` +
      `  }\n`
  );
  process.exit(0);
}

// Load environment variables
config({ quiet: true });

// Validate required environment variables
// Support a few aliases for convenience/backward-compat
const RAW_API_KEY =
  process.env.TOGGL_API_KEY || process.env.TOGGL_API_TOKEN || process.env.TOGGL_TOKEN;

const API_KEY = RAW_API_KEY?.trim();

if (!API_KEY) {
  console.error('Missing required environment variable: TOGGL_API_KEY or TOGGL_API_TOKEN');
  console.error('Also accepted: TOGGL_TOKEN');
  process.exit(1);
}

if (!process.env.TOGGL_API_KEY && !process.env.TOGGL_API_TOKEN && process.env.TOGGL_TOKEN) {
  console.warn('Using TOGGL_TOKEN. Prefer TOGGL_API_KEY or TOGGL_API_TOKEN going forward.');
}

// Initialize configuration
const cacheConfig: CacheConfig = {
  ttl: parseInt(process.env.TOGGL_CACHE_TTL || '3600000'),
  maxSize: parseInt(process.env.TOGGL_CACHE_SIZE || '1000'),
  batchSize: parseInt(process.env.TOGGL_BATCH_SIZE || '100'),
};

const defaultWorkspaceId = parseWorkspaceId(process.env.TOGGL_DEFAULT_WORKSPACE_ID);

// Initialize API and cache
const api = new TogglAPI(API_KEY);
const cache = new CacheManager(cacheConfig);
cache.setAPI(api);

// Track if cache has been warmed
let cacheWarmed = false;

// Helper to ensure cache is warm
async function ensureCache(): Promise<void> {
  if (!cacheWarmed) {
    try {
      const workspaces = await cache.getWorkspaces();
      const singleWorkspaceId = workspaces.length === 1 ? workspaces[0]!.id : undefined;
      const workspaceIdToWarm = defaultWorkspaceId || singleWorkspaceId;
      if (workspaceIdToWarm) {
        await cache.warmCache(workspaceIdToWarm);
      }
      cacheWarmed = true;
    } catch (error) {
      console.error('Failed to warm cache:', error);
    }
  }
}

async function resolveWorkspaceForTool(
  args: Record<string, unknown> | undefined,
  action: string
): Promise<number> {
  return resolveWorkspaceId({
    explicitWorkspaceId: args?.workspace_id,
    defaultWorkspaceId,
    getWorkspaces: () => cache.getWorkspaces(),
    action,
  });
}

function invalidArgument(message: string): never {
  throw new Error(`Invalid argument: ${message}`);
}

function optionalStringArg(
  args: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalidArgument(`${key} must be a string`);
  return value;
}

function requiredNonEmptyStringArg(
  args: Record<string, unknown> | undefined,
  key: string,
  missingMessage: string
): string {
  const value = args?.[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(missingMessage);
  }
  return value;
}

function optionalFiniteNumberArg(
  args: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidArgument(`${key} must be a finite number`);
  }
  return value;
}

function requiredFiniteNumberArg(
  args: Record<string, unknown> | undefined,
  key: string,
  missingMessage: string
): number {
  if (args?.[key] === undefined) {
    throw new Error(missingMessage);
  }
  return optionalFiniteNumberArg(args, key)!;
}

function optionalBooleanArg(
  args: Record<string, unknown> | undefined,
  key: string
): boolean | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') invalidArgument(`${key} must be a boolean`);
  return value;
}

function optionalStringArrayArg(
  args: Record<string, unknown> | undefined,
  key: string
): string[] | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    invalidArgument(`${key} must be an array of strings`);
  }
  return value;
}

function optionalNumberArrayArg(
  args: Record<string, unknown> | undefined,
  key: string
): number[] | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'number' || !Number.isFinite(item))
  ) {
    invalidArgument(`${key} must be an array of finite numbers`);
  }
  return value;
}

// Define tool schemas
const tools: Tool[] = [
  // Health/authentication
  {
    name: 'toggl_check_auth',
    description: 'Verify Toggl API connectivity and authentication is valid',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  // Time tracking tools
  {
    name: 'toggl_get_time_entries',
    description:
      'Get time entries with optional date range filters. Returns hydrated entries with project/workspace names.',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined period to fetch entries for',
        },
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD format, inclusive, local timezone)',
        },
        end_date: {
          type: 'string',
          description: 'End date (YYYY-MM-DD format, inclusive, local timezone)',
        },
        workspace_id: {
          type: 'number',
          description: 'Filter by workspace ID',
        },
        project_id: {
          type: 'number',
          description: 'Filter by project ID',
        },
      },
    },
  },
  {
    name: 'toggl_get_current_entry',
    description: 'Get the currently running time entry, if any',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'toggl_start_timer',
    description: 'Start a new time entry timer',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Description of the time entry',
        },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
        project_id: {
          type: 'number',
          description: 'Project ID (optional)',
        },
        task_id: {
          type: 'number',
          description: 'Task ID (optional)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for the entry',
        },
        billable: {
          type: 'boolean',
          description:
            'Whether the entry is billable. If omitted, Toggl applies the project default. Some Toggl plans ignore this flag and treat the entry as non-billable.',
        },
      },
    },
  },
  {
    name: 'toggl_stop_timer',
    description: 'Stop the currently running timer',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'toggl_create_time_entry',
    description:
      'Create a completed time entry for retroactively logging past work. Provide either stop or duration, not both. For a live timer, use toggl_start_timer.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        start: {
          type: 'string',
          description: 'ISO 8601 datetime when the entry began',
        },
        stop: {
          type: 'string',
          description: 'ISO 8601 datetime when the entry ended. Provide stop or duration.',
        },
        duration: {
          type: 'number',
          description: 'Duration in seconds. Provide stop or duration.',
        },
        description: {
          type: 'string',
          description: 'Description of the time entry',
        },
        project_id: {
          type: 'number',
          description: 'Project ID (optional)',
        },
        task_id: {
          type: 'number',
          description: 'Task ID (optional)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tag names; Toggl resolves them server-side',
        },
        tag_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Tag IDs, alternative to tags',
        },
        billable: {
          type: 'boolean',
          description:
            'Whether the entry is billable. If omitted, Toggl applies the project default. Some Toggl plans ignore this flag and treat the entry as non-billable.',
        },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
      required: ['start'],
      oneOf: [{ required: ['stop'] }, { required: ['duration'] }],
    },
  },
  {
    name: 'toggl_update_time_entry',
    description: 'Update fields on an existing time entry. Pass only the fields to change.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: {
          type: 'number',
          description: 'Time entry ID to update',
        },
        description: {
          type: 'string',
          description: 'Updated description',
        },
        project_id: {
          type: 'number',
          description: 'Updated project ID',
        },
        task_id: {
          type: 'number',
          description: 'Updated task ID',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tag names; replaces existing tags on the entry',
        },
        tag_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Tag IDs; replaces existing tags on the entry',
        },
        billable: {
          type: 'boolean',
          description:
            'Whether the entry is billable. Some Toggl plans ignore this flag and treat the entry as non-billable.',
        },
        start: {
          type: 'string',
          description: 'Updated ISO 8601 start datetime',
        },
        stop: {
          type: 'string',
          description: 'Updated ISO 8601 stop datetime',
        },
        duration: {
          type: 'number',
          description: 'Updated duration in seconds',
        },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
      required: ['entry_id'],
    },
  },
  {
    name: 'toggl_delete_time_entry',
    description: 'Delete a time entry by ID',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: {
          type: 'number',
          description: 'Time entry ID to delete',
        },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
      required: ['entry_id'],
    },
  },

  // Reporting tools
  {
    name: 'toggl_daily_report',
    description: 'Generate a daily report with hours by project and workspace',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Date for report (YYYY-MM-DD format, defaults to today)',
        },
        format: {
          type: 'string',
          enum: ['json', 'text'],
          description: 'Output format (default: json)',
        },
      },
    },
  },
  {
    name: 'toggl_weekly_report',
    description: 'Generate a weekly report with daily breakdown and project summaries',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        week_offset: {
          type: 'number',
          description: 'Week offset from current week (0 = this week, -1 = last week)',
        },
        format: {
          type: 'string',
          enum: ['json', 'text'],
          description: 'Output format (default: json)',
        },
      },
    },
  },
  {
    name: 'toggl_project_summary',
    description: 'Get total hours per project for a date range',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined period',
        },
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD format, inclusive, local timezone)',
        },
        end_date: {
          type: 'string',
          description: 'End date (YYYY-MM-DD format, inclusive, local timezone)',
        },
        workspace_id: {
          type: 'number',
          description: 'Filter by workspace ID',
        },
      },
    },
  },
  {
    name: 'toggl_workspace_summary',
    description: 'Get total hours per workspace for a date range',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined period',
        },
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD format, inclusive, local timezone)',
        },
        end_date: {
          type: 'string',
          description: 'End date (YYYY-MM-DD format, inclusive, local timezone)',
        },
      },
    },
  },

  // Management tools
  {
    name: 'toggl_list_workspaces',
    description: 'List all available workspaces',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'toggl_list_projects',
    description: 'List projects for a workspace',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
    },
  },
  {
    name: 'toggl_list_clients',
    description: 'List clients for a workspace',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
    },
  },
  {
    name: 'toggl_create_project',
    description: 'Create a new project in a workspace',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name' },
        client_id: { type: 'number', description: 'Client ID to assign the project to' },
        is_private: {
          type: 'boolean',
          description: 'Whether the project is private. Defaults to false.',
        },
        active: {
          type: 'boolean',
          description: 'Whether the project is active. Defaults to true.',
        },
        color: { type: 'string', description: 'Hex color (e.g. "#06aaf5")' },
        billable: {
          type: 'boolean',
          description:
            'Whether time tracked on this project is billable by default. Note: some Toggl plans (Free) ignore this flag.',
        },
        auto_estimates: { type: 'boolean', description: 'Enable auto-estimates' },
        estimated_hours: { type: 'number', description: 'Estimated hours for the project' },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'toggl_update_project',
    description:
      'Update fields on an existing project. Pass only the fields to change. Set active=false to archive; pass client_id=null to remove the client assignment.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Project ID to update' },
        name: { type: 'string', description: 'New project name' },
        client_id: {
          type: ['number', 'null'],
          description: 'New client ID; pass null to remove the assignment',
        },
        is_private: { type: 'boolean' },
        active: {
          type: 'boolean',
          description: 'Set to false to archive the project',
        },
        color: { type: 'string', description: 'Hex color (e.g. "#06aaf5")' },
        billable: {
          type: 'boolean',
          description:
            'Whether time tracked on this project is billable by default. Note: some Toggl plans (Free) ignore this flag.',
        },
        auto_estimates: { type: 'boolean' },
        estimated_hours: { type: 'number' },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'toggl_delete_project',
    description: 'Delete a project by ID',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Project ID to delete' },
        time_entry_deletion_mode: {
          type: 'string',
          enum: ['delete', 'unassign'],
          description:
            "How to handle time entries on this project: 'delete' removes them; 'unassign' detaches them. If omitted, Toggl applies its default.",
        },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'toggl_list_tasks',
    description: 'List tasks for a project in a workspace',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'number',
          description: 'Project ID to list tasks for',
        },
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
      required: ['project_id'],
    },
  },

  // Cache management
  {
    name: 'toggl_warm_cache',
    description:
      'Pre-fetch and cache workspace, project, client, and tag data for better performance',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'number',
          description:
            'Workspace ID to warm. If omitted, uses TOGGL_DEFAULT_WORKSPACE_ID or the only available workspace; required when multiple workspaces exist.',
        },
      },
    },
  },
  {
    name: 'toggl_cache_stats',
    description: 'Get cache statistics and performance metrics',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'toggl_clear_cache',
    description: 'Clear all cached data',
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'toggl_get_timeline',
    description:
      'Get Toggl Desktop activity timeline showing application usage. PRIVACY NOTE: window titles are redacted by default because they may contain document names, email subjects, chat text, URLs, OAuth pages, or database names; set title_mode: "raw" only when you explicitly need original titles. Requires Toggl Track Desktop timeline sync to be enabled. Response semantics: summary is { [appName: string]: total_seconds }; total_events is the post-filter event count; returned_events is the returned events array length; truncated means only the events array was limited, never the summary. limit does not affect summary calculation. total_seconds is canonical; total_hours is rounded to 4 decimals for display.',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined period (alternative to start_date/end_date)',
        },
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD format, inclusive, local timezone)',
        },
        end_date: {
          type: 'string',
          description: 'End date (YYYY-MM-DD format, inclusive, local timezone)',
        },
        app: {
          type: 'string',
          description: 'Filter by application name, case-insensitive partial match',
        },
        include_events: {
          type: 'boolean',
          description: 'Include raw events array (default: true). Set false for summary only.',
        },
        title_mode: {
          type: 'string',
          enum: ['redacted', 'raw'],
          default: 'redacted',
          description:
            'Window title privacy mode. Default redacted removes event titles; raw returns original window titles and should only be used when you explicitly need them.',
        },
        redact_titles: {
          type: 'boolean',
          default: true,
          deprecated: true,
          description:
            'Deprecated compatibility flag. When title_mode is omitted, true redacts titles and false returns raw titles.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 1000,
          default: 50,
          description:
            'Maximum events to return in events array (default: 50, max: 1000). Does not affect summary calculation.',
        },
      },
    },
  },
];

export function createTogglServer(): Server {
  const server = new Server(
    {
      name: 'mcp-toggl',
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // Health/authentication
        case 'toggl_check_auth': {
          const me = await api.getMe();
          const workspaces = await cache.getWorkspaces();
          const maskEmail = (e?: string) => {
            if (!e) return undefined as unknown as string;
            const [user, domain] = e.split('@');
            if (!domain) return '***';
            const u = user.length <= 2 ? '*'.repeat(user.length) : `${user[0]}***${user.slice(-1)}`;
            return `${u}@${domain}`;
          };
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    authenticated: true,
                    user: {
                      id: (me as any).id,
                      email: maskEmail((me as any).email),
                      fullname: (me as any).fullname,
                    },
                    workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Time tracking tools
        case 'toggl_get_time_entries': {
          await ensureCache();

          let entries: TimeEntry[];

          if (args?.period) {
            const range = getDateRange(args.period as any);
            entries = await api.getTimeEntriesForDateRange(range.start, range.end);
          } else if (args?.start_date || args?.end_date) {
            const start = args?.start_date ? parseLocalYMD(args.start_date as string) : new Date();
            start.setHours(0, 0, 0, 0);
            const end = args?.end_date
              ? parseInclusiveEndDate(args.end_date as string)
              : new Date();
            if (!args?.end_date) {
              end.setHours(0, 0, 0, 0);
              end.setDate(end.getDate() + 1);
            }
            entries = await api.getTimeEntriesForDateRange(start, end);
          } else {
            entries = await api.getTimeEntriesForToday();
          }

          // Filter by workspace/project if specified
          if (args?.workspace_id) {
            entries = entries.filter((e) => e.workspace_id === args.workspace_id);
          }
          if (args?.project_id) {
            entries = entries.filter((e) => e.project_id === args.project_id);
          }

          // Hydrate with names
          const hydrated = await cache.hydrateTimeEntries(entries);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    count: hydrated.length,
                    entries: hydrated,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'toggl_get_current_entry': {
          const entry = await api.getCurrentTimeEntry();

          if (!entry) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    running: false,
                    message: 'No timer currently running',
                  }),
                },
              ],
            };
          }

          await ensureCache();
          const hydrated = await cache.hydrateTimeEntries([entry]);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    running: true,
                    entry: hydrated[0],
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'toggl_start_timer': {
          const workspaceId = await resolveWorkspaceForTool(args, 'starting a timer');

          const entry = await api.startTimer(
            workspaceId,
            optionalStringArg(args, 'description'),
            optionalFiniteNumberArg(args, 'project_id'),
            optionalFiniteNumberArg(args, 'task_id'),
            optionalStringArrayArg(args, 'tags'),
            optionalBooleanArg(args, 'billable')
          );

          await ensureCache();
          const hydrated = await cache.hydrateTimeEntries([entry]);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    message: 'Timer started',
                    entry: hydrated[0],
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'toggl_stop_timer': {
          const current = await api.getCurrentTimeEntry();

          if (!current) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    message: 'No timer currently running',
                  }),
                },
              ],
            };
          }

          const stopped = await api.stopTimer(current.workspace_id, current.id);

          await ensureCache();
          const hydrated = await cache.hydrateTimeEntries([stopped]);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    message: 'Timer stopped',
                    entry: hydrated[0],
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'toggl_create_time_entry': {
          const workspaceId = await resolveWorkspaceForTool(args, 'creating a time entry');
          const start = requiredNonEmptyStringArg(
            args,
            'start',
            'start is required (ISO 8601 datetime)'
          );
          const stop = optionalStringArg(args, 'stop');
          const duration = optionalFiniteNumberArg(args, 'duration');
          if (stop !== undefined && duration !== undefined) {
            throw new Error('Provide either stop or duration, not both');
          }
          if (stop === undefined && duration === undefined) {
            throw new Error('Provide either stop or duration');
          }

          const entry = await api.createTimeEntry(workspaceId, {
            start,
            stop,
            duration,
            description: optionalStringArg(args, 'description'),
            project_id: optionalFiniteNumberArg(args, 'project_id'),
            task_id: optionalFiniteNumberArg(args, 'task_id'),
            tags: optionalStringArrayArg(args, 'tags'),
            tag_ids: optionalNumberArrayArg(args, 'tag_ids'),
            billable: optionalBooleanArg(args, 'billable'),
          });

          await ensureCache();
          const hydrated = await cache.hydrateTimeEntries([entry]);

          return jsonResponse({
            success: true,
            message: 'Time entry created',
            entry: hydrated[0],
          });
        }

        case 'toggl_update_time_entry': {
          const workspaceId = await resolveWorkspaceForTool(args, 'updating a time entry');
          const entryId = requiredFiniteNumberArg(args, 'entry_id', 'entry_id is required');

          const updates: UpdateTimeEntryRequest = {};
          const description = optionalStringArg(args, 'description');
          const projectId = optionalFiniteNumberArg(args, 'project_id');
          const taskId = optionalFiniteNumberArg(args, 'task_id');
          const tags = optionalStringArrayArg(args, 'tags');
          const tagIds = optionalNumberArrayArg(args, 'tag_ids');
          const billable = optionalBooleanArg(args, 'billable');
          const start = optionalStringArg(args, 'start');
          const stop = optionalStringArg(args, 'stop');
          const duration = optionalFiniteNumberArg(args, 'duration');

          if (description !== undefined) updates.description = description;
          if (projectId !== undefined) updates.project_id = projectId;
          if (taskId !== undefined) updates.task_id = taskId;
          if (tags !== undefined) updates.tags = tags;
          if (tagIds !== undefined) updates.tag_ids = tagIds;
          if (billable !== undefined) updates.billable = billable;
          if (start !== undefined) updates.start = start;
          if (stop !== undefined) updates.stop = stop;
          if (duration !== undefined) updates.duration = duration;

          if (Object.keys(updates).length === 0) {
            throw new Error('No fields to update; provide at least one updatable field');
          }

          const updated = await api.updateTimeEntry(workspaceId, entryId, updates);

          await ensureCache();
          const hydrated = await cache.hydrateTimeEntries([updated]);

          return jsonResponse({
            success: true,
            message: 'Time entry updated',
            entry: hydrated[0],
          });
        }

        case 'toggl_delete_time_entry': {
          const workspaceId = await resolveWorkspaceForTool(args, 'deleting a time entry');
          const entryId = requiredFiniteNumberArg(args, 'entry_id', 'entry_id is required');

          await api.deleteTimeEntry(workspaceId, entryId);

          return jsonResponse({
            success: true,
            message: 'Time entry deleted',
            workspace_id: workspaceId,
            entry_id: entryId,
          });
        }

        // Reporting tools
        case 'toggl_daily_report': {
          await ensureCache();

          const date = args?.date ? parseLocalYMD(args.date as string) : new Date();
          date.setHours(0, 0, 0, 0);
          const nextDay = new Date(date);
          nextDay.setDate(nextDay.getDate() + 1);

          const entries = await api.getTimeEntriesForDateRange(date, nextDay);
          const hydrated = await cache.hydrateTimeEntries(entries);

          const report = generateDailyReport(toLocalYMD(date), hydrated);

          if (args?.format === 'text') {
            return {
              content: [
                {
                  type: 'text',
                  text: formatReportForDisplay(report),
                },
              ],
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(report, null, 2),
              },
            ],
          };
        }

        case 'toggl_weekly_report': {
          await ensureCache();

          const weekOffset = (args?.week_offset as number) || 0;
          const entries = await api.getTimeEntriesForWeek(weekOffset);
          const hydrated = await cache.hydrateTimeEntries(entries);

          // Calculate week boundaries in local time.
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const dayOfWeek = today.getDay();
          const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
          const monday = new Date(today);
          monday.setDate(diff + weekOffset * 7);
          const sunday = new Date(monday);
          sunday.setDate(sunday.getDate() + 6);

          const report = generateWeeklyReport(monday, sunday, hydrated);

          if (args?.format === 'text') {
            return {
              content: [
                {
                  type: 'text',
                  text: formatReportForDisplay(report),
                },
              ],
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(report, null, 2),
              },
            ],
          };
        }

        case 'toggl_project_summary': {
          await ensureCache();

          let entries: TimeEntry[];

          if (args?.period) {
            const range = getDateRange(args.period as any);
            entries = await api.getTimeEntriesForDateRange(range.start, range.end);
          } else if (args?.start_date && args?.end_date) {
            const start = parseLocalYMD(args.start_date as string);
            const end = parseInclusiveEndDate(args.end_date as string);
            entries = await api.getTimeEntriesForDateRange(start, end);
          } else {
            // Default to current week
            entries = await api.getTimeEntriesForWeek(0);
          }

          if (args?.workspace_id) {
            entries = entries.filter((e) => e.workspace_id === args.workspace_id);
          }

          const hydrated = await cache.hydrateTimeEntries(entries);
          const byProject = groupEntriesByProject(hydrated);

          const summaries: any[] = [];
          byProject.forEach((projectEntries, projectName) => {
            summaries.push(generateProjectSummary(projectName, projectEntries));
          });

          // Sort by total hours descending
          summaries.sort((a, b) => b.total_seconds - a.total_seconds);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    project_count: summaries.length,
                    total_hours: secondsToHours(summaries.reduce((t, s) => t + s.total_seconds, 0)),
                    projects: summaries,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'toggl_workspace_summary': {
          await ensureCache();

          let entries: TimeEntry[];

          if (args?.period) {
            const range = getDateRange(args.period as any);
            entries = await api.getTimeEntriesForDateRange(range.start, range.end);
          } else if (args?.start_date && args?.end_date) {
            const start = parseLocalYMD(args.start_date as string);
            const end = parseInclusiveEndDate(args.end_date as string);
            entries = await api.getTimeEntriesForDateRange(start, end);
          } else {
            // Default to current week
            entries = await api.getTimeEntriesForWeek(0);
          }

          const hydrated = await cache.hydrateTimeEntries(entries);
          const byWorkspace = groupEntriesByWorkspace(hydrated);

          const summaries: any[] = [];
          byWorkspace.forEach((wsEntries, wsName) => {
            const wsId = wsEntries[0]?.workspace_id || 0;
            summaries.push(generateWorkspaceSummary(wsName, wsId, wsEntries));
          });

          // Sort by total hours descending
          summaries.sort((a, b) => b.total_seconds - a.total_seconds);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    workspace_count: summaries.length,
                    total_hours: secondsToHours(summaries.reduce((t, s) => t + s.total_seconds, 0)),
                    workspaces: summaries,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Management tools
        case 'toggl_list_workspaces': {
          const workspaces = await cache.getWorkspaces();

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    count: workspaces.length,
                    workspaces: workspaces.map((ws) => ({
                      id: ws.id,
                      name: ws.name,
                      premium: ws.premium,
                      default_currency: ws.default_currency,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'toggl_list_projects': {
          const workspaceId = await resolveWorkspaceForTool(args, 'listing projects');

          const projects = await cache.getProjects(workspaceId);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    workspace_id: workspaceId,
                    count: projects.length,
                    projects: projects.map((p) => ({
                      id: p.id,
                      name: p.name,
                      active: p.active,
                      billable: p.billable,
                      color: p.color,
                      client_id: p.client_id,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'toggl_create_project': {
          const workspaceId = await resolveWorkspaceForTool(args, 'creating a project');
          const project: CreateProjectRequest = {
            name: requiredNonEmptyStringArg(args, 'name', 'Project name is required').trim(),
          };

          const clientId = optionalFiniteNumberArg(args, 'client_id');
          if (clientId !== undefined) project.client_id = clientId;

          const isPrivate = optionalBooleanArg(args, 'is_private');
          if (isPrivate !== undefined) project.is_private = isPrivate;

          const active = optionalBooleanArg(args, 'active');
          if (active !== undefined) project.active = active;

          const color = optionalStringArg(args, 'color');
          if (color !== undefined) project.color = color;

          const billable = optionalBooleanArg(args, 'billable');
          if (billable !== undefined) project.billable = billable;

          const autoEstimates = optionalBooleanArg(args, 'auto_estimates');
          if (autoEstimates !== undefined) project.auto_estimates = autoEstimates;

          const estimatedHours = optionalFiniteNumberArg(args, 'estimated_hours');
          if (estimatedHours !== undefined) project.estimated_hours = estimatedHours;

          const created = await api.createProject(workspaceId, project);
          cache.invalidateWorkspaceProjects(workspaceId);

          return jsonResponse({
            success: true,
            message: 'Project created',
            project: created,
          });
        }

        case 'toggl_update_project': {
          const workspaceId = await resolveWorkspaceForTool(args, 'updating a project');
          const projectId = requiredFiniteNumberArg(args, 'project_id', 'project_id is required');
          const updates: UpdateProjectRequest = {};

          if (args?.name !== undefined) {
            updates.name = requiredNonEmptyStringArg(args, 'name', 'Project name is required').trim();
          }

          if (args && 'client_id' in args) {
            const clientId = args.client_id;
            if (
              clientId !== null &&
              (typeof clientId !== 'number' || !Number.isFinite(clientId))
            ) {
              invalidArgument('client_id must be a finite number or null');
            }
            updates.client_id = clientId;
          }

          const isPrivate = optionalBooleanArg(args, 'is_private');
          if (isPrivate !== undefined) updates.is_private = isPrivate;

          const active = optionalBooleanArg(args, 'active');
          if (active !== undefined) updates.active = active;

          const color = optionalStringArg(args, 'color');
          if (color !== undefined) updates.color = color;

          const billable = optionalBooleanArg(args, 'billable');
          if (billable !== undefined) updates.billable = billable;

          const autoEstimates = optionalBooleanArg(args, 'auto_estimates');
          if (autoEstimates !== undefined) updates.auto_estimates = autoEstimates;

          const estimatedHours = optionalFiniteNumberArg(args, 'estimated_hours');
          if (estimatedHours !== undefined) updates.estimated_hours = estimatedHours;

          if (Object.keys(updates).length === 0) {
            throw new Error('No fields to update; provide at least one updatable field');
          }

          const updated = await api.updateProject(workspaceId, projectId, updates);
          cache.invalidateWorkspaceProjects(workspaceId);

          return jsonResponse({
            success: true,
            message: 'Project updated',
            project: updated,
          });
        }

        case 'toggl_delete_project': {
          const workspaceId = await resolveWorkspaceForTool(args, 'deleting a project');
          const projectId = requiredFiniteNumberArg(args, 'project_id', 'project_id is required');
          const rawMode = optionalStringArg(args, 'time_entry_deletion_mode');
          if (rawMode !== undefined && rawMode !== 'delete' && rawMode !== 'unassign') {
            invalidArgument('time_entry_deletion_mode must be delete or unassign');
          }
          const mode = rawMode as ProjectDeleteMode | undefined;

          await api.deleteProject(workspaceId, projectId, mode);
          cache.invalidateWorkspaceProjects(workspaceId);

          return jsonResponse({
            success: true,
            message: 'Project deleted',
            workspace_id: workspaceId,
            project_id: projectId,
            time_entry_deletion_mode: mode,
          });
        }

        case 'toggl_list_clients': {
          const workspaceId = await resolveWorkspaceForTool(args, 'listing clients');

          const clients = await cache.getClients(workspaceId);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    workspace_id: workspaceId,
                    count: clients.length,
                    clients: clients.map((c) => ({
                      id: c.id,
                      name: c.name,
                      archived: c.archived,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'toggl_list_tasks': {
          const workspaceId = await resolveWorkspaceForTool(args, 'listing tasks');
          const projectId = requiredFiniteNumberArg(args, 'project_id', 'project_id is required');

          const tasks = await cache.getTasks(workspaceId, projectId);

          return jsonResponse({
            workspace_id: workspaceId,
            project_id: projectId,
            count: tasks.length,
            tasks: tasks.map((task) => ({
              id: task.id,
              name: task.name,
              active: task.active,
              tracked_seconds: task.tracked_seconds,
              estimated_seconds: task.estimated_seconds,
            })),
          });
        }

        // Cache management
        case 'toggl_warm_cache': {
          const workspaceId = await resolveWorkspaceForTool(args, 'warming the cache');
          await cache.warmCache(workspaceId);
          cacheWarmed = true;

          const stats = cache.getStats();

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    message: 'Cache warmed successfully',
                    stats,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'toggl_cache_stats': {
          const stats = cache.getStats();
          const hitRate =
            stats.hits + stats.misses > 0
              ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100)
              : 0;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ...stats,
                    hit_rate: `${hitRate}%`,
                    cache_warmed: cacheWarmed,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'toggl_clear_cache': {
          cache.clearCache();
          cacheWarmed = false;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Cache cleared successfully',
                }),
              },
            ],
          };
        }

        case 'toggl_get_timeline': {
          localDateRangeFromArgs(args);
          if (
            args?.title_mode !== undefined &&
            args.title_mode !== 'redacted' &&
            args.title_mode !== 'raw'
          ) {
            throw new Error('title_mode must be "redacted" or "raw"');
          }

          let allEvents: TimelineEvent[];
          try {
            allEvents = await api.getTimeline();
          } catch (error) {
            if (error instanceof TimelineNotEnabledError) {
              return jsonResponse({
                enabled: false,
                total_events: 0,
                returned_events: 0,
                truncated: false,
                total_seconds: 0,
                total_hours: 0,
                summary: {},
                events: [],
                message:
                  'Toggl Desktop timeline is not enabled yet. Open the Toggl Track Desktop app for Mac, enable timeline/activity tracking and sync, then retry this tool after the app has uploaded activity data.',
              });
            }
            throw error;
          }

          return jsonResponse(buildTimelineResponse(allEvents, args));
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error: unknown) {
      return jsonResponse(errorPayload(error));
    }
  });

  return server;
}

function corsHeaders(): Record<string, string> {
  const origin = (process.env.MCP_HTTP_CORS_ORIGIN || '').trim();
  if (!origin) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

function writeJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  res.writeHead(statusCode, {
    ...corsHeaders(),
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(body));
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function isAuthorizedHttpRequest(req: IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) return true;
  return getHeader(req, 'authorization') === `Bearer ${authToken}`;
}

async function closeServerAndTransport(
  server: Server,
  transport: StreamableHTTPServerTransport
): Promise<void> {
  await Promise.allSettled([transport.close(), server.close()]);
}

async function handleMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  authToken: string | undefined
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...corsHeaders(),
    });
    res.end();
    return;
  }

  if (!isAuthorizedHttpRequest(req, authToken)) {
    writeJson(res, 401, {
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Unauthorized.',
      },
      id: null,
    });
    return;
  }

  if (req.method !== 'POST') {
    writeJson(res, 405, {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.',
      },
      id: null,
    });
    return;
  }

  const server = createTogglServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  let resourcesClosed = false;
  const closeResources = async () => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    await closeServerAndTransport(server, transport);
  };

  try {
    res.once('close', () => {
      void closeResources();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('HTTP MCP request failed:', error);
    if (!res.headersSent) {
      writeJson(res, 500, {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error.',
        },
        id: null,
      });
    }
  } finally {
    if (res.writableEnded || res.destroyed) {
      await closeResources();
    }
  }
}

function parsePort(value: string | undefined): number {
  const rawValue = (value || '3000').trim();
  if (!/^\d+$/.test(rawValue)) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const port = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function getHttpAuthToken(host: string): string | undefined {
  const token = (process.env.MCP_HTTP_AUTH_TOKEN || '').trim();
  if (token) return token;

  if (process.env.MCP_HTTP_ALLOW_UNAUTHENTICATED === 'true' && isLoopbackHost(host)) {
    return undefined;
  }

  throw new Error(
    'MCP_HTTP_AUTH_TOKEN is required when TRANSPORT=http. Set MCP_HTTP_ALLOW_UNAUTHENTICATED=true only for loopback-only development.'
  );
}

async function startHttpServer(): Promise<void> {
  const port = parsePort(process.env.PORT);
  const host = process.env.HOST || '0.0.0.0';
  const authToken = getHttpAuthToken(host);

  const httpServer = createHttpServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health' && req.method === 'GET') {
      writeJson(res, 200, {
        ok: true,
        name: 'mcp-toggl',
        version: VERSION,
        transport: 'http',
      });
      return;
    }

    if (url.pathname === '/mcp') {
      void handleMcpHttpRequest(req, res, authToken);
      return;
    }

    writeJson(res, 404, { error: 'Not found' });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const shutdown = () => {
    httpServer.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  console.error(`Toggl MCP server running over Streamable HTTP at http://${host}:${port}/mcp`);
}

// Start the server
async function main() {
  const transport = (process.env.TRANSPORT || 'stdio').trim().toLowerCase();

  if (transport === 'http') {
    await startHttpServer();
    return;
  }

  if (transport !== 'stdio') {
    console.error('Invalid TRANSPORT value. Expected "stdio" or "http".');
    process.exit(1);
  }

  const server = createTogglServer();
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  console.error('Toggl MCP server running over stdio');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
}
