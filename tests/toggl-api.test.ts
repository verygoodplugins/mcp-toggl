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
}: {
  status: number;
  text?: string;
  json?: unknown;
  retryAfter?: string;
}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: vi.fn((name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null)),
    },
    text: vi.fn(async () => text),
    json: vi.fn(async () => json),
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

describe('updateTimeEntry', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('sends a PUT with only the provided fields', async () => {
    fetchMock.mockResolvedValueOnce(
      response({ status: 200, json: { id: 42, description: 'Updated', duration: 3600 } })
    );

    const api = new TogglAPI('token');
    const result = await api.updateTimeEntry(2154504, 42, {
      description: 'Updated',
      duration: 3600,
    });

    expect(result).toMatchObject({ id: 42, description: 'Updated', duration: 3600 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toContain('/workspaces/2154504/time_entries/42');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({
      description: 'Updated',
      duration: 3600,
    });
  });

  it('propagates a sanitized error when the entry does not belong to the workspace', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 403, text: 'Forbidden' }));

    const api = new TogglAPI('token');
    await expect(api.updateTimeEntry(2154504, 42, { description: 'x' })).rejects.toThrow(
      /Authentication failed/
    );
  });
});
