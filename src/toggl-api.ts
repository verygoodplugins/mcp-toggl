import fetch, { type RequestInit, type Response } from 'node-fetch';
import { toLocalYMD } from './utils.js';
import type {
  Workspace,
  Project,
  Client,
  Task,
  User,
  WorkspaceUser,
  WorkspaceMemberSummary,
  Tag,
  TimeEntry,
  TimeEntriesRequest,
  CreateTimeEntryRequest,
  UpdateTimeEntryRequest,
  TimelineEvent,
} from './types.js';

export class TimelineNotEnabledError extends Error {
  constructor() {
    super('Timeline is not enabled');
    this.name = 'TimelineNotEnabledError';
  }
}

export class TogglAPIError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retry_after_seconds?: number;
  readonly tip?: string;
  readonly noRetry = true;

  constructor({
    status,
    code,
    message,
    retryAfterSeconds,
    tip,
  }: {
    status: number;
    code: string;
    message: string;
    retryAfterSeconds?: number;
    tip?: string;
  }) {
    super(message);
    this.name = 'TogglAPIError';
    this.status = status;
    this.code = code;
    this.retry_after_seconds = retryAfterSeconds;
    this.tip = tip;
  }
}

const MAX_AUTO_RETRY_MS = 30_000;

export class TogglAPI {
  private baseUrl = 'https://api.track.toggl.com/api/v9';
  private timelineBaseUrl = 'https://track.toggl.com/api/v9';
  private headers: Record<string, string>;

  constructor(apiKey: string) {
    // Basic auth: API key as username, 'api_token' as password
    const key = apiKey.trim();
    const auth = Buffer.from(`${key}:api_token`).toString('base64');
    this.headers = {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      'User-Agent': 'mcp-toggl/1.0.0 (+https://verygoodplugins.com)',
    };
  }

  // Shared fetch loop: handles 429 rate-limit backoff, 5xx retry, and network errors.
  // Returns the raw Response (including 4xx) so callers can produce context-specific errors.
  private async fetchWithRetry(url: string, init: RequestInit, retries = 3): Promise<Response> {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, init);

        if (response.status === 429) {
          const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('Retry-After'));
          const delay =
            retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : (i + 1) * 2000;
          if (delay <= MAX_AUTO_RETRY_MS && i < retries - 1) {
            // Log to stderr so we don't pollute MCP stdio
            console.error(`Rate limited. Retrying after ${delay}ms...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw new TogglAPIError({
            status: response.status,
            code: 'RATE_LIMITED',
            message: 'Toggl API rate limit reached.',
            retryAfterSeconds,
            tip: 'Retry after the indicated delay, or use cached/list summary tools to reduce repeated Toggl API calls.',
          });
        }

        // Retry on server errors; return everything else (including 4xx) to the caller.
        if (response.status >= 500 && i < retries - 1) {
          await new Promise((resolve) => setTimeout(resolve, (i + 1) * 1000));
          continue;
        }

        return response;
      } catch (error: any) {
        if (error?.noRetry || i === retries - 1) throw error;
        // Exponential backoff for transient network errors
        await new Promise((resolve) => setTimeout(resolve, (i + 1) * 1000));
      }
    }

    throw new Error('Max retries reached');
  }

  private async request<T>(method: string, endpoint: string, body?: any, retries = 3): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await this.fetchWithRetry(
      url,
      { method, headers: this.headers, body: body ? JSON.stringify(body) : undefined },
      retries
    );

    if (response.status === 204) return {} as T;

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 402) {
        const retryAfterSeconds = parseQuotaResetSeconds(text);
        throw new TogglAPIError({
          status: response.status,
          code: 'TOGGL_QUOTA_LIMIT',
          message: `Toggl API quota limit reached.${retryAfterSeconds !== undefined ? ` Quota resets in ${retryAfterSeconds} seconds.` : ''}`,
          retryAfterSeconds,
          tip: 'Wait for the Toggl quota window to reset. Cache-backed list tools avoid repeated project/client fetches after they are warmed.',
        });
      }
      const isAuth = response.status === 401 || response.status === 403;
      const message = isAuth
        ? `Authentication failed (${response.status}). ` +
          `Verify TOGGL_API_KEY is correct, has no leading/trailing spaces, and is the Toggl Track API token. ` +
          `Server response: ${text}`
        : `Toggl API error (${response.status}): ${text}`;
      throw new Error(message);
    }

    return (await response.json()) as T;
  }

  // User methods
  async getMe(): Promise<User> {
    return this.request<User>('GET', '/me');
  }

  async getUser(_userId: number): Promise<User> {
    // Note: This might require admin permissions
    return this.request<User>('GET', `/me`);
  }

  // Workspace methods
  async getWorkspaces(): Promise<Workspace[]> {
    return this.request<Workspace[]>('GET', '/workspaces');
  }

  async getWorkspace(workspaceId: number): Promise<Workspace> {
    return this.request<Workspace>('GET', `/workspaces/${workspaceId}`);
  }

  async getWorkspaceUsers(workspaceId: number): Promise<WorkspaceUser[]> {
    // Documented Toggl v9 endpoint "Get workspace users". Each item's user id is the `id`
    // field (the docs call it the "Global user identifier") — there is no `uid` here.
    // Membership status is `is_active`. The endpoint also returns `email`, `is_admin`, and
    // `role`, which toWorkspaceMemberSummary() strips before the tool returns them.
    // Chosen over /workspace_users: the only documented `workspace_users` GET is org-scoped
    // (/organizations/{org}/workspaces/{ws}/workspace_users), which we don't have an org id
    // for; the non-org /workspace_users path is undocumented in v9.
    return this.request<WorkspaceUser[]>('GET', `/workspaces/${workspaceId}/users`);
  }

  // Maps a raw /users record to the privacy-safe shape the tool exposes. Kept as a standalone
  // pure function so the "no email/admin/role leaks" guarantee is directly unit-testable.
  static toWorkspaceMemberSummary(raw: WorkspaceUser): WorkspaceMemberSummary {
    return { uid: raw.id as number, name: raw.fullname as string, active: raw.is_active as boolean };
  }

  private async reportsRequest<T>(
    workspaceId: number,
    endpoint: string,
    body: Record<string, unknown>,
    retries = 3
  ): Promise<{ data: T; nextRowNumber?: number }> {
    const url = `https://api.track.toggl.com/reports/api/v3/workspace/${workspaceId}${endpoint}`;
    const response = await this.fetchWithRetry(
      url,
      { method: 'POST', headers: this.headers, body: JSON.stringify(body) },
      retries
    );

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 402) {
        const retryAfterSeconds = parseQuotaResetSeconds(text);
        throw new TogglAPIError({
          status: response.status,
          code: 'TOGGL_QUOTA_LIMIT',
          message: `Toggl Reports API quota limit reached.${retryAfterSeconds !== undefined ? ` Quota resets in ${retryAfterSeconds} seconds.` : ''}`,
          retryAfterSeconds,
          tip: 'Wait for the Toggl quota window to reset, or use a narrower date range to reduce API usage.',
        });
      }
      throw new Error(`Reports API error (${response.status}): ${text}`);
    }

    const nextHeader = response.headers.get('X-Next-Row-Number');
    const nextRowNumber = nextHeader ? Number.parseInt(nextHeader, 10) : undefined;
    return { data: (await response.json()) as T, nextRowNumber };
  }

  // endDate is exclusive, matching the convention used by all other date-range methods.
  // The Reports API uses inclusive end dates; conversion happens internally.
  async getTimeEntriesForUserAndDateRange(
    workspaceId: number,
    userId: number,
    startDate: Date,
    endDate: Date
  ): Promise<TimeEntry[]> {
    // Convert exclusive end to inclusive for the Reports API.
    const inclusiveEnd = new Date(endDate);
    inclusiveEnd.setDate(inclusiveEnd.getDate() - 1);
    // A row from /search/time_entries. In practice each row wraps its entries in a nested
    // `time_entries` array, but the v9 docs don't publish this endpoint's response schema
    // (the 200 is only labelled "Returns grouped time entries"), so we also tolerate a row
    // that carries the entry fields directly — see the defensive flatten below.
    type ReportEntry = { id: number; seconds: number; start: string; stop: string };
    type ReportRow = {
      user_id: number;
      project_id: number | null;
      task_id: number | null;
      billable: boolean;
      description: string;
      tag_ids: number[];
      time_entries?: ReportEntry[];
    } & Partial<ReportEntry>;

    const allEntries: TimeEntry[] = [];
    let firstRowNumber = 1;

    while (true) {
      const { data: rows, nextRowNumber } = await this.reportsRequest<ReportRow[]>(
        workspaceId,
        '/search/time_entries',
        {
          user_ids: [userId],
          start_date: toLocalYMD(startDate),
          end_date: toLocalYMD(inclusiveEnd),
          first_row_number: firstRowNumber,
          // `grouped` is intentionally not sent: the docs confirm it defaults to false and it
          // only affects description-filtered queries (which this one isn't), so it has no
          // effect here.
        }
      );

      // Flatten each row into individual TimeEntry objects. The response shape is undocumented,
      // so be defensive: if a row nests its entries under `time_entries`, use those; otherwise
      // treat the row itself as a single entry.
      for (const row of rows) {
        const entries: ReportEntry[] =
          Array.isArray(row.time_entries) && row.time_entries.length > 0
            ? row.time_entries
            : [{ id: row.id as number, seconds: row.seconds as number, start: row.start as string, stop: row.stop as string }];
        for (const te of entries) {
          allEntries.push({
            id: te.id,
            workspace_id: workspaceId,
            project_id: row.project_id ?? undefined,
            task_id: row.task_id ?? undefined,
            billable: row.billable,
            start: te.start,
            stop: te.stop,
            duration: te.seconds,
            description: row.description,
            tag_ids: row.tag_ids,
            tags: [],
            user_id: row.user_id,
          });
        }
      }

      if (!nextRowNumber || rows.length === 0) break;
      firstRowNumber = nextRowNumber;
    }

    return allEntries;
  }

  // Project methods
  async getProjects(workspaceId: number): Promise<Project[]> {
    return this.request<Project[]>('GET', `/workspaces/${workspaceId}/projects`);
  }

  async getProject(projectId: number): Promise<Project> {
    // First, we need to find which workspace this project belongs to
    // This is a limitation of Toggl API v9 - no direct project endpoint
    const workspaces = await this.getWorkspaces();
    for (const workspace of workspaces) {
      const projects = await this.getProjects(workspace.id);
      const project = projects.find((p) => p.id === projectId);
      if (project) return project;
    }
    throw new Error(`Project ${projectId} not found`);
  }

  // Client methods
  async getClients(workspaceId: number): Promise<Client[]> {
    return this.request<Client[]>('GET', `/workspaces/${workspaceId}/clients`);
  }

  async getClient(clientId: number): Promise<Client> {
    // Similar to projects, need to find workspace first
    const workspaces = await this.getWorkspaces();
    for (const workspace of workspaces) {
      try {
        const clients = await this.getClients(workspace.id);
        const client = clients.find((c) => c.id === clientId);
        if (client) return client;
      } catch (_error) {
        // Workspace might not have clients
        continue;
      }
    }
    throw new Error(`Client ${clientId} not found`);
  }

  // Task methods
  async getTasks(workspaceId: number, projectId: number): Promise<Task[]> {
    return this.request<Task[]>('GET', `/workspaces/${workspaceId}/projects/${projectId}/tasks`);
  }

  async getTask(workspaceId: number, projectId: number, taskId: number): Promise<Task> {
    return this.request<Task>(
      'GET',
      `/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`
    );
  }

  // Tag methods
  async getTags(workspaceId: number): Promise<Tag[]> {
    return this.request<Tag[]>('GET', `/workspaces/${workspaceId}/tags`);
  }

  async getTag(workspaceId: number, tagId: number): Promise<Tag> {
    return this.request<Tag>('GET', `/workspaces/${workspaceId}/tags/${tagId}`);
  }

  // Time entry methods
  async getTimeEntries(params?: TimeEntriesRequest): Promise<TimeEntry[]> {
    let endpoint = '/me/time_entries';

    if (params) {
      const queryParams = new URLSearchParams();
      if (params.start_date) queryParams.append('start_date', params.start_date);
      if (params.end_date) queryParams.append('end_date', params.end_date);
      if (params.since) queryParams.append('since', params.since.toString());
      if (params.before) queryParams.append('before', params.before.toString());
      if (params.meta !== undefined) queryParams.append('meta', params.meta.toString());

      const query = queryParams.toString();
      if (query) endpoint += `?${query}`;
    }

    return this.request<TimeEntry[]>('GET', endpoint);
  }

  async getCurrentTimeEntry(): Promise<TimeEntry | null> {
    const result = await this.request<TimeEntry | null>('GET', '/me/time_entries/current');
    return result;
  }

  async getTimeEntry(timeEntryId: number): Promise<TimeEntry> {
    return this.request<TimeEntry>('GET', `/me/time_entries/${timeEntryId}`);
  }

  async createTimeEntry(
    workspaceId: number,
    entry: Partial<CreateTimeEntryRequest>
  ): Promise<TimeEntry> {
    const payload: CreateTimeEntryRequest = {
      workspace_id: workspaceId,
      created_with: 'mcp-toggl',
      start: entry.start || new Date().toISOString(),
      ...entry,
    };

    return this.request<TimeEntry>('POST', `/workspaces/${workspaceId}/time_entries`, payload);
  }

  async updateTimeEntry(
    workspaceId: number,
    timeEntryId: number,
    updates: UpdateTimeEntryRequest
  ): Promise<TimeEntry> {
    return this.request<TimeEntry>(
      'PUT',
      `/workspaces/${workspaceId}/time_entries/${timeEntryId}`,
      updates
    );
  }

  async deleteTimeEntry(workspaceId: number, timeEntryId: number): Promise<void> {
    await this.request<void>('DELETE', `/workspaces/${workspaceId}/time_entries/${timeEntryId}`);
  }

  async startTimer(
    workspaceId: number,
    description?: string,
    projectId?: number,
    taskId?: number,
    tags?: string[]
  ): Promise<TimeEntry> {
    const entry: Partial<CreateTimeEntryRequest> = {
      description,
      project_id: projectId,
      task_id: taskId,
      tags,
      start: new Date().toISOString(),
      duration: -1, // Negative duration indicates running timer
    };

    return this.createTimeEntry(workspaceId, entry);
  }

  async stopTimer(workspaceId: number, timeEntryId: number): Promise<TimeEntry> {
    const now = new Date().toISOString();
    return this.updateTimeEntry(workspaceId, timeEntryId, { stop: now });
  }

  // Bulk operations for efficiency. endDate is exclusive per Toggl Track v9.
  async getTimeEntriesForDateRange(startDate: Date, endDate: Date): Promise<TimeEntry[]> {
    const params: TimeEntriesRequest = {
      start_date: toLocalYMD(startDate),
      end_date: toLocalYMD(endDate),
    };

    return this.getTimeEntries(params);
  }

  async getTimeEntriesForToday(): Promise<TimeEntry[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    return this.getTimeEntriesForDateRange(today, tomorrow);
  }

  async getTimeEntriesForWeek(weekOffset = 0): Promise<TimeEntry[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayOfWeek = today.getDay();
    const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Adjust for Sunday

    const monday = new Date(today);
    monday.setDate(diff + weekOffset * 7);

    const nextMonday = new Date(monday);
    nextMonday.setDate(nextMonday.getDate() + 7);

    return this.getTimeEntriesForDateRange(monday, nextMonday);
  }

  async getTimeEntriesForMonth(monthOffset = 0): Promise<TimeEntry[]> {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + monthOffset;

    const firstDay = new Date(year, month, 1);
    const firstDayNextMonth = new Date(year, month + 1, 1);

    return this.getTimeEntriesForDateRange(firstDay, firstDayNextMonth);
  }

  async getTimeline(): Promise<TimelineEvent[]> {
    const url = `${this.timelineBaseUrl}/timeline`;
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: this.headers,
        });

        if (response.status === 429) {
          const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('Retry-After'));
          const delay =
            retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : (attempt + 1) * 2000;
          if (delay <= MAX_AUTO_RETRY_MS && attempt < maxRetries - 1) {
            console.error(`Timeline rate limited. Retrying after ${delay}ms...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }

          throw new TogglAPIError({
            status: response.status,
            code: 'RATE_LIMITED',
            message: 'Toggl timeline API rate limit reached.',
            retryAfterSeconds,
            tip: 'Retry after the indicated delay. For Claude Desktop charts, request summary-only timeline output with include_events: false.',
          });
        }

        const text = await response.text();

        if (!response.ok) {
          if (response.status === 400 && parseTimelineError(text) === 'Timeline is not enabled') {
            throw new TimelineNotEnabledError();
          }

          const isAuth = response.status === 401 || response.status === 403;
          const message = isAuth
            ? `Timeline authentication failed (${response.status}). Verify TOGGL_API_KEY is correct. Server response: ${text}`
            : `Timeline API error (${response.status}): ${text}`;
          const err = new Error(message);
          if (response.status >= 400 && response.status < 500) {
            Object.assign(err, { noRetry: true });
          }
          throw err;
        }

        const data = JSON.parse(text) as unknown;
        if (!Array.isArray(data)) {
          throw new Error('Timeline API returned invalid response format');
        }

        return data.filter(isTimelineEvent);
      } catch (error: any) {
        if (
          error instanceof TimelineNotEnabledError ||
          error?.noRetry ||
          attempt === maxRetries - 1
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
      }
    }

    throw new Error('Max retries reached for timeline');
  }
}

function parseTimelineError(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'string' ? parsed : text;
  } catch (_error) {
    return text;
  }
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;

  const deltaSeconds = Number.parseInt(value, 10);
  if (Number.isFinite(deltaSeconds)) return Math.max(0, deltaSeconds);

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
}

function parseQuotaResetSeconds(text: string): number | undefined {
  const match = /quota will reset in (\d+) seconds/i.exec(text);
  if (!match) return undefined;
  const seconds = Number.parseInt(match[1]!, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function isTimelineEvent(value: unknown): value is TimelineEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;

  return (
    typeof event.id === 'number' &&
    typeof event.start_time === 'number' &&
    (typeof event.end_time === 'number' || event.end_time === null) &&
    typeof event.desktop_id === 'string' &&
    typeof event.idle === 'boolean' &&
    (typeof event.filename === 'string' || event.filename === null) &&
    (typeof event.title === 'string' || event.title === null)
  );
}
