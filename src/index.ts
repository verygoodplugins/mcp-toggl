#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from 'dotenv';
import { TogglAPI } from './toggl-api.js';
import { CacheManager } from './cache-manager.js';
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
  parseDate,
  SECONDS_PER_DAY
} from './utils.js';
import type {
  CacheConfig,
  TimeEntry,
  EnrichedTimelineEvent,
  UpdateTimeEntryRequest,
  DateRange,
  ProjectSummary,
  WorkspaceSummary
} from './types.js';
import {
  isDatePeriod,
  isPositiveInteger,
  isValidISODate,
  isNumber,
  isString,
  isStringArray,
  isBoolean,
  getErrorMessage,
  getErrorStack
} from './types.js';

// Helper to create consistent MCP tool responses
function jsonResponse(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }]
  };
}

// Version for CLI output and server metadata
const VERSION = '1.0.0';

// Basic CLI flags: --help / -h and --version / -v
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  console.log(`mcp-toggl version ${VERSION}`);
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`mcp-toggl - Toggl MCP Server\n\n` +
`Usage:\n` +
`  npx @verygoodplugins/mcp-toggl@latest [--help] [--version]\n\n` +
`Environment:\n` +
`  TOGGL_API_KEY                Required Toggl API token\n` +
`  TOGGL_DEFAULT_WORKSPACE_ID   Optional default workspace id\n` +
`  TOGGL_CACHE_TTL              Cache TTL in ms (default: 3600000)\n` +
`  TOGGL_CACHE_SIZE             Max cached entities (default: 1000)\n\n` +
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
`  }\n`);
  process.exit(0);
}

// Load environment variables
config();

// Validate required environment variables
// Support a few aliases for convenience/backward-compat
const RAW_API_KEY =
  process.env.TOGGL_API_KEY ||
  process.env.TOGGL_API_TOKEN ||
  process.env.TOGGL_TOKEN;

const API_KEY = RAW_API_KEY?.trim();

if (!API_KEY) {
  console.error('Missing required environment variable: TOGGL_API_KEY');
  console.error('Also accepted: TOGGL_API_TOKEN or TOGGL_TOKEN');
  process.exit(1);
}

if (process.env.TOGGL_API_TOKEN || process.env.TOGGL_TOKEN) {
  console.warn('Using TOGGL_API_TOKEN/TOGGL_TOKEN. Prefer TOGGL_API_KEY going forward.');
}

// Initialize configuration
const cacheConfig: CacheConfig = {
  ttl: parseInt(process.env.TOGGL_CACHE_TTL || '3600000', 10),
  maxSize: parseInt(process.env.TOGGL_CACHE_SIZE || '1000', 10),
  batchSize: parseInt(process.env.TOGGL_BATCH_SIZE || '100', 10)
};

const defaultWorkspaceId = process.env.TOGGL_DEFAULT_WORKSPACE_ID
  ? parseInt(process.env.TOGGL_DEFAULT_WORKSPACE_ID, 10)
  : undefined;

// Initialize API and cache
const api = new TogglAPI(API_KEY);
const cache = new CacheManager(cacheConfig);
cache.setAPI(api);

// Track cache warming state with mutex to prevent race conditions
let cacheWarmed = false;
let cacheWarmingPromise: Promise<void> | null = null;

// Helper to ensure cache is warm (with race condition protection)
async function ensureCache(): Promise<void> {
  if (cacheWarmed) return;

  if (!cacheWarmingPromise) {
    cacheWarmingPromise = cache.warmCache(defaultWorkspaceId)
      .then(() => { cacheWarmed = true; })
      .catch((error: unknown) => {
        console.error('Failed to warm cache:', getErrorMessage(error));
      })
      .finally(() => { cacheWarmingPromise = null; });
  }

  await cacheWarmingPromise;
}

// Helper to require and validate workspace ID
function requireWorkspaceId(providedId: unknown): number {
  if (isPositiveInteger(providedId)) return providedId;
  if (defaultWorkspaceId) return defaultWorkspaceId;
  throw new Error('Workspace ID required (set TOGGL_DEFAULT_WORKSPACE_ID or provide workspace_id)');
}

// Helper to resolve workspace ID, optionally fetching from existing entry
async function resolveWorkspaceId(providedId: unknown, timeEntryId?: number): Promise<number> {
  if (isPositiveInteger(providedId)) return providedId;

  if (timeEntryId) {
    const entry = await api.getTimeEntry(timeEntryId);
    if (entry.workspace_id) return entry.workspace_id;
  }

  if (defaultWorkspaceId) return defaultWorkspaceId;

  throw new Error('Workspace ID required (set TOGGL_DEFAULT_WORKSPACE_ID or provide workspace_id)');
}

// Helper to resolve date range from args
function resolveDateRange(args: Record<string, unknown> | undefined): DateRange | null {
  if (args?.period) {
    if (!isDatePeriod(args.period)) {
      throw new Error(`Invalid period: ${args.period}. Must be one of: today, yesterday, week, lastWeek, month, lastMonth`);
    }
    return getDateRange(args.period);
  }

  if (args?.start_date || args?.end_date) {
    const startStr = args?.start_date;
    const endStr = args?.end_date;
    const start = isString(startStr) ? parseDate(startStr, 'start_date') : new Date();
    const parsedEnd = isString(endStr) ? parseDate(endStr, 'end_date') : new Date();
    // Advance end to next day boundary so the end_date is inclusive
    const end = new Date(parsedEnd.getTime() + SECONDS_PER_DAY * 1000);
    if (start > parsedEnd) {
      throw new Error('start_date must be before or equal to end_date');
    }
    return { start, end };
  }

  return null; // Use default behavior
}

// Helper to mask email for privacy
function maskEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  const maskedUser = user.length <= 2 ? '*'.repeat(user.length) : `${user[0]}***${user.slice(-1)}`;
  return `${maskedUser}@${domain}`;
}

// Create MCP server
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

// Define tool schemas
const tools: Tool[] = [
  // Health/authentication
  {
    name: 'toggl_check_auth',
    description: 'Verify Toggl API connectivity and authentication is valid',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
  },
  // Time tracking tools
  {
    name: 'toggl_get_time_entries',
    description: 'Get time entries with optional date range filters. Returns hydrated entries with project/workspace names.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined period to fetch entries for'
        },
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD format)'
        },
        end_date: {
          type: 'string',
          description: 'End date (YYYY-MM-DD format)'
        },
        workspace_id: {
          type: 'number',
          description: 'Filter by workspace ID'
        },
        project_id: {
          type: 'number',
          description: 'Filter by project ID'
        }
      }
    },
  },
  {
    name: 'toggl_get_current_entry',
    description: 'Get the currently running time entry, if any',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
  },
  {
    name: 'toggl_start_timer',
    description: 'Start a new time entry timer',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Description of the time entry'
        },
        workspace_id: {
          type: 'number',
          description: 'Workspace ID (uses default if not provided)'
        },
        project_id: {
          type: 'number',
          description: 'Project ID (optional)'
        },
        task_id: {
          type: 'number',
          description: 'Task ID (optional)'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for the entry'
        }
      }
    },
  },
  {
    name: 'toggl_stop_timer',
    description: 'Stop the currently running timer',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
  },
  {
    name: 'toggl_create_time_entry',
    description: 'Create a new time entry with explicit start and stop times (not a running timer)',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Description of the time entry'
        },
        start: {
          type: 'string',
          description: 'Start time (ISO 8601 format, e.g., 2026-01-10T09:00:00Z)'
        },
        stop: {
          type: 'string',
          description: 'Stop time (ISO 8601 format, e.g., 2026-01-10T17:00:00Z)'
        },
        workspace_id: {
          type: 'number',
          description: 'Workspace ID (uses default if not provided)'
        },
        project_id: {
          type: 'number',
          description: 'Project ID (optional)'
        },
        task_id: {
          type: 'number',
          description: 'Task ID (optional)'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for the entry'
        },
        billable: {
          type: 'boolean',
          description: 'Whether the entry is billable'
        }
      },
      required: ['start', 'stop']
    },
  },
  {
    name: 'toggl_update_time_entry',
    description: 'Update an existing time entry (description, project, tags, times, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        time_entry_id: {
          type: 'number',
          description: 'ID of the time entry to update'
        },
        workspace_id: {
          type: 'number',
          description: 'Workspace ID (uses default if not provided)'
        },
        description: {
          type: 'string',
          description: 'New description'
        },
        project_id: {
          type: 'number',
          description: 'New project ID (use null to remove project)'
        },
        task_id: {
          type: 'number',
          description: 'New task ID'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'New tags (replaces existing tags)'
        },
        start: {
          type: 'string',
          description: 'New start time (ISO 8601 format)'
        },
        stop: {
          type: 'string',
          description: 'New stop time (ISO 8601 format)'
        },
        billable: {
          type: 'boolean',
          description: 'Whether the entry is billable'
        }
      },
      required: ['time_entry_id']
    },
  },
  {
    name: 'toggl_delete_time_entry',
    description: 'Delete a time entry',
    inputSchema: {
      type: 'object',
      properties: {
        time_entry_id: {
          type: 'number',
          description: 'ID of the time entry to delete'
        },
        workspace_id: {
          type: 'number',
          description: 'Workspace ID (uses default if not provided)'
        }
      },
      required: ['time_entry_id']
    },
  },

  // Reporting tools
  {
    name: 'toggl_daily_report',
    description: 'Generate a daily report with hours by project and workspace',
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Date for report (YYYY-MM-DD format, defaults to today)'
        },
        format: {
          type: 'string',
          enum: ['json', 'text'],
          description: 'Output format (default: json)'
        }
      }
    },
  },
  {
    name: 'toggl_weekly_report',
    description: 'Generate a weekly report with daily breakdown and project summaries',
    inputSchema: {
      type: 'object',
      properties: {
        week_offset: {
          type: 'number',
          description: 'Week offset from current week (0 = this week, -1 = last week)'
        },
        format: {
          type: 'string',
          enum: ['json', 'text'],
          description: 'Output format (default: json)'
        }
      }
    },
  },
  {
    name: 'toggl_project_summary',
    description: 'Get total hours per project for a date range',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined period'
        },
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD format)'
        },
        end_date: {
          type: 'string',
          description: 'End date (YYYY-MM-DD format)'
        },
        workspace_id: {
          type: 'number',
          description: 'Filter by workspace ID'
        }
      }
    },
  },
  {
    name: 'toggl_workspace_summary',
    description: 'Get total hours per workspace for a date range',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined period'
        },
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD format)'
        },
        end_date: {
          type: 'string',
          description: 'End date (YYYY-MM-DD format)'
        }
      }
    },
  },
  
  // Management tools
  {
    name: 'toggl_list_workspaces',
    description: 'List all available workspaces',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
  },
  {
    name: 'toggl_list_projects',
    description: 'List projects for a workspace',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'number',
          description: 'Workspace ID (uses default if not provided)'
        }
      }
    },
  },
  {
    name: 'toggl_list_clients',
    description: 'List clients for a workspace',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'number',
          description: 'Workspace ID (uses default if not provided)'
        }
      }
    },
  },
  
  // Cache management
  {
    name: 'toggl_warm_cache',
    description: 'Pre-fetch and cache workspace, project, and client data for better performance',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'number',
          description: 'Specific workspace to warm cache for'
        }
      }
    },
  },
  {
    name: 'toggl_cache_stats',
    description: 'Get cache statistics and performance metrics',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
  },
  {
    name: 'toggl_clear_cache',
    description: 'Clear all cached data',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
  },

  // Timeline (desktop activity tracking)
  {
    name: 'toggl_get_timeline',
    description: 'Get desktop activity timeline showing application usage. PRIVACY NOTE: Returns window titles which may contain sensitive information (document names, email subjects, URLs). Summary includes all matching events; limit controls the events array size. Requires Toggl desktop app with timeline sync enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined period (alternative to start_date/end_date)'
        },
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD format, local timezone)'
        },
        end_date: {
          type: 'string',
          description: 'End date (YYYY-MM-DD format, local timezone)'
        },
        app: {
          type: 'string',
          description: 'Filter by application name (case-insensitive partial match)'
        },
        include_events: {
          type: 'boolean',
          description: 'Include raw events array (default: true). Set to false for summary only.'
        },
        limit: {
          type: 'number',
          description: 'Maximum events to return in events array (default: 50, max: 1000). Does not affect summary calculation.'
        }
      }
    },
  }
];

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
        const workspaces = await api.getWorkspaces();
        return jsonResponse({
          authenticated: true,
          user: {
            id: me.id,
            email: maskEmail(me.email),
            fullname: me.fullname
          },
          workspaces: workspaces.map(w => ({ id: w.id, name: w.name })),
        });
      }

      // Time tracking tools
      case 'toggl_get_time_entries': {
        await ensureCache();

        let entries: TimeEntry[];
        const dateRange = resolveDateRange(args);

        if (dateRange) {
          entries = await api.getTimeEntriesForDateRange(dateRange.start, dateRange.end);
        } else {
          entries = await api.getTimeEntriesForToday();
        }

        // Filter by workspace/project if specified
        if (isNumber(args?.workspace_id)) {
          entries = entries.filter(e => e.workspace_id === args.workspace_id);
        }
        if (isNumber(args?.project_id)) {
          entries = entries.filter(e => e.project_id === args.project_id);
        }

        // Hydrate with names
        const hydrated = await cache.hydrateTimeEntries(entries);

        return jsonResponse({
          count: hydrated.length,
          entries: hydrated
        });
      }
      
      case 'toggl_get_current_entry': {
        const entry = await api.getCurrentTimeEntry();

        if (!entry) {
          return jsonResponse({
            running: false,
            message: 'No timer currently running'
          });
        }

        await ensureCache();
        const hydrated = await cache.hydrateTimeEntries([entry]);

        return jsonResponse({
          running: true,
          entry: hydrated[0]
        });
      }

      case 'toggl_start_timer': {
        const workspaceId = requireWorkspaceId(args?.workspace_id);

        const entry = await api.startTimer(
          workspaceId,
          isString(args?.description) ? args.description : undefined,
          isPositiveInteger(args?.project_id) ? args.project_id : undefined,
          isPositiveInteger(args?.task_id) ? args.task_id : undefined,
          isStringArray(args?.tags) ? args.tags : undefined
        );

        await ensureCache();
        const hydrated = await cache.hydrateTimeEntries([entry]);

        return jsonResponse({
          success: true,
          message: 'Timer started',
          entry: hydrated[0]
        });
      }

      case 'toggl_stop_timer': {
        const current = await api.getCurrentTimeEntry();

        if (!current) {
          return jsonResponse({
            success: false,
            message: 'No timer currently running'
          });
        }

        const stopped = await api.stopTimer(current.workspace_id, current.id);

        await ensureCache();
        const hydrated = await cache.hydrateTimeEntries([stopped]);

        return jsonResponse({
          success: true,
          message: 'Timer stopped',
          entry: hydrated[0]
        });
      }

      case 'toggl_create_time_entry': {
        const workspaceId = requireWorkspaceId(args?.workspace_id);

        // Validate required date fields
        if (!isValidISODate(args?.start)) {
          throw new Error('start is required and must be a valid ISO 8601 date (e.g., 2026-01-10T09:00:00Z)');
        }
        if (!isValidISODate(args?.stop)) {
          throw new Error('stop is required and must be a valid ISO 8601 date (e.g., 2026-01-10T17:00:00Z)');
        }

        const startTime = new Date(args.start);
        const stopTime = new Date(args.stop);
        const durationSeconds = Math.floor((stopTime.getTime() - startTime.getTime()) / 1000);

        if (durationSeconds <= 0) {
          throw new Error('Stop time must be after start time');
        }

        const entry = await api.createTimeEntry(workspaceId, {
          description: isString(args?.description) ? args.description : undefined,
          project_id: isPositiveInteger(args?.project_id) ? args.project_id : undefined,
          task_id: isPositiveInteger(args?.task_id) ? args.task_id : undefined,
          tags: isStringArray(args?.tags) ? args.tags : undefined,
          billable: isBoolean(args?.billable) ? args.billable : undefined,
          start: startTime.toISOString(),
          stop: stopTime.toISOString(),
          duration: durationSeconds
        });

        await ensureCache();
        const hydrated = await cache.hydrateTimeEntries([entry]);

        return jsonResponse({
          success: true,
          message: 'Time entry created',
          entry: hydrated[0]
        });
      }

      case 'toggl_update_time_entry': {
        // Validate time_entry_id
        if (!isPositiveInteger(args?.time_entry_id)) {
          throw new Error('time_entry_id must be a positive integer');
        }
        const timeEntryId = args.time_entry_id;

        // Resolve workspace ID (may fetch entry to get workspace)
        const workspaceId = await resolveWorkspaceId(args?.workspace_id, timeEntryId);

        // Build update payload with only provided and valid fields
        const updates: Partial<UpdateTimeEntryRequest> = {};
        if (isString(args?.description)) updates.description = args.description;
        if (args?.project_id !== undefined) {
          // Allow null to explicitly clear project, or positive integer to set
          if (args.project_id === null) {
            updates.project_id = null;
          } else if (isPositiveInteger(args.project_id)) {
            updates.project_id = args.project_id;
          } else {
            throw new Error('project_id must be null (to clear) or a positive integer');
          }
        }
        if (isPositiveInteger(args?.task_id)) updates.task_id = args.task_id;
        if (isStringArray(args?.tags)) updates.tags = args.tags;
        if (isBoolean(args?.billable)) updates.billable = args.billable;
        if (isValidISODate(args?.start)) updates.start = args.start;
        if (isValidISODate(args?.stop)) updates.stop = args.stop;

        const updated = await api.updateTimeEntry(workspaceId, timeEntryId, updates);

        await ensureCache();
        const hydrated = await cache.hydrateTimeEntries([updated]);

        return jsonResponse({
          success: true,
          message: 'Time entry updated',
          entry: hydrated[0]
        });
      }

      case 'toggl_delete_time_entry': {
        // Validate time_entry_id
        if (!isPositiveInteger(args?.time_entry_id)) {
          throw new Error('time_entry_id must be a positive integer');
        }
        const timeEntryId = args.time_entry_id;

        // Resolve workspace ID (may fetch entry to get workspace)
        const workspaceId = await resolveWorkspaceId(args?.workspace_id, timeEntryId);

        await api.deleteTimeEntry(workspaceId, timeEntryId);

        return jsonResponse({
          success: true,
          message: `Time entry ${timeEntryId} deleted`
        });
      }

      // Reporting tools
      case 'toggl_daily_report': {
        await ensureCache();

        const date = isString(args?.date) ? parseDate(args.date, 'date') : new Date();
        const nextDay = new Date(date);
        nextDay.setDate(nextDay.getDate() + 1);

        const entries = await api.getTimeEntriesForDateRange(date, nextDay);
        const hydrated = await cache.hydrateTimeEntries(entries);

        const report = generateDailyReport(date.toISOString().split('T')[0], hydrated);

        if (args?.format === 'text') {
          return jsonResponse(formatReportForDisplay(report));
        }

        return jsonResponse(report);
      }

      case 'toggl_weekly_report': {
        await ensureCache();

        const weekOffset = isNumber(args?.week_offset) ? args.week_offset : 0;
        const entries = await api.getTimeEntriesForWeek(weekOffset);
        const hydrated = await cache.hydrateTimeEntries(entries);

        // Calculate week boundaries
        const today = new Date();
        const dayOfWeek = today.getDay();
        const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
        const monday = new Date(today.setDate(diff));
        monday.setDate(monday.getDate() + (weekOffset * 7));
        const sunday = new Date(monday);
        sunday.setDate(sunday.getDate() + 6);

        const report = generateWeeklyReport(monday, sunday, hydrated);

        if (args?.format === 'text') {
          return jsonResponse(formatReportForDisplay(report));
        }

        return jsonResponse(report);
      }

      case 'toggl_project_summary': {
        await ensureCache();

        let entries: TimeEntry[];
        const dateRange = resolveDateRange(args);

        if (dateRange) {
          entries = await api.getTimeEntriesForDateRange(dateRange.start, dateRange.end);
        } else {
          // Default to current week
          entries = await api.getTimeEntriesForWeek(0);
        }

        if (isNumber(args?.workspace_id)) {
          entries = entries.filter(e => e.workspace_id === args.workspace_id);
        }

        const hydrated = await cache.hydrateTimeEntries(entries);
        const byProject = groupEntriesByProject(hydrated);

        const summaries: ProjectSummary[] = [];
        byProject.forEach((projectEntries, projectName) => {
          summaries.push(generateProjectSummary(projectName, projectEntries));
        });

        // Sort by total hours descending
        summaries.sort((a, b) => b.total_seconds - a.total_seconds);

        return jsonResponse({
          project_count: summaries.length,
          total_hours: secondsToHours(summaries.reduce((t, s) => t + s.total_seconds, 0)),
          projects: summaries
        });
      }

      case 'toggl_workspace_summary': {
        await ensureCache();

        let entries: TimeEntry[];
        const dateRange = resolveDateRange(args);

        if (dateRange) {
          entries = await api.getTimeEntriesForDateRange(dateRange.start, dateRange.end);
        } else {
          // Default to current week
          entries = await api.getTimeEntriesForWeek(0);
        }

        const hydrated = await cache.hydrateTimeEntries(entries);
        const byWorkspace = groupEntriesByWorkspace(hydrated);

        const summaries: WorkspaceSummary[] = [];
        byWorkspace.forEach((wsEntries, wsName) => {
          const wsId = wsEntries[0]?.workspace_id || 0;
          summaries.push(generateWorkspaceSummary(wsName, wsId, wsEntries));
        });

        // Sort by total hours descending
        summaries.sort((a, b) => b.total_seconds - a.total_seconds);

        return jsonResponse({
          workspace_count: summaries.length,
          total_hours: secondsToHours(summaries.reduce((t, s) => t + s.total_seconds, 0)),
          workspaces: summaries
        });
      }

      // Management tools
      case 'toggl_list_workspaces': {
        const workspaces = await api.getWorkspaces();

        return jsonResponse({
          count: workspaces.length,
          workspaces: workspaces.map(ws => ({
            id: ws.id,
            name: ws.name,
            premium: ws.premium,
            default_currency: ws.default_currency
          }))
        });
      }

      case 'toggl_list_projects': {
        const workspaceId = requireWorkspaceId(args?.workspace_id);

        const projects = await api.getProjects(workspaceId);

        return jsonResponse({
          workspace_id: workspaceId,
          count: projects.length,
          projects: projects.map(p => ({
            id: p.id,
            name: p.name,
            active: p.active,
            billable: p.billable,
            color: p.color,
            client_id: p.client_id
          }))
        });
      }

      case 'toggl_list_clients': {
        const workspaceId = requireWorkspaceId(args?.workspace_id);

        const clients = await api.getClients(workspaceId);

        return jsonResponse({
          workspace_id: workspaceId,
          count: clients.length,
          clients: clients.map(c => ({
            id: c.id,
            name: c.name,
            archived: c.archived
          }))
        });
      }
      
      // Cache management
      case 'toggl_warm_cache': {
        const workspaceId = isPositiveInteger(args?.workspace_id) ? args.workspace_id : defaultWorkspaceId;
        await cache.warmCache(workspaceId);
        cacheWarmed = true;

        const stats = cache.getStats();

        return jsonResponse({
          success: true,
          message: 'Cache warmed successfully',
          stats
        });
      }

      case 'toggl_cache_stats': {
        const stats = cache.getStats();
        const hitRate = stats.hits + stats.misses > 0
          ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100)
          : 0;

        return jsonResponse({
          ...stats,
          hit_rate: `${hitRate}%`,
          cache_warmed: cacheWarmed
        });
      }

      case 'toggl_clear_cache': {
        cache.clearCache();
        cacheWarmed = false;

        return jsonResponse({
          success: true,
          message: 'Cache cleared successfully'
        });
      }

      // Timeline (desktop activity tracking)
      case 'toggl_get_timeline': {
        const allEvents = await api.getTimeline();

        // Determine date range
        let startTs: number | null = null;
        let endTs: number | null = null;

        if (args?.period) {
          if (!isDatePeriod(args.period)) {
            throw new Error(`Invalid period: ${args.period}. Must be one of: today, yesterday, week, lastWeek, month, lastMonth`);
          }
          const range = getDateRange(args.period);
          startTs = range.start.getTime() / 1000;
          endTs = range.end.getTime() / 1000;
        } else {
          if (args?.start_date) {
            startTs = parseDate(args.start_date, 'start_date').getTime() / 1000;
          }
          if (args?.end_date) {
            // Add SECONDS_PER_DAY to include the full end day
            endTs = parseDate(args.end_date, 'end_date').getTime() / 1000 + SECONDS_PER_DAY;
          }
        }

        // Prepare filters
        const appFilter = args?.app ? String(args.app).toLowerCase() : null;
        const includeEvents = args?.include_events !== false;
        const rawLimit = args?.limit;
        const limit = Math.max(1, Math.min(typeof rawLimit === 'number' ? rawLimit : 50, 1000));
        const now = Math.floor(Date.now() / 1000);

        // Single-pass processing for performance
        const appSummary = new Map<string, number>();
        const events: EnrichedTimelineEvent[] = [];
        let totalCount = 0;
        let totalSeconds = 0;

        for (const e of allEvents) {
          // Calculate effective end time (handle null end_time for active events)
          const eventEnd = e.end_time ?? now;

          // Date filtering: include events that OVERLAP with the range
          // An event overlaps if: eventEnd >= startTs && start_time <= endTs
          if (startTs !== null && eventEnd < startTs) continue;
          if (endTs !== null && e.start_time >= endTs) continue;

          // App filtering (null-safe)
          const filename = e.filename ?? 'Unknown';
          if (appFilter && !filename.toLowerCase().includes(appFilter)) continue;

          // Clip duration to the requested range bounds
          const clippedStart = startTs !== null ? Math.max(e.start_time, startTs) : e.start_time;
          const clippedEnd = endTs !== null ? Math.min(eventEnd, endTs) : eventEnd;
          const duration = Math.max(0, clippedEnd - clippedStart);

          // Update summary (from ALL matching events)
          totalCount++;
          totalSeconds += duration;
          appSummary.set(filename, (appSummary.get(filename) ?? 0) + duration);

          // Collect events up to limit
          if (includeEvents && events.length < limit) {
            events.push({
              ...e,
              filename,
              start: new Date(clippedStart * 1000).toISOString(),
              end: new Date(clippedEnd * 1000).toISOString(),
              duration_seconds: duration
            });
          }
        }

        // Sort summary by duration descending
        const sortedSummary = Object.fromEntries(
          [...appSummary.entries()].sort((a, b) => b[1] - a[1])
        );

        return jsonResponse({
          total_events: totalCount,
          returned_events: events.length,
          truncated: includeEvents && totalCount > events.length,
          total_seconds: totalSeconds,
          summary: sortedSummary,
          ...(includeEvents && { events })
        });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: unknown) {
    return jsonResponse({
      error: true,
      message: getErrorMessage(error),
      ...(process.env.TOGGL_DEBUG === 'true' && { details: getErrorStack(error) })
    });
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Toggl MCP server running');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
