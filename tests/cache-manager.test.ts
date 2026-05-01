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
