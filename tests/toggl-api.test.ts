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
describe('toggl api tag CRUD', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('POSTs to the workspace tags endpoint with the new name', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: { id: 30, workspace_id: 1, name: 'automated' },
      })
    );

    const api = new TogglAPI('token');
    const tag = await api.createTag(1, 'automated');

    expect(tag).toEqual({ id: 30, workspace_id: 1, name: 'automated' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/tags');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'automated' });
  });

  it('PUTs to the single-tag endpoint with the new name', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: { id: 30, workspace_id: 1, name: 'manual' },
      })
    );

    const api = new TogglAPI('token');
    const tag = await api.updateTag(1, 30, 'manual');

    expect(tag).toEqual({ id: 30, workspace_id: 1, name: 'manual' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/tags/30');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ name: 'manual' });
  });

  it('DELETEs the single-tag endpoint without a body', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, json: {} }));

    const api = new TogglAPI('token');
    await api.deleteTag(1, 30);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/tags/30');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('does not retry tag CRUD on 4xx client errors', async () => {
    fetchMock.mockResolvedValue(response({ status: 400, text: 'Tag name already exists' }));

    const api = new TogglAPI('token');
    await expect(api.createTag(1, 'duplicate')).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('list endpoint pagination', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  const page = (count: number, startId: number) =>
    Array.from({ length: count }, (_, i) => ({ id: startId + i, name: `item-${startId + i}` }));

  it('fetches every page of projects until a short page is returned', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: 200, json: page(200, 1) }))
      .mockResolvedValueOnce(response({ status: 200, json: page(7, 1000) }));

    const api = new TogglAPI('token');
    const projects = await api.getProjects(2154504);

    expect(projects).toHaveLength(207);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain('/workspaces/2154504/projects?per_page=200&page=1');
    expect(urls[1]).toContain('/workspaces/2154504/projects?per_page=200&page=2');
  });

  it('makes a single request when the first page is shorter than the page size', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 200, json: page(3, 1) }));

    const api = new TogglAPI('token');
    const clients = await api.getClients(2154504);

    expect(clients).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/workspaces/2154504/clients?per_page=200&page=1');
  });

  it('stops instead of looping when the endpoint ignores the page param', async () => {
    // Same full page returned regardless of page number — must not loop forever.
    fetchMock.mockResolvedValue(response({ status: 200, json: page(200, 1) }));

    const api = new TogglAPI('token');
    const projects = await api.getProjects(2154504);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(projects).toHaveLength(200);
  });
});
