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
  const task = {
    id: 45,
    workspace_id: 20,
    project_id: 30,
    name: 'Review',
    active: true,
    tracked_seconds: 0,
  };
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

  fetchMock.mockImplementation(async (url: string, init?: { body?: string; method?: string }) => {
    const method = init?.method ?? 'GET';

    if (url.endsWith('/me'))
      return response({ json: { id: 10, email: 'private@example.com', fullname: 'Private User' } });
    if (url.endsWith('/workspaces')) return response({ json: [workspace] });
    if (url.endsWith('/workspaces/20')) return response({ json: workspace });
    if (url.endsWith('/workspaces/20/projects')) return response({ json: [project] });
    if (url.endsWith('/workspaces/20/projects/30/tasks')) return response({ json: [task] });
    if (url.endsWith('/workspaces/20/clients')) return response({ json: [client] });
    if (method === 'GET' && url.endsWith('/workspaces/20/tags')) return response({ json: tags });
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
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      return response({
        json: {
          ...entry,
          id: 61,
          project_id: body.project_id ?? entry.project_id,
          task_id: body.task_id,
          stop: body.stop,
          duration: body.duration ?? -1,
          description: body.description ?? 'Started timer',
          billable: body.billable,
          start: body.start ?? entry.start,
        },
      });
    }
    if (method === 'PUT' && url.endsWith('/workspaces/20/time_entries/60')) {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      return response({
        json: {
          ...entry,
          ...body,
          id: 60,
          workspace_id: 20,
        },
      });
    }
    if (method === 'DELETE' && url.endsWith('/workspaces/20/time_entries/60')) {
      return response({ json: {} });
    }
    if (method === 'POST' && url.endsWith('/workspaces/20/tags')) {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      return response({ json: [{ id: 51, workspace_id: 20, name: body.name }] });
    }
    if (method === 'PUT' && url.endsWith('/workspaces/20/tags/50')) {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      return response({ json: [{ id: 50, workspace_id: 20, name: body.name }] });
    }
    if (method === 'DELETE' && url.endsWith('/workspaces/20/tags/50')) {
      return response({ json: {} });
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

  it('lists task and time-entry write tool schemas', async () => {
    const { client } = await createClient();

    try {
      const tools = await client.listTools();
      const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));

      expect(byName.get('toggl_list_tasks')?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
      });
      expect(byName.get('toggl_list_tasks')?.inputSchema.required).toEqual(['project_id']);

      expect(byName.get('toggl_create_time_entry')?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: false,
      });
      expect(byName.get('toggl_update_time_entry')?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      expect(byName.get('toggl_delete_time_entry')?.annotations).toMatchObject({
        destructiveHint: true,
      });
      expect(byName.get('toggl_list_tags')?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
      });
      expect(byName.get('toggl_create_tag')?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: false,
      });
      expect(byName.get('toggl_update_tag')?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      expect(byName.get('toggl_delete_tag')?.annotations).toMatchObject({
        destructiveHint: true,
      });

      const startTimerProps = byName.get('toggl_start_timer')?.inputSchema.properties as
        | Record<string, unknown>
        | undefined;
      expect(startTimerProps).toHaveProperty('billable');
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
        callTool(client, 'toggl_list_tasks', { workspace_id: 20, project_id: 30 })
      ).resolves.toMatchObject({
        workspace_id: 20,
        project_id: 30,
        count: 1,
        tasks: [{ id: 45, name: 'Review' }],
      });
      await expect(
        callTool(client, 'toggl_list_tags', { workspace_id: 20 })
      ).resolves.toMatchObject({
        workspace_id: 20,
        count: 1,
        tags: [{ id: 50, name: 'tag' }],
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
          task_id: 45,
          tags: ['tag'],
          billable: true,
        })
      ).resolves.toMatchObject({
        success: true,
        entry: { id: 61, billable: true, running: true, task_name: 'Review' },
      });
      await expect(
        callTool(client, 'toggl_create_time_entry', {
          workspace_id: 20,
          start: '2026-05-01T11:00:00Z',
          duration: 1800,
          description: 'Backfilled work',
          project_id: 30,
          task_id: 45,
          billable: true,
        })
      ).resolves.toMatchObject({
        success: true,
        entry: { id: 61, description: 'Backfilled work', task_name: 'Review' },
      });
      await expect(
        callTool(client, 'toggl_update_time_entry', {
          workspace_id: 20,
          entry_id: 60,
          project_id: 30,
          task_id: 45,
          description: 'Categorized work',
          billable: true,
        })
      ).resolves.toMatchObject({
        success: true,
        entry: { id: 60, description: 'Categorized work', task_name: 'Review' },
      });
      await expect(
        callTool(client, 'toggl_delete_time_entry', { workspace_id: 20, entry_id: 60 })
      ).resolves.toMatchObject({
        success: true,
        workspace_id: 20,
        entry_id: 60,
      });
      await expect(
        callTool(client, 'toggl_create_tag', { workspace_id: 20, name: 'new-tag' })
      ).resolves.toMatchObject({
        success: true,
        tag: { id: 51, workspace_id: 20, name: 'new-tag' },
      });
      await expect(
        callTool(client, 'toggl_update_tag', { workspace_id: 20, tag_id: 50, name: 'renamed' })
      ).resolves.toMatchObject({
        success: true,
        tag: { id: 50, workspace_id: 20, name: 'renamed' },
      });
      await expect(
        callTool(client, 'toggl_delete_tag', { workspace_id: 20, tag_id: 50 })
      ).resolves.toMatchObject({
        success: true,
        workspace_id: 20,
        tag_id: 50,
      });
      await expect(callTool(client, 'toggl_stop_timer')).resolves.toMatchObject({
        success: false,
        message: 'No timer currently running',
      });

      const updateCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith('/workspaces/20/time_entries/60') && init?.method === 'PUT'
      );
      expect(updateCall).toBeDefined();
      expect(JSON.parse(updateCall![1]?.body as string)).toEqual({
        description: 'Categorized work',
        project_id: 30,
        task_id: 45,
        billable: true,
      });
    } finally {
      await client.close();
    }
  });

  it('returns user-input errors for invalid write tool arguments', async () => {
    installMockTogglApi();

    const { client } = await createClient();

    try {
      await expect(
        callTool(client, 'toggl_update_time_entry', { workspace_id: 20, entry_id: 60 })
      ).resolves.toMatchObject({
        error: true,
        code: 'INVALID_ARGUMENT',
        message: 'No fields to update; provide at least one updatable field',
      });
      await expect(
        callTool(client, 'toggl_create_time_entry', {
          workspace_id: 20,
          start: '2026-05-01T11:00:00Z',
          stop: '2026-05-01T12:00:00Z',
          duration: 3600,
        })
      ).resolves.toMatchObject({
        error: true,
        code: 'INVALID_ARGUMENT',
        message: 'Provide either stop or duration, not both',
      });
      await expect(
        callTool(client, 'toggl_create_time_entry', {
          workspace_id: 20,
          start: '2026-05-01T11:00:00Z',
        })
      ).resolves.toMatchObject({
        error: true,
        code: 'INVALID_ARGUMENT',
        message: 'Provide either stop or duration',
      });
      await expect(
        callTool(client, 'toggl_create_time_entry', {
          workspace_id: 20,
          start: '2026-05-01T11:00:00Z',
          duration: '3600',
        })
      ).resolves.toMatchObject({
        error: true,
        code: 'INVALID_ARGUMENT',
        message: 'Invalid argument: duration must be a finite number',
      });
      await expect(
        callTool(client, 'toggl_update_time_entry', {
          workspace_id: 20,
          entry_id: 60,
          billable: 'true',
        })
      ).resolves.toMatchObject({
        error: true,
        code: 'INVALID_ARGUMENT',
        message: 'Invalid argument: billable must be a boolean',
      });
      await expect(
        callTool(client, 'toggl_update_time_entry', {
          workspace_id: 20,
          entry_id: 60,
          tags: 'tag',
        })
      ).resolves.toMatchObject({
        error: true,
        code: 'INVALID_ARGUMENT',
        message: 'Invalid argument: tags must be an array of strings',
      });
      await expect(
        callTool(client, 'toggl_list_tasks', { workspace_id: 20 })
      ).resolves.toMatchObject({
        error: true,
        code: 'INVALID_ARGUMENT',
        message: 'project_id is required',
      });
      await expect(
        callTool(client, 'toggl_create_tag', { workspace_id: 20, name: ' ' })
      ).resolves.toMatchObject({
        error: true,
        code: 'INVALID_ARGUMENT',
        message: 'Tag name is required',
      });
      await expect(
        callTool(client, 'toggl_update_tag', { workspace_id: 20, name: 'renamed' })
      ).resolves.toMatchObject({
        error: true,
        code: 'INVALID_ARGUMENT',
        message: 'tag_id is required',
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
