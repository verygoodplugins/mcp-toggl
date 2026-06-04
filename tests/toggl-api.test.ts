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

  it('sanitizes auth failures into structured errors', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 401,
        text: 'bad token abc123',
      })
    );

    const api = new TogglAPI('token');
    await expect(api.getWorkspaces()).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      status: 401,
      message:
        'Authentication failed (401). Verify TOGGL_API_KEY is correct, has no leading/trailing spaces, and is the Toggl Track API token.',
    });

    await expect(api.getWorkspaces()).rejects.not.toMatchObject({
      message: expect.stringContaining('abc123'),
    });
  });

  it('treats HTTP 200 with content-length: 0 as a successful empty response', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, contentLength: '0', text: '' }));

    const api = new TogglAPI('token');
    await expect(api.deleteTimeEntry(1, 100)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('toggl api time entry CRUD and tasks', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('POSTs to the workspace time_entries endpoint with start, billable, and created_with', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: {
          id: 100,
          workspace_id: 1,
          start: '2026-05-01T09:00:00Z',
          stop: '2026-05-01T10:00:00Z',
          duration: 3600,
          description: 'Focused work',
          billable: true,
        },
      })
    );

    const api = new TogglAPI('token');
    const entry = await api.createTimeEntry(1, {
      start: '2026-05-01T09:00:00Z',
      stop: '2026-05-01T10:00:00Z',
      description: 'Focused work',
      billable: true,
    });

    expect(entry.id).toBe(100);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/time_entries');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({
      workspace_id: 1,
      created_with: 'mcp-toggl',
      start: '2026-05-01T09:00:00Z',
      stop: '2026-05-01T10:00:00Z',
      description: 'Focused work',
      billable: true,
    });
  });

  it('PUTs to the single time_entry endpoint with only the supplied update fields', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: {
          id: 100,
          workspace_id: 1,
          start: '2026-05-01T09:00:00Z',
          duration: 3600,
          project_id: 50,
          description: 'Categorized',
        },
      })
    );

    const api = new TogglAPI('token');
    const entry = await api.updateTimeEntry(1, 100, {
      project_id: 50,
      description: 'Categorized',
    });

    expect(entry.id).toBe(100);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/time_entries/100');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      project_id: 50,
      description: 'Categorized',
    });
  });

  it('DELETEs the single time_entry endpoint without a body', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, contentLength: '0', text: '' }));

    const api = new TogglAPI('token');
    await api.deleteTimeEntry(1, 100);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/time_entries/100');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('passes billable through startTimer to the underlying createTimeEntry payload', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: {
          id: 101,
          workspace_id: 1,
          start: '2026-05-01T09:00:00Z',
          duration: -1,
          billable: true,
        },
      })
    );

    const api = new TogglAPI('token');
    await api.startTimer(1, 'Working', undefined, undefined, undefined, true);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toMatchObject({
      description: 'Working',
      billable: true,
      duration: -1,
    });
  });

  it('lists tasks for a project in a workspace', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: [{ id: 70, workspace_id: 1, project_id: 50, name: 'Review', active: true }],
      })
    );

    const api = new TogglAPI('token');
    const tasks = await api.getTasks(1, 50);

    expect(tasks).toEqual([
      { id: 70, workspace_id: 1, project_id: 50, name: 'Review', active: true },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.track.toggl.com/api/v9/workspaces/1/projects/50/tasks',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('does not retry create on 4xx client errors', async () => {
    fetchMock.mockResolvedValue(response({ status: 400, text: 'invalid time entry' }));

    const api = new TogglAPI('token');
    await expect(
      api.createTimeEntry(1, { start: '2050-01-01T00:00:00Z', duration: 60 })
    ).rejects.toMatchObject({
      code: 'TOGGL_API_CLIENT_ERROR',
      status: 400,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry ambiguous write failures', async () => {
    const api = new TogglAPI('token');

    fetchMock.mockResolvedValue(response({ status: 500, text: 'server error' }));
    await expect(
      api.createTimeEntry(1, { start: '2026-05-01T09:00:00Z', duration: 60 })
    ).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(response({ status: 500, text: 'server error' }));
    await expect(api.updateTimeEntry(1, 100, { project_id: 50 })).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(response({ status: 500, text: 'server error' }));
    await expect(api.deleteTimeEntry(1, 100)).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('toggl api tag CRUD', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('accepts raw-array workspace tag listings', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: [{ id: 30, workspace_id: 1, name: 'automated' }],
      })
    );

    const api = new TogglAPI('token');
    await expect(api.getTags(1)).resolves.toEqual([{ id: 30, workspace_id: 1, name: 'automated' }]);
  });

  it('accepts documented items-envelope workspace tag listings', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: { items: [{ id: 30, workspace_id: 1, name: 'automated' }] },
      })
    );

    const api = new TogglAPI('token');
    await expect(api.getTags(1)).resolves.toEqual([{ id: 30, workspace_id: 1, name: 'automated' }]);
  });

  it('POSTs to the workspace tags endpoint and normalizes array responses', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: [{ id: 30, workspace_id: 1, name: 'automated' }],
      })
    );

    const api = new TogglAPI('token');
    const tag = await api.createTag(1, 'automated');

    expect(tag).toEqual({ id: 30, workspace_id: 1, name: 'automated' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/tags');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'automated' });
  });

  it('PUTs to the single-tag endpoint and normalizes items-envelope responses', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: { items: [{ id: 30, workspace_id: 1, name: 'manual' }] },
      })
    );

    const api = new TogglAPI('token');
    const tag = await api.updateTag(1, 30, 'manual');

    expect(tag).toEqual({ id: 30, workspace_id: 1, name: 'manual' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/tags/30');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'manual' });
  });

  it('fails tag writes when Toggl omits the created or updated tag', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, json: [] }));

    const api = new TogglAPI('token');
    await expect(api.createTag(1, 'automated')).rejects.toThrow(
      'Toggl tag response did not include a tag'
    );
  });

  it('DELETEs the single-tag endpoint without retrying empty successful responses', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, contentLength: '0', text: '' }));

    const api = new TogglAPI('token');
    await api.deleteTag(1, 30);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/tags/30');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry tag writes on ambiguous failures', async () => {
    const api = new TogglAPI('token');

    fetchMock.mockResolvedValue(response({ status: 500, text: 'server error' }));
    await expect(api.createTag(1, 'automated')).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(response({ status: 500, text: 'server error' }));
    await expect(api.updateTag(1, 30, 'manual')).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(response({ status: 500, text: 'server error' }));
    await expect(api.deleteTag(1, 30)).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
