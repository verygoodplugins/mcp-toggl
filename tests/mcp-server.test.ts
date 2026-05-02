import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock('node-fetch', () => ({
  default: fetchMock,
}));

function response({ status = 200, json }: { status?: number; json: unknown }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: vi.fn(() => null),
    },
    text: vi.fn(async () => JSON.stringify(json)),
    json: vi.fn(async () => json),
  };
}

function installMockTogglApi() {
  const workspace = { id: 20, name: 'Workspace', premium: false, default_currency: 'USD' };
  const project = {
    id: 30,
    workspace_id: 20,
    client_id: 40,
    name: 'Project',
    active: true,
    billable: true,
    color: '#123456',
  };
  const client = { id: 40, workspace_id: 20, name: 'Client', archived: false };
  const tags = [{ id: 50, workspace_id: 20, name: 'tag' }];
  const entry = {
    id: 60,
    workspace_id: 20,
    project_id: 30,
    billable: true,
    start: '2026-05-01T09:00:00Z',
    stop: '2026-05-01T10:00:00Z',
    duration: 3600,
    description: 'Focused work',
    tags: ['tag'],
    tag_ids: [50],
  };

  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';

    if (url.endsWith('/me'))
      return response({ json: { id: 10, email: 'private@example.com', fullname: 'Private User' } });
    if (url.endsWith('/workspaces')) return response({ json: [workspace] });
    if (url.endsWith('/workspaces/20')) return response({ json: workspace });
    if (url.endsWith('/workspaces/20/projects')) return response({ json: [project] });
    if (url.endsWith('/workspaces/20/clients')) return response({ json: [client] });
    if (url.endsWith('/workspaces/20/tags')) return response({ json: tags });
    if (url.includes('/me/time_entries/current')) return response({ json: null });
    if (url.includes('/me/time_entries')) return response({ json: [entry] });
    if (url.endsWith('/timeline')) {
      return response({
        json: [
          {
            id: 70,
            start_time: 1_700_000_000,
            end_time: 1_700_000_060,
            desktop_id: 'desktop',
            idle: false,
            filename: 'Browser',
            title: 'Private window title',
          },
        ],
      });
    }
    if (method === 'POST' && url.endsWith('/workspaces/20/time_entries')) {
      return response({
        json: {
          ...entry,
          id: 61,
          stop: undefined,
          duration: -1,
          description: 'Started timer',
        },
      });
    }

    return response({ status: 404, json: { error: 'not found' } });
  });
}

async function createClient() {
  vi.resetModules();
  vi.stubEnv('TOGGL_API_KEY', 'dummy-token');
  vi.stubEnv('TOGGL_API_TOKEN', '');
  vi.stubEnv('TOGGL_TOKEN', '');

  const { createTogglServer } = await import('../src/index.js');
  const server = createTogglServer();
  const client = new Client({ name: 'mcp-toggl-unit-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('mcp server handlers', () => {
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllEnvs();
  });

  it('lists the timeline privacy schema with redacted titles as the default', async () => {
    const { client } = await createClient();

    try {
      const tools = await client.listTools();
      const timelineTool = tools.tools.find((tool) => tool.name === 'toggl_get_timeline');
      const properties = timelineTool?.inputSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;

      expect(timelineTool?.description).toContain('window titles are redacted by default');
      expect(properties?.title_mode).toMatchObject({
        enum: ['redacted', 'raw'],
        default: 'redacted',
      });
      expect(properties?.redact_titles).toMatchObject({
        default: true,
        deprecated: true,
      });
    } finally {
      await client.close();
    }
  });

  it('returns sanitized user-input errors from tool calls', async () => {
    const { client } = await createClient();

    try {
      const payload = await callTool(client, 'toggl_get_timeline', {
        title_mode: 'visible',
      });

      expect(payload).toMatchObject({
        error: true,
        code: 'INVALID_ARGUMENT',
        message: 'title_mode must be "redacted" or "raw"',
      });
    } finally {
      await client.close();
    }
  });

  it('does not expose internals for unknown tool errors', async () => {
    const { client } = await createClient();

    try {
      const payload = await callTool(client, 'toggl_not_a_tool');
      const serialized = JSON.stringify(payload);

      expect(payload).toMatchObject({
        error: true,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error. Check server logs for details.',
      });
      expect(serialized).not.toContain('Unknown tool');
      expect(serialized).not.toContain('/Users/');
      expect(serialized).not.toContain('src/index.ts');
    } finally {
      await client.close();
    }
  });

  it('serves cache tools without calling Toggl', async () => {
    const { client } = await createClient();

    try {
      const stats = await callTool(client, 'toggl_cache_stats');
      expect(stats.cache_warmed).toBe(false);
      expect(stats.hit_rate).toBe('0%');

      const cleared = await callTool(client, 'toggl_clear_cache');
      expect(cleared).toMatchObject({
        success: true,
        message: 'Cache cleared successfully',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('checks auth with masked user email and workspace data', async () => {
    installMockTogglApi();

    const { client } = await createClient();

    try {
      const payload = await callTool(client, 'toggl_check_auth');

      expect(payload).toMatchObject({
        authenticated: true,
        user: {
          id: 10,
          email: 'p***e@example.com',
          fullname: 'Private User',
        },
        workspaces: [{ id: 20, name: 'Workspace' }],
      });
    } finally {
      await client.close();
    }
  });

  it('runs common reporting, lookup, cache, and timer paths with mocked Toggl data', async () => {
    installMockTogglApi();

    const { client } = await createClient();

    try {
      await expect(callTool(client, 'toggl_list_workspaces')).resolves.toMatchObject({
        count: 1,
        workspaces: [{ id: 20, name: 'Workspace' }],
      });
      await expect(
        callTool(client, 'toggl_list_projects', { workspace_id: 20 })
      ).resolves.toMatchObject({
        workspace_id: 20,
        count: 1,
        projects: [{ id: 30, name: 'Project' }],
      });
      await expect(
        callTool(client, 'toggl_list_clients', { workspace_id: 20 })
      ).resolves.toMatchObject({
        workspace_id: 20,
        count: 1,
        clients: [{ id: 40, name: 'Client' }],
      });
      await expect(
        callTool(client, 'toggl_warm_cache', { workspace_id: 20 })
      ).resolves.toMatchObject({
        success: true,
      });
      await expect(
        callTool(client, 'toggl_get_time_entries', { start_date: '2026-05-01' })
      ).resolves.toMatchObject({
        count: 1,
        entries: [
          { id: 60, project_name: 'Project', client_name: 'Client', workspace_name: 'Workspace' },
        ],
      });
      await expect(
        callTool(client, 'toggl_daily_report', { date: '2026-05-01' })
      ).resolves.toMatchObject({
        total_seconds: 3600,
      });
      await expect(
        callTool(client, 'toggl_project_summary', {
          start_date: '2026-05-01',
          end_date: '2026-05-01',
        })
      ).resolves.toMatchObject({
        project_count: 1,
      });
      await expect(
        callTool(client, 'toggl_workspace_summary', {
          start_date: '2026-05-01',
          end_date: '2026-05-01',
        })
      ).resolves.toMatchObject({
        workspace_count: 1,
      });
      await expect(callTool(client, 'toggl_get_current_entry')).resolves.toMatchObject({
        running: false,
      });
      await expect(
        callTool(client, 'toggl_start_timer', {
          workspace_id: 20,
          description: 'Started timer',
          project_id: 30,
          tags: ['tag'],
        })
      ).resolves.toMatchObject({
        success: true,
        entry: { id: 61, running: true },
      });
      await expect(callTool(client, 'toggl_stop_timer')).resolves.toMatchObject({
        success: false,
        message: 'No timer currently running',
      });
    } finally {
      await client.close();
    }
  });

  it('returns redacted timeline events by default and raw titles only on opt-in', async () => {
    installMockTogglApi();

    const { client } = await createClient();

    try {
      const redacted = await callTool(client, 'toggl_get_timeline', {});
      expect(redacted).toMatchObject({
        total_events: 1,
        events: [{ title: null }],
      });

      const raw = await callTool(client, 'toggl_get_timeline', { title_mode: 'raw' });
      expect(raw).toMatchObject({
        total_events: 1,
        events: [{ title: 'Private window title' }],
      });
    } finally {
      await client.close();
    }
  });
});
