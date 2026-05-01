import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheManager } from '../src/cache-manager.js';
import type { Client, Project, Tag, TimeEntry, Workspace } from '../src/types.js';

const config = {
  ttl: 60_000,
  maxSize: 1_000,
  batchSize: 100,
};

const workspace: Workspace = { id: 1, name: 'Workspace' };
const project: Project = {
  id: 10,
  workspace_id: 1,
  client_id: 20,
  name: 'Project',
};
const client: Client = { id: 20, workspace_id: 1, name: 'Client' };
const tags: Tag[] = [
  { id: 30, workspace_id: 1, name: 'automated' },
  { id: 31, workspace_id: 1, name: 'test' },
];

afterEach(() => {
  vi.useRealTimers();
});

function createAPI() {
  return {
    getWorkspaces: vi.fn(async () => [workspace]),
    getWorkspace: vi.fn(async () => workspace),
    getProjects: vi.fn(async () => [project]),
    getProject: vi.fn(async () => project),
    getClients: vi.fn(async () => [client]),
    getClient: vi.fn(async () => client),
    getTags: vi.fn(async () => tags),
    getTag: vi.fn(async () => tags[0]),
    getTask: vi.fn(),
    getUser: vi.fn(),
  };
}

describe('cache manager', () => {
  it('refreshes an existing entity without evicting another cached entity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));

    const api = {
      ...createAPI(),
      getWorkspace: vi.fn(async (id: number) => ({ id, name: `Workspace ${id}` })),
    };
    const cache = new CacheManager({
      ...config,
      ttl: 1,
      maxSize: 12,
    });
    cache.setAPI(api);

    await cache.getWorkspace(1);
    await cache.getWorkspace(2);

    vi.setSystemTime(new Date('2026-05-01T10:00:00.002Z'));
    await cache.getWorkspace(2);

    const workspaces = (
      cache as unknown as { workspaces: Map<number, unknown> }
    ).workspaces;
    expect([...workspaces.keys()]).toEqual([1, 2]);
  });

  it('does not cache oversized workspace-scoped project, client, or tag collections', async () => {
    const oversizedProjects: Project[] = [
      { id: 10, workspace_id: 1, name: 'Project 1' },
      { id: 11, workspace_id: 1, name: 'Project 2' },
    ];
    const oversizedClients: Client[] = [
      { id: 20, workspace_id: 1, name: 'Client 1' },
      { id: 21, workspace_id: 1, name: 'Client 2' },
    ];
    const oversizedTags: Tag[] = [
      { id: 30, workspace_id: 1, name: 'tag-1' },
      { id: 31, workspace_id: 1, name: 'tag-2' },
    ];
    const api = {
      ...createAPI(),
      getProjects: vi.fn(async () => oversizedProjects),
      getClients: vi.fn(async () => oversizedClients),
      getTags: vi.fn(async () => oversizedTags),
    };
    const cache = new CacheManager({
      ...config,
      maxSize: 6,
    });
    cache.setAPI(api);

    await expect(cache.getProjects(1)).resolves.toEqual(oversizedProjects);
    await expect(cache.getProjects(1)).resolves.toEqual(oversizedProjects);
    await expect(cache.getClients(1)).resolves.toEqual(oversizedClients);
    await expect(cache.getClients(1)).resolves.toEqual(oversizedClients);
    await expect(cache.getTags(1)).resolves.toEqual(oversizedTags);
    await expect(cache.getTags(1)).resolves.toEqual(oversizedTags);

    expect(api.getProjects).toHaveBeenCalledTimes(2);
    expect(api.getClients).toHaveBeenCalledTimes(2);
    expect(api.getTags).toHaveBeenCalledTimes(2);
  });

  it('evicts per-workspace collection caches only when adding a new workspace', async () => {
    const api = {
      ...createAPI(),
      getProjects: vi.fn(async (workspaceId: number) => [
        {
          id: workspaceId * 10,
          workspace_id: workspaceId,
          name: `Project ${workspaceId}`,
        },
      ]),
    };
    const cache = new CacheManager({
      ...config,
      maxSize: 12,
    });
    cache.setAPI(api);

    await cache.getProjects(1);
    await cache.getProjects(2);
    await cache.getProjects(2);
    await cache.getProjects(3);
    await cache.getProjects(1);

    expect(api.getProjects).toHaveBeenCalledTimes(4);
    expect(api.getProjects).toHaveBeenNthCalledWith(1, 1);
    expect(api.getProjects).toHaveBeenNthCalledWith(2, 2);
    expect(api.getProjects).toHaveBeenNthCalledWith(3, 3);
    expect(api.getProjects).toHaveBeenNthCalledWith(4, 1);
  });

  it('serves warmed workspace collections from cache and records hits', async () => {
    const api = createAPI();
    const cache = new CacheManager(config);
    cache.setAPI(api);

    await cache.warmCache(1);
    const statsAfterWarm = cache.getStats();

    expect(api.getProjects).toHaveBeenCalledTimes(1);
    expect(api.getClients).toHaveBeenCalledTimes(1);
    expect(api.getTags).toHaveBeenCalledTimes(1);
    expect(statsAfterWarm.projects).toBe(1);
    expect(statsAfterWarm.clients).toBe(1);
    expect(statsAfterWarm.tags).toBe(2);

    await expect(cache.getProjects(1)).resolves.toEqual([project]);
    await expect(cache.getClients(1)).resolves.toEqual([client]);
    await expect(cache.getTags(1)).resolves.toEqual(tags);

    expect(api.getProjects).toHaveBeenCalledTimes(1);
    expect(api.getClients).toHaveBeenCalledTimes(1);
    expect(api.getTags).toHaveBeenCalledTimes(1);
    expect(cache.getStats().hits).toBeGreaterThan(statsAfterWarm.hits);
  });

  it('hydrates tags from the workspace tag collection without the single-tag endpoint', async () => {
    const api = createAPI();
    const cache = new CacheManager(config);
    cache.setAPI(api);

    const entry: TimeEntry = {
      id: 100,
      workspace_id: 1,
      project_id: 10,
      start: '2026-05-01T10:00:00.000Z',
      stop: '2026-05-01T10:30:00.000Z',
      duration: 1800,
      tags: ['automated', 'test'],
      tag_ids: [30, 31],
    };

    const [hydrated] = await cache.hydrateTimeEntries([entry]);

    expect(api.getTag).not.toHaveBeenCalled();
    expect(api.getTags).toHaveBeenCalledTimes(1);
    expect(hydrated?.tags).toEqual(['automated', 'test']);
    expect(hydrated?.tag_ids).toEqual([30, 31]);
    expect(hydrated?.tag_names).toEqual(['automated', 'test']);
  });

  it('normalizes null tag fields and adds running duration metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T10:01:00.000Z'));

    const api = createAPI();
    const cache = new CacheManager(config);
    cache.setAPI(api);

    const entry: TimeEntry = {
      id: 101,
      workspace_id: 1,
      start: '2026-05-01T10:00:00.000Z',
      duration: -1_777_600_000,
      tags: null,
      tag_ids: null,
    };

    const [hydrated] = await cache.hydrateTimeEntries([entry]);

    expect(hydrated).toMatchObject({
      tags: [],
      tag_ids: [],
      tag_names: [],
      running: true,
      elapsed_seconds: 60,
      duration_seconds: 60,
      duration: -1_777_600_000,
    });
  });
});
