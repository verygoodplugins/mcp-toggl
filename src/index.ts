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
  effectiveDurationSeconds
} from './utils.js';
import type {
  CacheConfig,
  TimeEntry,
  TimeEntrySearchFilters
} from './types.js';

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
  ttl: parseInt(process.env.TOGGL_CACHE_TTL || '3600000'),
  maxSize: parseInt(process.env.TOGGL_CACHE_SIZE || '1000'),
  batchSize: parseInt(process.env.TOGGL_BATCH_SIZE || '100')
};

const defaultWorkspaceId = process.env.TOGGL_DEFAULT_WORKSPACE_ID 
  ? parseInt(process.env.TOGGL_DEFAULT_WORKSPACE_ID)
  : undefined;

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
      await cache.warmCache(defaultWorkspaceId);
      cacheWarmed = true;
    } catch (error) {
      console.error('Failed to warm cache:', error);
    }
  }
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
    description: 'Get time entries via /me/time_entries with optional client-side filters. Fast for small date ranges. For dashboard-parity filtering (clients, tasks, tags, users, billable, duration bounds, etc.) prefer toggl_search_time_entries.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined period to fetch entries for'
        },
        start_date: { type: 'string', description: 'Start date (YYYY-MM-DD format)' },
        end_date: { type: 'string', description: 'End date (YYYY-MM-DD format)' },
        workspace_id: { type: 'number', description: 'Filter by workspace ID' },
        project_id: { type: 'number', description: 'Filter by project ID' },
        // Post-filter additions (applied client-side after fetch, before hydration).
        description: { type: 'string', description: 'Case-insensitive substring match on entry description' },
        billable: { type: 'boolean', description: 'Filter by billable status' },
        user_ids: { type: 'array', items: { type: 'number' }, description: 'Filter by user IDs (client-side post-filter)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tag names (matches entries containing ANY of the given tags)' },
        tags_all: { type: 'boolean', description: 'If true, require ALL given tags instead of ANY (default: false)' },
        min_duration_seconds: { type: 'number', description: 'Minimum duration in seconds' },
        max_duration_seconds: { type: 'number', description: 'Maximum duration in seconds' }
      }
    },
  },
  {
    name: 'toggl_search_time_entries',
    description: 'Search time entries via Toggl Reports API v3 with full dashboard-parity filters. Per-workspace. Auto-paginates. Returns flat hydrated entries.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'number', description: 'Workspace ID (uses default if not provided)' },
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth'],
          description: 'Predefined period (sets start_date/end_date if those are not provided)'
        },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD (required unless period is given)' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD' },
        user_ids: { type: 'array', items: { type: 'number' }, description: 'User IDs. Unlike client/project/task/tag filters, Reports API does not accept [null] here — every entry has an owner.' },
        project_ids: { type: 'array', items: { type: ['number', 'null'] }, description: 'Project IDs. Use [null] to match entries with no project.' },
        client_ids: { type: 'array', items: { type: ['number', 'null'] }, description: 'Client IDs. Use [null] to match entries with no client.' },
        task_ids: { type: 'array', items: { type: ['number', 'null'] }, description: 'Task IDs. Use [null] to match entries with no task.' },
        tag_ids: { type: 'array', items: { type: ['number', 'null'] }, description: 'Tag IDs. Use [null] to match entries with no tags.' },
        group_ids: { type: 'array', items: { type: 'number' }, description: 'Team group IDs' },
        time_entry_ids: { type: 'array', items: { type: 'number' }, description: 'Specific time entry IDs' },
        description: { type: 'string', description: 'Text search on entry description' },
        billable: { type: 'boolean', description: 'Billable filter (premium feature — may return 402 on Free plan)' },
        min_duration_seconds: { type: 'number' },
        max_duration_seconds: { type: 'number' },
        order_by: { type: 'string', enum: ['date', 'user', 'duration', 'description', 'last_update'] },
        order_dir: { type: 'string', enum: ['ASC', 'DESC'] },
        grouped: { type: 'boolean' },
        rounding: { type: 'number', description: 'Rounding mode' },
        rounding_minutes: { type: 'number', enum: [0, 1, 5, 6, 10, 12, 15, 30, 60, 240] },
        page_size: { type: 'number', description: 'Items per page (default: 50)' },
        max_pages: { type: 'number', description: 'Max pages to auto-paginate (default: 20)' }
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
        const maskEmail = (e?: string) => {
          if (!e) return undefined as unknown as string;
          const [user, domain] = e.split('@');
          if (!domain) return '***';
          const u = user.length <= 2 ? '*'.repeat(user.length) : `${user[0]}***${user.slice(-1)}`;
          return `${u}@${domain}`;
        };
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              authenticated: true,
              user: {
                id: (me as any).id,
                email: maskEmail((me as any).email),
                fullname: (me as any).fullname
              },
              workspaces: workspaces.map(w => ({ id: w.id, name: w.name })),
            }, null, 2)
          }]
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
          const start = args?.start_date ? new Date(args.start_date as string) : new Date();
          const end = args?.end_date ? new Date(args.end_date as string) : new Date();
          entries = await api.getTimeEntriesForDateRange(start, end);
        } else {
          entries = await api.getTimeEntriesForToday();
        }

        // Build a single predicate list so we walk the array once. `duration`
        // is compared via `effectiveDurationSeconds` because running timers
        // encode a negative start-time sentinel, not elapsed seconds.
        const predicates: Array<(e: TimeEntry) => boolean> = [];
        if (args?.workspace_id) {
          predicates.push(e => e.workspace_id === args.workspace_id);
        }
        if (args?.project_id) {
          predicates.push(e => e.project_id === args.project_id);
        }
        if (typeof args?.billable === 'boolean') {
          predicates.push(e => e.billable === args.billable);
        }
        if (Array.isArray(args?.user_ids) && (args.user_ids as number[]).length > 0) {
          const ids = new Set(args.user_ids as number[]);
          predicates.push(e => e.user_id !== undefined && ids.has(e.user_id));
        }
        if (typeof args?.min_duration_seconds === 'number') {
          const min = args.min_duration_seconds;
          predicates.push(e => effectiveDurationSeconds(e) >= min);
        }
        if (typeof args?.max_duration_seconds === 'number') {
          const max = args.max_duration_seconds;
          predicates.push(e => effectiveDurationSeconds(e) <= max);
        }
        if (typeof args?.description === 'string' && args.description.length > 0) {
          const needle = (args.description as string).toLowerCase();
          predicates.push(e => (e.description || '').toLowerCase().includes(needle));
        }
        if (Array.isArray(args?.tags) && (args.tags as string[]).length > 0) {
          const wanted = args.tags as string[];
          const all = Boolean(args.tags_all);
          predicates.push(e => {
            const have = e.tags || [];
            return all ? wanted.every(t => have.includes(t)) : wanted.some(t => have.includes(t));
          });
        }
        if (predicates.length > 0) {
          entries = entries.filter(e => predicates.every(p => p(e)));
        }

        // Hydrate with names
        const hydrated = await cache.hydrateTimeEntries(entries);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              count: hydrated.length,
              entries: hydrated
            }, null, 2)
          }]
        };
      }

      case 'toggl_search_time_entries': {
        const workspaceId = (args?.workspace_id as number | undefined) || defaultWorkspaceId;
        if (!workspaceId) {
          throw new Error('Workspace ID required (set TOGGL_DEFAULT_WORKSPACE_ID or provide workspace_id)');
        }
        await ensureCache();

        // Explicit start/end wins; otherwise derive from `period`. Reports
        // API requires a date range, so we reject if neither is provided.
        let startDate: string | undefined = args?.start_date as string | undefined;
        let endDate: string | undefined = args?.end_date as string | undefined;
        if (!startDate && !endDate && args?.period) {
          const range = getDateRange(args.period as any);
          startDate = range.start.toISOString().split('T')[0];
          endDate = range.end.toISOString().split('T')[0];
        }
        if (!startDate || !endDate) {
          throw new Error('Reports API requires both start_date and end_date (or a period).');
        }

        const filters: TimeEntrySearchFilters = {
          start_date: startDate,
          end_date: endDate,
          user_ids: args?.user_ids as number[] | undefined,
          project_ids: args?.project_ids as (number | null)[] | undefined,
          client_ids: args?.client_ids as (number | null)[] | undefined,
          task_ids: args?.task_ids as (number | null)[] | undefined,
          tag_ids: args?.tag_ids as (number | null)[] | undefined,
          group_ids: args?.group_ids as number[] | undefined,
          time_entry_ids: args?.time_entry_ids as number[] | undefined,
          description: args?.description as string | undefined,
          billable: args?.billable as boolean | undefined,
          min_duration_seconds: args?.min_duration_seconds as number | undefined,
          max_duration_seconds: args?.max_duration_seconds as number | undefined,
          order_by: args?.order_by as TimeEntrySearchFilters['order_by'],
          order_dir: args?.order_dir as TimeEntrySearchFilters['order_dir'],
          grouped: args?.grouped as boolean | undefined,
          rounding: args?.rounding as number | undefined,
          rounding_minutes: args?.rounding_minutes as number | undefined,
          page_size: args?.page_size as number | undefined,
        };
        // Strip undefined keys so Reports API doesn't see nulls where we mean "unset".
        for (const k of Object.keys(filters) as (keyof TimeEntrySearchFilters)[]) {
          if (filters[k] === undefined) delete filters[k];
        }

        const entries = await api.searchTimeEntries(workspaceId as number, filters, {
          maxPages: (args?.max_pages as number | undefined) ?? 20,
        });
        const hydrated = await cache.hydrateTimeEntries(entries);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              workspace_id: workspaceId,
              count: hydrated.length,
              filters,
              entries: hydrated,
            }, null, 2)
          }]
        };
      }
      
      case 'toggl_get_current_entry': {
        const entry = await api.getCurrentTimeEntry();
        
        if (!entry) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ 
                running: false,
                message: 'No timer currently running' 
              })
            }]
          };
        }
        
        await ensureCache();
        const hydrated = await cache.hydrateTimeEntries([entry]);
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ 
              running: true,
              entry: hydrated[0] 
            }, null, 2)
          }]
        };
      }
      
      case 'toggl_start_timer': {
        const workspaceId = args?.workspace_id || defaultWorkspaceId;
        if (!workspaceId) {
          throw new Error('Workspace ID required (set TOGGL_DEFAULT_WORKSPACE_ID or provide workspace_id)');
        }
        
        const entry = await api.startTimer(
          workspaceId as number,
          args?.description as string | undefined,
          args?.project_id as number | undefined,
          args?.task_id as number | undefined,
          args?.tags as string[] | undefined
        );
        
        await ensureCache();
        const hydrated = await cache.hydrateTimeEntries([entry]);
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ 
              success: true,
              message: 'Timer started',
              entry: hydrated[0] 
            }, null, 2)
          }]
        };
      }
      
      case 'toggl_stop_timer': {
        const current = await api.getCurrentTimeEntry();
        
        if (!current) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ 
                success: false,
                message: 'No timer currently running' 
              })
            }]
          };
        }
        
        const stopped = await api.stopTimer(current.workspace_id, current.id);
        
        await ensureCache();
        const hydrated = await cache.hydrateTimeEntries([stopped]);
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ 
              success: true,
              message: 'Timer stopped',
              entry: hydrated[0] 
            }, null, 2)
          }]
        };
      }
      
      // Reporting tools
      case 'toggl_daily_report': {
        await ensureCache();
        
        const date = args?.date ? new Date(args.date as string) : new Date();
        const nextDay = new Date(date);
        nextDay.setDate(nextDay.getDate() + 1);
        
        const entries = await api.getTimeEntriesForDateRange(date, nextDay);
        const hydrated = await cache.hydrateTimeEntries(entries);
        
        const report = generateDailyReport(date.toISOString().split('T')[0], hydrated);
        
        if (args?.format === 'text') {
          return {
            content: [{
              type: 'text',
              text: formatReportForDisplay(report)
            }]
          };
        }
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(report, null, 2)
          }]
        };
      }
      
      case 'toggl_weekly_report': {
        await ensureCache();
        
        const weekOffset = (args?.week_offset as number) || 0;
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
          return {
            content: [{
              type: 'text',
              text: formatReportForDisplay(report)
            }]
          };
        }
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(report, null, 2)
          }]
        };
      }
      
      case 'toggl_project_summary': {
        await ensureCache();
        
        let entries: TimeEntry[];
        
        if (args?.period) {
          const range = getDateRange(args.period as any);
          entries = await api.getTimeEntriesForDateRange(range.start, range.end);
        } else if (args?.start_date && args?.end_date) {
          const start = new Date(args.start_date as string);
          const end = new Date(args.end_date as string);
          entries = await api.getTimeEntriesForDateRange(start, end);
        } else {
          // Default to current week
          entries = await api.getTimeEntriesForWeek(0);
        }
        
        if (args?.workspace_id) {
          entries = entries.filter(e => e.workspace_id === args.workspace_id);
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
          content: [{
            type: 'text',
            text: JSON.stringify({ 
              project_count: summaries.length,
              total_hours: secondsToHours(summaries.reduce((t, s) => t + s.total_seconds, 0)),
              projects: summaries 
            }, null, 2)
          }]
        };
      }
      
      case 'toggl_workspace_summary': {
        await ensureCache();
        
        let entries: TimeEntry[];
        
        if (args?.period) {
          const range = getDateRange(args.period as any);
          entries = await api.getTimeEntriesForDateRange(range.start, range.end);
        } else if (args?.start_date && args?.end_date) {
          const start = new Date(args.start_date as string);
          const end = new Date(args.end_date as string);
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
          content: [{
            type: 'text',
            text: JSON.stringify({ 
              workspace_count: summaries.length,
              total_hours: secondsToHours(summaries.reduce((t, s) => t + s.total_seconds, 0)),
              workspaces: summaries 
            }, null, 2)
          }]
        };
      }
      
      // Management tools
      case 'toggl_list_workspaces': {
        const workspaces = await api.getWorkspaces();
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ 
              count: workspaces.length,
              workspaces: workspaces.map(ws => ({
                id: ws.id,
                name: ws.name,
                premium: ws.premium,
                default_currency: ws.default_currency
              }))
            }, null, 2)
          }]
        };
      }
      
      case 'toggl_list_projects': {
        const workspaceId = args?.workspace_id || defaultWorkspaceId;
        if (!workspaceId) {
          throw new Error('Workspace ID required (set TOGGL_DEFAULT_WORKSPACE_ID or provide workspace_id)');
        }
        
        const projects = await api.getProjects(workspaceId as number);
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ 
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
            }, null, 2)
          }]
        };
      }
      
      case 'toggl_list_clients': {
        const workspaceId = args?.workspace_id || defaultWorkspaceId;
        if (!workspaceId) {
          throw new Error('Workspace ID required (set TOGGL_DEFAULT_WORKSPACE_ID or provide workspace_id)');
        }
        
        const clients = await api.getClients(workspaceId as number);
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ 
              workspace_id: workspaceId,
              count: clients.length,
              clients: clients.map(c => ({
                id: c.id,
                name: c.name,
                archived: c.archived
              }))
            }, null, 2)
          }]
        };
      }
      
      // Cache management
      case 'toggl_warm_cache': {
        const workspaceId = (args?.workspace_id as number | undefined) || defaultWorkspaceId;
        await cache.warmCache(workspaceId);
        cacheWarmed = true;
        
        const stats = cache.getStats();
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ 
              success: true,
              message: 'Cache warmed successfully',
              stats 
            }, null, 2)
          }]
        };
      }
      
      case 'toggl_cache_stats': {
        const stats = cache.getStats();
        const hitRate = stats.hits + stats.misses > 0
          ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100)
          : 0;
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ 
              ...stats,
              hit_rate: `${hitRate}%`,
              cache_warmed: cacheWarmed
            }, null, 2)
          }]
        };
      }
      
      case 'toggl_clear_cache': {
        cache.clearCache();
        cacheWarmed = false;
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ 
              success: true,
              message: 'Cache cleared successfully' 
            })
          }]
        };
      }
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ 
          error: true,
          message: error.message || 'An error occurred',
          details: error.stack 
        }, null, 2)
      }]
    };
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
