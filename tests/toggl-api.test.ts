import { afterEach, describe, expect, it, vi } from 'vitest';
import { TogglAPI, TogglAPIError } from '../src/toggl-api.js';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock('node-fetch', () => ({
  default: fetchMock,
}));

function response({
  status,
  text = '',
  json,
  retryAfter,
  contentLength,
}: {
  status: number;
  text?: string;
  json?: unknown;
  retryAfter?: string;
  contentLength?: string;
}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: vi.fn((name: string) => {
        const key = name.toLowerCase();
        if (key === 'retry-after') return retryAfter;
        if (key === 'content-length') return contentLength;
        return null;
      }),
    },
    text: vi.fn(async () => {
      if (text) return text;
      if (json !== undefined) return JSON.stringify(json);
      return '';
    }),
    json: vi.fn(async () => {
      if (json !== undefined) return json;
      return JSON.parse(text);
    }),
  };
}

describe('toggl api errors', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('parses Toggl quota reset seconds from 402 responses', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 402,
        text: 'You have hit your hourly limit for API calls. The quota will reset in 133 seconds.',
      })
    );

    const api = new TogglAPI('token');
    await expect(api.getWorkspaces()).rejects.toMatchObject({
      code: 'TOGGL_QUOTA_LIMIT',
      status: 402,
      retry_after_seconds: 133,
    });
    await expect(api.getWorkspaces()).rejects.toBeInstanceOf(TogglAPIError);
  });

  it('returns structured rate limit errors instead of sleeping for long retry windows', async () => {
    fetchMock.mockResolvedValue(response({ status: 429, retryAfter: '60' }));

    const api = new TogglAPI('token');
    await expect(api.getWorkspaces()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retry_after_seconds: 60,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Toggl returns HTTP 200 with content-length: 0 (not 204) on some write endpoints,
  // including DELETE /workspaces/{wid}/tags/{tid} and DELETE /workspaces/{wid}/time_entries/{tid}.
  // Naive response.json() throws on the empty body, which previously triggered a misleading retry
  // that could surface as a 404 because the first call had already succeeded server-side.
  it('treats HTTP 200 with content-length: 0 as a successful empty response', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, contentLength: '0', text: '' }));

    const api = new TogglAPI('token');
    await expect(api.deleteTimeEntry(1, 100)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('toggl api project CRUD', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('GETs the active filter onto the projects endpoint when supplied', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, json: [] }));

    const api = new TogglAPI('token');
    await api.getProjects(1, 'true');

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/projects?active=true');
  });

  it('GETs the project directly when workspace_id is provided', async () => {
    fetchMock.mockResolvedValue(
      response({ status: 200, json: { id: 50, workspace_id: 1, name: 'Web' } })
    );

    const api = new TogglAPI('token');
    await api.getProject(50, 1);

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/projects/50');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('POSTs to the workspace projects endpoint and applies active/is_private defaults', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: { id: 50, workspace_id: 1, name: 'New Project', active: true, is_private: false },
      })
    );

    const api = new TogglAPI('token');
    const project = await api.createProject(1, { name: 'New Project' });

    expect(project.id).toBe(50);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/projects');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      name: 'New Project',
      active: true,
      is_private: false,
    });
  });

  it('PUTs to the single project endpoint with only the supplied update fields', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: { id: 50, workspace_id: 1, name: 'Renamed', client_id: null },
      })
    );

    const api = new TogglAPI('token');
    await api.updateProject(1, 50, { name: 'Renamed', client_id: null });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/projects/50');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ name: 'Renamed', client_id: null });
  });

  it('DELETEs the single project endpoint without a body', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, contentLength: '0', text: '' }));

    const api = new TogglAPI('token');
    await api.deleteProject(1, 50);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/projects/50');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('passes teDeletionMode through deleteProject as a query string', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, contentLength: '0', text: '' }));

    const api = new TogglAPI('token');
    await api.deleteProject(1, 50, 'unassign');

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://api.track.toggl.com/api/v9/workspaces/1/projects/50?teDeletionMode=unassign'
    );
  });

  it('does not retry createProject on 4xx client errors', async () => {
    fetchMock.mockResolvedValue(response({ status: 400, text: 'name is required' }));

    const api = new TogglAPI('token');
    await expect(api.createProject(1, { name: '' })).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
