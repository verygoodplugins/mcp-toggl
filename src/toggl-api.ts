import fetch from 'node-fetch';
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
  TimelineEvent
} from './types.js';

export class TogglAPI {
  private baseUrl = 'https://api.track.toggl.com/api/v9';
  private timelineBaseUrl = 'https://track.toggl.com/api/v9';
  private headers: Record<string, string>;
  
  constructor(apiKey: string) {
    // Basic auth: API key as username, 'api_token' as password
    const key = apiKey.trim();
    const auth = Buffer.from(`${key}:api_token`).toString('base64');
    this.headers = {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'User-Agent': 'mcp-toggl/1.0.0 (+https://verygoodplugins.com)'
    };
  }
  
  // Generic API request method
  private async request<T>(
    method: string,
    endpoint: string,
    body?: any,
    retries = 3
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    // Debug logging for troubleshooting
    if (process.env.TOGGL_DEBUG === 'true') {
      console.error(`[TOGGL API] ${method} ${url}`);
    }
    
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, {
          method,
          headers: this.headers,
          body: body ? JSON.stringify(body) : undefined
        });
        
        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const delay = retryAfter ? parseInt(retryAfter) * 1000 : (i + 1) * 2000;
          // Log to stderr so we don't pollute MCP stdio
          console.error(`Rate limited. Retrying after ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        if (!response.ok) {
          const text = await response.text();
          if (response.status === 401 || response.status === 403) {
            // Normalize common auth failure into a clearer message
            throw new Error(
              `Authentication failed (${response.status}). ` +
              `Verify TOGGL_API_KEY is correct, has no leading/trailing spaces, and is the Toggl Track API token. ` +
              `Server response: ${text}`
            );
          }
          throw new Error(`Toggl API error (${response.status}): ${text}`);
        }
        
        // Handle 204 No Content
        if (response.status === 204) {
          return {} as T;
        }
        
        return await response.json() as T;
      } catch (error) {
        if (i === retries - 1) throw error;
        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, (i + 1) * 1000));
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
  async getProjects(workspaceId: number): Promise<Project[]> {
    return this.request<Project[]>('GET', `/workspaces/${workspaceId}/projects`);
  }
  
  async getProject(projectId: number): Promise<Project> {
    // First, we need to find which workspace this project belongs to
    // This is a limitation of Toggl API v9 - no direct project endpoint
    const workspaces = await this.getWorkspaces();
    for (const workspace of workspaces) {
      const projects = await this.getProjects(workspace.id);
      const project = projects.find(p => p.id === projectId);
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
        const client = clients.find(c => c.id === clientId);
        if (client) return client;
      } catch (error) {
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
    return this.request<Task>('GET', `/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`);
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
  
  async createTimeEntry(workspaceId: number, entry: Partial<CreateTimeEntryRequest>): Promise<TimeEntry> {
    const payload: CreateTimeEntryRequest = {
      workspace_id: workspaceId,
      created_with: 'mcp-toggl',
      start: entry.start || new Date().toISOString(),
      ...entry
    };
    
    return this.request<TimeEntry>('POST', `/workspaces/${workspaceId}/time_entries`, payload);
  }
  
  async updateTimeEntry(workspaceId: number, timeEntryId: number, updates: UpdateTimeEntryRequest): Promise<TimeEntry> {
    return this.request<TimeEntry>('PUT', `/workspaces/${workspaceId}/time_entries/${timeEntryId}`, updates);
  }
  
  async deleteTimeEntry(workspaceId: number, timeEntryId: number): Promise<void> {
    await this.request<void>('DELETE', `/workspaces/${workspaceId}/time_entries/${timeEntryId}`);
  }
  
  async startTimer(workspaceId: number, description?: string, projectId?: number, taskId?: number, tags?: string[]): Promise<TimeEntry> {
    const entry: Partial<CreateTimeEntryRequest> = {
      description,
      project_id: projectId,
      task_id: taskId,
      tags,
      start: new Date().toISOString(),
      duration: -1 // Negative duration indicates running timer
    };
    
    return this.createTimeEntry(workspaceId, entry);
  }
  
  async stopTimer(workspaceId: number, timeEntryId: number): Promise<TimeEntry> {
    const now = new Date().toISOString();
    return this.updateTimeEntry(workspaceId, timeEntryId, { stop: now });
  }
  
  // Bulk operations for efficiency
  async getTimeEntriesForDateRange(startDate: Date, endDate: Date): Promise<TimeEntry[]> {
    const params: TimeEntriesRequest = {
      start_date: startDate.toISOString().split('T')[0],
      end_date: endDate.toISOString().split('T')[0]
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
    const dayOfWeek = today.getDay();
    const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Adjust for Sunday
    
    const monday = new Date(today.setDate(diff));
    monday.setDate(monday.getDate() + (weekOffset * 7));
    monday.setHours(0, 0, 0, 0);
    
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    
    return this.getTimeEntriesForDateRange(monday, sunday);
  }
  
  async getTimeEntriesForMonth(monthOffset = 0): Promise<TimeEntry[]> {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + monthOffset;
    
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    
    return this.getTimeEntriesForDateRange(firstDay, lastDay);
  }
  
  // Reports API endpoints (if needed)
  async getDetailedReport(workspaceId: number, params: any): Promise<any> {
    // This would use the Reports API v3 if needed
    // https://api.track.toggl.com/reports/api/v3/workspace/{workspace_id}/search/time_entries
    const reportsUrl = `https://api.track.toggl.com/reports/api/v3/workspace/${workspaceId}/search/time_entries`;

    const response = await fetch(reportsUrl, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(params)
    });

    if (!response.ok) {
      throw new Error(`Reports API error: ${response.status}`);
    }

    return response.json();
  }

  // Timeline API (desktop activity tracking)
  // Note: Uses different base URL (track.toggl.com instead of api.track.toggl.com)
  // This is an undocumented endpoint that may change without notice
  async getTimeline(): Promise<TimelineEvent[]> {
    const url = `${this.timelineBaseUrl}/timeline`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.headers
    });

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Timeline authentication failed (${response.status}). ` +
          `Verify TOGGL_API_KEY is correct. Server response: ${text}`
        );
      }
      throw new Error(`Timeline API error (${response.status}): ${text}`);
    }

    const data = await response.json();

    // Validate response is array
    if (!Array.isArray(data)) {
      throw new Error('Timeline API returned invalid response format');
    }

    // Filter to only valid timeline events
    return data.filter(isTimelineEvent);
  }
}

// Type guard for TimelineEvent validation
function isTimelineEvent(value: unknown): value is TimelineEvent {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'number' &&
    typeof obj.start_time === 'number' &&
    (typeof obj.end_time === 'number' || obj.end_time === null) &&
    typeof obj.desktop_id === 'string' &&
    typeof obj.idle === 'boolean'
  );
}
