import fetch from 'node-fetch';
import { toLocalYMD } from './utils.js';
import type {
  Workspace,
  Project,
  Client,
  Task,
  User,
  Tag,
  TimeEntry,
  TimeEntriesRequest,
  CreateTimeEntryRequest,
  UpdateTimeEntryRequest,
  CreateProjectRequest,
  UpdateProjectRequest,
  ProjectDeleteMode,
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

  // Generic API request method
  private async request<T>(method: string, endpoint: string, body?: any, retries = 3): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, {
          method,
          headers: this.headers,
          body: body ? JSON.stringify(body) : undefined,
        });

        // Handle rate limiting without sleeping for multi-minute quota resets.
        if (response.status === 429) {
          const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('Retry-After'));
          const delay = retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : (i + 1) * 2000;
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
          const err = new Error(message);
          // 4xx client errors won't succeed on retry (incl. 401/403); 5xx and network errors do retry.
          if (response.status >= 400 && response.status < 500) {
            Object.assign(err, { noRetry: true });
          }
          throw err;
        }

        // Handle empty bodies on success. Toggl returns 200 with content-length: 0
        // for some write endpoints (e.g. DELETE /workspaces/{wid}/tags/{tid}); blindly
        // calling response.json() on those throws and triggers a misleading retry.
        if (response.status === 204) {
          return {} as T;
        }
        const contentLength = response.headers.get('content-length');
        if (contentLength === '0') {
          return {} as T;
        }
        const text = await response.text();
        if (text.length === 0) {
          return {} as T;
        }
        return JSON.parse(text) as T;
      } catch (error: any) {
        if (error?.noRetry || i === retries - 1) throw error;
        // Exponential backoff for transient/network errors
        await new Promise((resolve) => setTimeout(resolve, (i + 1) * 1000));
      }
    }

    throw new Error('Max retries reached');
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

  // Project methods
  async getProjects(
    workspaceId: number,
    active?: 'true' | 'false' | 'both'
  ): Promise<Project[]> {
    const query = active ? `?active=${active}` : '';
    return this.request<Project[]>('GET', `/workspaces/${workspaceId}/projects${query}`);
  }

  async getProject(projectId: number, workspaceId?: number): Promise<Project> {
    if (workspaceId) {
      return this.request<Project>('GET', `/workspaces/${workspaceId}/projects/${projectId}`);
    }
    // Fallback: try the direct endpoint per workspace until one matches.
    const workspaces = await this.getWorkspaces();
    for (const workspace of workspaces) {
      try {
        return await this.request<Project>(
          'GET',
          `/workspaces/${workspace.id}/projects/${projectId}`
        );
      } catch {
        continue;
      }
    }
    throw new Error(`Project ${projectId} not found`);
  }

  async createProject(workspaceId: number, project: CreateProjectRequest): Promise<Project> {
    return this.request<Project>('POST', `/workspaces/${workspaceId}/projects`, {
      ...project,
      active: project.active ?? true,
      is_private: project.is_private ?? false,
    });
  }

  async updateProject(
    workspaceId: number,
    projectId: number,
    updates: UpdateProjectRequest
  ): Promise<Project> {
    return this.request<Project>(
      'PUT',
      `/workspaces/${workspaceId}/projects/${projectId}`,
      updates
    );
  }

  async deleteProject(
    workspaceId: number,
    projectId: number,
    timeEntryDeletionMode?: ProjectDeleteMode
  ): Promise<void> {
    const query = timeEntryDeletionMode ? `?teDeletionMode=${timeEntryDeletionMode}` : '';
    await this.request<void>('DELETE', `/workspaces/${workspaceId}/projects/${projectId}${query}`);
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

  // Reports API endpoints (if needed)
  async getDetailedReport(workspaceId: number, params: any): Promise<any> {
    // This would use the Reports API v3 if needed
    // https://api.track.toggl.com/reports/api/v3/workspace/{workspace_id}/search/time_entries
    const reportsUrl = `https://api.track.toggl.com/reports/api/v3/workspace/${workspaceId}/search/time_entries`;

    const response = await fetch(reportsUrl, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      throw new Error(`Reports API error: ${response.status}`);
    }

    return response.json();
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
