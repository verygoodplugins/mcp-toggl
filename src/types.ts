export interface TogglConfig {
  apiKey: string;
  cacheConfig?: CacheConfig;
  defaultWorkspaceId?: number;
}

export interface CacheConfig {
  ttl: number;        // Time-to-live in milliseconds
  maxSize: number;    // Maximum number of cached entities
  batchSize: number;  // Number of entries to fetch per request
}

// Core Toggl entities
export interface Workspace {
  id: number;
  name: string;
  organization_id?: number;
  profile?: number;
  premium?: boolean;
  business_ws?: boolean;
  admin?: boolean;
  default_currency?: string;
  only_admins_may_create_projects?: boolean;
  only_admins_may_create_tags?: boolean;
  only_admins_see_billable_rates?: boolean;
  only_admins_see_team_dashboard?: boolean;
  projects_billable_by_default?: boolean;
  rate_last_updated?: string;
  reports_collapse?: boolean;
  rounding?: number;
  rounding_minutes?: number;
  api_token?: string;
  at?: string;
  ical_enabled?: boolean;
}

export interface Project {
  id: number;
  workspace_id: number;
  client_id?: number;
  name: string;
  is_private?: boolean;
  active?: boolean;
  at?: string;
  created_at?: string;
  color?: string;
  billable?: boolean;
  template?: boolean;
  auto_estimates?: boolean;
  estimated_hours?: number;
  rate?: number;
  rate_last_updated?: string;
  currency?: string;
  recurring?: boolean;
  recurring_parameters?: any;
  current_period?: any;
  fixed_fee?: number;
  actual_hours?: number;
  wid?: number;
  cid?: number;
}

export interface Client {
  id: number;
  workspace_id: number;
  name: string;
  at?: string;
  notes?: string;
  archived?: boolean;
  wid?: number;
}

export interface Task {
  id: number;
  name: string;
  workspace_id: number;
  project_id: number;
  user_id?: number;
  recurring?: boolean;
  active?: boolean;
  at?: string;
  tracked_seconds?: number;
  estimated_seconds?: number;
}

export interface User {
  id: number;
  email: string;
  fullname: string;
  timezone?: string;
  default_workspace_id?: number;
  beginning_of_week?: number;
  language?: string;
  image_url?: string;
  at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Tag {
  id: number;
  workspace_id: number;
  name: string;
  at?: string;
}

// Time entry interfaces
export interface TimeEntry {
  id: number;
  workspace_id: number;
  project_id?: number;
  task_id?: number;
  billable?: boolean;
  start: string;
  stop?: string;
  duration: number;  // In seconds, negative if currently running
  description?: string;
  tags?: string[];
  tag_ids?: number[];
  duronly?: boolean;
  at?: string;
  server_deleted_at?: string;
  user_id?: number;
  uid?: number;
  wid?: number;
  pid?: number;
  tid?: number;
}

// Hydrated time entry with names instead of just IDs
export interface HydratedTimeEntry extends TimeEntry {
  workspace_name: string;
  project_name?: string;
  task_name?: string;
  client_name?: string;
  client_id?: number;
  user_name?: string;
  tag_names?: string[];
}

// Report interfaces
export interface DailyReport {
  date: string;
  total_hours: number;
  total_seconds: number;
  entries: ReportEntry[];
  by_project: ProjectSummary[];
  by_workspace: WorkspaceSummary[];
}

export interface WeeklyReport {
  week_start: string;
  week_end: string;
  total_hours: number;
  total_seconds: number;
  daily_breakdown: DailyReport[];
  by_project: ProjectSummary[];
  by_workspace: WorkspaceSummary[];
}

export interface ReportEntry {
  id: number;
  workspace: string;
  project?: string;
  client?: string;
  task?: string;
  description?: string;
  start: string;
  stop?: string;
  duration_hours: number;
  duration_seconds: number;
  tags?: string[];
  billable?: boolean;
}

export interface ProjectSummary {
  project_id?: number;
  project_name: string;
  client_name?: string;
  workspace_name: string;
  total_hours: number;
  total_seconds: number;
  billable_hours: number;
  billable_seconds: number;
  entry_count: number;
}

export interface WorkspaceSummary {
  workspace_id: number;
  workspace_name: string;
  total_hours: number;
  total_seconds: number;
  billable_hours: number;
  billable_seconds: number;
  project_count: number;
  entry_count: number;
}

// API request/response interfaces
export interface TimeEntriesRequest {
  start_date?: string;  // ISO 8601 date
  end_date?: string;    // ISO 8601 date
  since?: number;       // Unix timestamp
  before?: number;      // Unix timestamp
  meta?: boolean;       // Include meta information
}

export interface CreateTimeEntryRequest {
  workspace_id: number;
  project_id?: number;
  task_id?: number;
  description?: string;
  tags?: string[];
  tag_ids?: number[];
  billable?: boolean;
  start: string;  // ISO 8601 datetime
  stop?: string;  // ISO 8601 datetime
  duration?: number;  // For entries with only duration
  created_with: string;
}

export interface UpdateTimeEntryRequest {
  project_id?: number;
  task_id?: number;
  description?: string;
  tags?: string[];
  tag_ids?: number[];
  billable?: boolean;
  start?: string;
  stop?: string;
  duration?: number;
}

// Cache interfaces
export interface CacheEntry<T> {
  data: T;
  timestamp: Date;
  ttl: number;
}

export interface CacheStats {
  workspaces: number;
  projects: number;
  clients: number;
  tasks: number;
  users: number;
  tags: number;
  hits: number;
  misses: number;
  lastReset: Date;
}

// Error handling
export interface TogglError {
  code: string;
  message: string;
  tip?: string;
  details?: any;
}

// Tool response types
export interface ToolResponse<T = any> {
  success: boolean;
  data?: T;
  error?: TogglError;
}

// Aggregation helpers
export interface DateRange {
  start: Date;
  end: Date;
}

export interface GroupedEntries {
  [key: string]: HydratedTimeEntry[];
}