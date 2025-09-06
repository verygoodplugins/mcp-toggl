import type {
  Workspace,
  Project,
  Client,
  Task,
  User,
  Tag,
  TimeEntry,
  HydratedTimeEntry,
  CacheEntry,
  CacheStats,
  CacheConfig
} from './types.js';

export class CacheManager {
  private workspaces: Map<number, CacheEntry<Workspace>> = new Map();
  private projects: Map<number, CacheEntry<Project>> = new Map();
  private clients: Map<number, CacheEntry<Client>> = new Map();
  private tasks: Map<number, CacheEntry<Task>> = new Map();
  private users: Map<number, CacheEntry<User>> = new Map();
  private tags: Map<number, CacheEntry<Tag>> = new Map();
  
  // Track cache performance
  private stats = {
    hits: 0,
    misses: 0,
    lastReset: new Date()
  };
  
  private config: CacheConfig;
  private api: any; // Will be set after API client is created
  
  constructor(config: CacheConfig) {
    this.config = config;
  }
  
  setAPI(api: any): void {
    this.api = api;
  }
  
  // Check if cache entry is still valid
  private isValid<T>(entry?: CacheEntry<T>): boolean {
    if (!entry) return false;
    const age = Date.now() - entry.timestamp.getTime();
    return age < entry.ttl;
  }
  
  // Generic cache getter
  private getCached<T>(cache: Map<number, CacheEntry<T>>, id: number): T | null {
    const entry = cache.get(id);
    if (this.isValid(entry)) {
      this.stats.hits++;
      return entry!.data;
    }
    this.stats.misses++;
    return null;
  }
  
  // Generic cache setter
  private setCached<T>(cache: Map<number, CacheEntry<T>>, id: number, data: T): void {
    // Enforce max cache size with LRU eviction
    if (cache.size >= this.config.maxSize / 6) { // Divide by 6 for each cache type
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) {
        cache.delete(firstKey);
      }
    }
    
    cache.set(id, {
      data,
      timestamp: new Date(),
      ttl: this.config.ttl
    });
  }
  
  // Workspace methods
  async getWorkspace(id: number | undefined): Promise<Workspace | null> {
    if (!id) return null;
    const cached = this.getCached(this.workspaces, id);
    if (cached) return cached;
    
    if (!this.api) return null;
    
    try {
      const workspace = await this.api.getWorkspace(id);
      if (workspace) {
        this.setCached(this.workspaces, id, workspace);
      }
      return workspace;
    } catch (error) {
      console.error(`Failed to fetch workspace ${id}:`, error);
      return null;
    }
  }
  
  async getWorkspaces(): Promise<Workspace[]> {
    if (!this.api) return [];
    
    try {
      const workspaces = await this.api.getWorkspaces();
      // Cache all fetched workspaces
      workspaces.forEach((ws: Workspace) => {
        this.setCached(this.workspaces, ws.id, ws);
      });
      return workspaces;
    } catch (error) {
      console.error('Failed to fetch workspaces:', error);
      return [];
    }
  }
  
  // Project methods
  async getProject(id: number): Promise<Project | null> {
    const cached = this.getCached(this.projects, id);
    if (cached) return cached;
    
    if (!this.api) return null;
    
    try {
      const project = await this.api.getProject(id);
      if (project) {
        this.setCached(this.projects, id, project);
      }
      return project;
    } catch (error) {
      console.error(`Failed to fetch project ${id}:`, error);
      return null;
    }
  }
  
  async getProjects(workspaceId: number): Promise<Project[]> {
    if (!this.api) return [];
    
    try {
      const projects = await this.api.getProjects(workspaceId);
      // Cache all fetched projects
      projects.forEach((proj: Project) => {
        this.setCached(this.projects, proj.id, proj);
      });
      return projects;
    } catch (error) {
      console.error(`Failed to fetch projects for workspace ${workspaceId}:`, error);
      return [];
    }
  }
  
  // Client methods
  async getClient(id: number): Promise<Client | null> {
    const cached = this.getCached(this.clients, id);
    if (cached) return cached;
    
    if (!this.api) return null;
    
    try {
      const client = await this.api.getClient(id);
      if (client) {
        this.setCached(this.clients, id, client);
      }
      return client;
    } catch (error) {
      console.error(`Failed to fetch client ${id}:`, error);
      return null;
    }
  }
  
  async getClients(workspaceId: number): Promise<Client[]> {
    if (!this.api) return [];
    
    try {
      const clients = await this.api.getClients(workspaceId);
      // Cache all fetched clients
      clients.forEach((client: Client) => {
        this.setCached(this.clients, client.id, client);
      });
      return clients;
    } catch (error) {
      console.error(`Failed to fetch clients for workspace ${workspaceId}:`, error);
      return [];
    }
  }
  
  // Task methods
  async getTask(id: number, workspaceId: number, projectId: number): Promise<Task | null> {
    const cached = this.getCached(this.tasks, id);
    if (cached) return cached;
    
    if (!this.api) return null;
    
    try {
      const task = await this.api.getTask(workspaceId, projectId, id);
      if (task) {
        this.setCached(this.tasks, id, task);
      }
      return task;
    } catch (error) {
      console.error(`Failed to fetch task ${id}:`, error);
      return null;
    }
  }
  
  async getTasks(workspaceId: number, projectId: number): Promise<Task[]> {
    if (!this.api) return [];
    
    try {
      const tasks = await this.api.getTasks(workspaceId, projectId);
      // Cache all fetched tasks
      tasks.forEach((task: Task) => {
        this.setCached(this.tasks, task.id, task);
      });
      return tasks;
    } catch (error) {
      console.error(`Failed to fetch tasks for project ${projectId}:`, error);
      return [];
    }
  }
  
  // User methods
  async getUser(id: number): Promise<User | null> {
    const cached = this.getCached(this.users, id);
    if (cached) return cached;
    
    if (!this.api) return null;
    
    try {
      const user = await this.api.getUser(id);
      if (user) {
        this.setCached(this.users, id, user);
      }
      return user;
    } catch (error) {
      console.error(`Failed to fetch user ${id}:`, error);
      return null;
    }
  }
  
  // Tag methods
  async getTag(id: number, workspaceId: number): Promise<Tag | null> {
    const cached = this.getCached(this.tags, id);
    if (cached) return cached;
    
    if (!this.api) return null;
    
    try {
      const tag = await this.api.getTag(workspaceId, id);
      if (tag) {
        this.setCached(this.tags, id, tag);
      }
      return tag;
    } catch (error) {
      console.error(`Failed to fetch tag ${id}:`, error);
      return null;
    }
  }
  
  async getTags(workspaceId: number): Promise<Tag[]> {
    if (!this.api) return [];
    
    try {
      const tags = await this.api.getTags(workspaceId);
      // Cache all fetched tags
      tags.forEach((tag: Tag) => {
        this.setCached(this.tags, tag.id, tag);
      });
      return tags;
    } catch (error) {
      console.error(`Failed to fetch tags for workspace ${workspaceId}:`, error);
      return [];
    }
  }
  
  // Warm cache by pre-fetching common entities
  async warmCache(workspaceId?: number): Promise<void> {
    // Log to stderr to avoid interfering with MCP stdio protocol
    console.error('Warming cache...');
    
    try {
      // Fetch all workspaces
      const workspaces = await this.getWorkspaces();
      
      // If workspace specified, fetch its entities
      if (workspaceId) {
        await Promise.all([
          this.getProjects(workspaceId),
          this.getClients(workspaceId),
          this.getTags(workspaceId)
        ]);
      } else {
        // Fetch entities for all workspaces (be careful with rate limits)
        for (const ws of workspaces.slice(0, 3)) { // Limit to first 3 workspaces
          await Promise.all([
            this.getProjects(ws.id),
            this.getClients(ws.id),
            this.getTags(ws.id)
          ]);
        }
      }
      
      console.error('Cache warmed successfully');
    } catch (error) {
      console.error('Failed to warm cache:', error);
    }
  }
  
  // Hydrate time entries with cached names
  async hydrateTimeEntries(entries: TimeEntry[]): Promise<HydratedTimeEntry[]> {
    const hydrated: HydratedTimeEntry[] = [];
    
    // Collect unique IDs to batch fetch if needed
    const workspaceIds = new Set<number>();
    const projectIds = new Set<number>();
    const taskIds = new Set<{wid: number, pid: number, tid: number}>();
    
    entries.forEach(entry => {
      workspaceIds.add(entry.workspace_id);
      if (entry.project_id) projectIds.add(entry.project_id);
      if (entry.task_id && entry.project_id) {
        taskIds.add({
          wid: entry.workspace_id,
          pid: entry.project_id,
          tid: entry.task_id
        });
      }
    });
    
    // Pre-fetch missing entities
    const projectsToFetch = Array.from(projectIds).filter(id => !this.projects.has(id));
    if (projectsToFetch.length > 0 && this.api) {
      console.error(`Fetching ${projectsToFetch.length} missing projects...`);
      await Promise.all(projectsToFetch.map(id => this.getProject(id)));
    }
    
    // Now hydrate each entry
    for (const entry of entries) {
      const hydEntry: HydratedTimeEntry = { ...entry } as HydratedTimeEntry;
      
      // Add workspace name
      const workspace = await this.getWorkspace(entry.workspace_id);
      hydEntry.workspace_name = workspace?.name || `Workspace ${entry.workspace_id}`;
      
      // Add project name and client info
      if (entry.project_id) {
        const project = await this.getProject(entry.project_id);
        hydEntry.project_name = project?.name || `Project ${entry.project_id}`;
        
        if (project?.client_id) {
          hydEntry.client_id = project.client_id;
          const client = await this.getClient(project.client_id);
          hydEntry.client_name = client?.name || `Client ${project.client_id}`;
        }
      }
      
      // Add task name
      if (entry.task_id && entry.project_id) {
        const task = await this.getTask(entry.task_id, entry.workspace_id, entry.project_id);
        hydEntry.task_name = task?.name || `Task ${entry.task_id}`;
      }
      
      // Add user name if available
      if (entry.user_id) {
        const user = await this.getUser(entry.user_id);
        hydEntry.user_name = user?.fullname || user?.email || `User ${entry.user_id}`;
      }
      
      // Add tag names
      if (entry.tag_ids && entry.tag_ids.length > 0) {
        hydEntry.tag_names = [];
        for (const tagId of entry.tag_ids) {
          const tag = await this.getTag(tagId, entry.workspace_id);
          if (tag) {
            hydEntry.tag_names.push(tag.name);
          }
        }
      }
      
      hydrated.push(hydEntry);
    }
    
    return hydrated;
  }
  
  // Clear cache
  clearCache(): void {
    this.workspaces.clear();
    this.projects.clear();
    this.clients.clear();
    this.tasks.clear();
    this.users.clear();
    this.tags.clear();
    this.stats = {
      hits: 0,
      misses: 0,
      lastReset: new Date()
    };
  }
  
  // Get cache statistics
  getStats(): CacheStats {
    return {
      workspaces: this.workspaces.size,
      projects: this.projects.size,
      clients: this.clients.size,
      tasks: this.tasks.size,
      users: this.users.size,
      tags: this.tags.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      lastReset: this.stats.lastReset
    };
  }
  
  // Clear expired entries
  pruneExpired(): void {
    const prune = <T>(cache: Map<number, CacheEntry<T>>) => {
      const expired: number[] = [];
      cache.forEach((entry, key) => {
        if (!this.isValid(entry)) {
          expired.push(key);
        }
      });
      expired.forEach(key => cache.delete(key));
    };
    
    prune(this.workspaces);
    prune(this.projects);
    prune(this.clients);
    prune(this.tasks);
    prune(this.users);
    prune(this.tags);
  }
}
