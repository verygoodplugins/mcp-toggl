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
  headers: extraHeaders = {},
}: {
  status: number;
  text?: string;
  json?: unknown;
  retryAfter?: string;
  headers?: Record<string, string | undefined>;
}) {
  const allHeaders: Record<string, string | undefined> = {
    'retry-after': retryAfter,
    ...extraHeaders,
  };
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: vi.fn((name: string) => allHeaders[name.toLowerCase()] ?? null),
    },
    text: vi.fn(async () => text),
    json: vi.fn(async () => json),
  };
}

const TEST_WORKSPACE_ID = 111;
const TEST_USER_ID = 222;
const TEST_PROJECT_ID = 333;

function reportRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: TEST_USER_ID,
    project_id: TEST_PROJECT_ID,
    task_id: null,
    billable: false,
    description: 'test entry',
    tag_ids: [],
    time_entries: [
      { id: 1001, seconds: 3600, start: '2026-05-04T10:00:00+00:00', stop: '2026-05-04T11:00:00+00:00' },
    ],
    ...overrides,
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

  it('retries 5xx server errors and eventually throws', async () => {
    fetchMock.mockResolvedValue(response({ status: 500, text: 'Internal Server Error' }));

    const api = new TogglAPI('token');
    await expect(api.getWorkspaces()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3); // default retries = 3
  });
});

describe('getWorkspaceUsers', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('fetches from the workspace_users endpoint', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: [
          { id: 1, uid: TEST_USER_ID, workspace_id: TEST_WORKSPACE_ID, name: 'Alice', email: 'alice@example.com', active: true, admin: false },
          { id: 2, uid: TEST_USER_ID + 1, workspace_id: TEST_WORKSPACE_ID, name: 'Bob', email: 'bob@example.com', active: true, admin: true },
        ],
      })
    );

    const api = new TogglAPI('token');
    const users = await api.getWorkspaceUsers(TEST_WORKSPACE_ID);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/workspaces/${TEST_WORKSPACE_ID}/workspace_users`),
      expect.any(Object)
    );
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({ uid: TEST_USER_ID, name: 'Alice' });
  });
});

describe('getTimeEntriesForUserAndDateRange', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('converts exclusive end date to inclusive before calling the Reports API', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, json: [] }));

    const api = new TogglAPI('token');
    // May 4 → May 11 exclusive (one full week)
    await api.getTimeEntriesForUserAndDateRange(TEST_WORKSPACE_ID, TEST_USER_ID, new Date(2026, 4, 4), new Date(2026, 4, 11));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.start_date).toBe('2026-05-04');
    expect(body.end_date).toBe('2026-05-10'); // May 11 - 1 day = May 10 inclusive
  });

  it('sends user_ids (Reports API field) as an array containing the requested uid', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, json: [] }));

    const api = new TogglAPI('token');
    await api.getTimeEntriesForUserAndDateRange(TEST_WORKSPACE_ID, TEST_USER_ID, new Date(2026, 4, 4), new Date(2026, 4, 11));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.user_ids).toEqual([TEST_USER_ID]);
  });

  it('flattens grouped report rows into individual TimeEntry objects, preserving all fields', async () => {
    fetchMock.mockResolvedValue(response({
      status: 200,
      json: [
        reportRow({ billable: false }),
        reportRow({ billable: true, time_entries: [{ id: 1002, seconds: 1800, start: '2026-05-04T11:00:00+00:00', stop: '2026-05-04T11:30:00+00:00' }] }),
      ],
    }));

    const api = new TogglAPI('token');
    const entries = await api.getTimeEntriesForUserAndDateRange(TEST_WORKSPACE_ID, TEST_USER_ID, new Date(2026, 4, 4), new Date(2026, 4, 11));

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: 1001,
      workspace_id: TEST_WORKSPACE_ID,
      project_id: TEST_PROJECT_ID,
      duration: 3600,
      description: 'test entry',
      user_id: TEST_USER_ID,
      billable: false,
    });
    expect(entries[1]).toMatchObject({ id: 1002, duration: 1800, billable: true });
  });

  it('fetches multiple pages until X-Next-Row-Number header is absent', async () => {
    fetchMock
      .mockResolvedValueOnce(response({
        status: 200,
        json: [reportRow({ time_entries: [{ id: 1, seconds: 100, start: '2026-05-04T10:00:00+12:00', stop: '2026-05-04T10:01:40+12:00' }] })],
        headers: { 'x-next-row-number': '2' },
      }))
      .mockResolvedValueOnce(response({
        status: 200,
        json: [reportRow({ time_entries: [{ id: 2, seconds: 200, start: '2026-05-05T10:00:00+12:00', stop: '2026-05-05T10:03:20+12:00' }] })],
      }));

    const api = new TogglAPI('token');
    const entries = await api.getTimeEntriesForUserAndDateRange(TEST_WORKSPACE_ID, TEST_USER_ID, new Date(2026, 4, 4), new Date(2026, 4, 11));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(entries.map((e) => e.id)).toEqual([1, 2]);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(secondBody.first_row_number).toBe(2);
  });

  it('throws a quota error with a tip for 402 Reports API responses', async () => {
    fetchMock.mockResolvedValue(
      response({ status: 402, text: 'The quota will reset in 300 seconds.' })
    );

    const api = new TogglAPI('token');
    await expect(
      api.getTimeEntriesForUserAndDateRange(TEST_WORKSPACE_ID, TEST_USER_ID, new Date(2026, 4, 4), new Date(2026, 4, 11))
    ).rejects.toMatchObject({
      code: 'TOGGL_QUOTA_LIMIT',
      status: 402,
      retry_after_seconds: 300,
      tip: expect.stringContaining('quota'),
    });
  });
});
