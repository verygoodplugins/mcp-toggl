import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TogglAPI } from './toggl-api.js';

// Mock node-fetch
vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));

import fetch from 'node-fetch';
const mockFetch = vi.mocked(fetch);

function mockResponse(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as any;
}

describe('TogglAPI', () => {
  let api: TogglAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    api = new TogglAPI('test-api-key');
  });

  describe('createTimeEntry', () => {
    it('creates a completed time entry with start and stop', async () => {
      const entry = {
        id: 123,
        workspace_id: 1,
        start: '2026-03-31T07:00:00Z',
        stop: '2026-03-31T08:00:00Z',
        duration: 3600,
        description: 'Acquisitie',
        project_id: 42,
      };
      mockFetch.mockResolvedValueOnce(mockResponse(entry));

      const result = await api.createTimeEntry(1, {
        start: '2026-03-31T07:00:00Z',
        stop: '2026-03-31T08:00:00Z',
        duration: 3600,
        description: 'Acquisitie',
        project_id: 42,
      });

      expect(result).toEqual(entry);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/1/time_entries',
        expect.objectContaining({
          method: 'POST',
          body: expect.any(String),
        })
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
      expect(body.description).toBe('Acquisitie');
      expect(body.project_id).toBe(42);
      expect(body.start).toBe('2026-03-31T07:00:00Z');
      expect(body.stop).toBe('2026-03-31T08:00:00Z');
      expect(body.duration).toBe(3600);
      expect(body.created_with).toBe('mcp-toggl');
    });

    it('creates an entry with only start and duration (no stop)', async () => {
      const entry = {
        id: 124,
        workspace_id: 1,
        start: '2026-03-31T07:00:00Z',
        duration: 1800,
      };
      mockFetch.mockResolvedValueOnce(mockResponse(entry));

      const result = await api.createTimeEntry(1, {
        start: '2026-03-31T07:00:00Z',
        duration: 1800,
      });

      expect(result.duration).toBe(1800);
    });

    it('creates a running timer with duration -1', async () => {
      const entry = {
        id: 125,
        workspace_id: 1,
        start: '2026-03-31T09:00:00Z',
        duration: -1,
      };
      mockFetch.mockResolvedValueOnce(mockResponse(entry));

      const result = await api.startTimer(1, 'Working', 42);

      expect(result.duration).toBe(-1);
      const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
      expect(body.duration).toBe(-1);
      expect(body.project_id).toBe(42);
    });

    it('includes tags when provided', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ id: 126, workspace_id: 1 }));

      await api.createTimeEntry(1, {
        start: '2026-03-31T07:00:00Z',
        stop: '2026-03-31T08:00:00Z',
        duration: 3600,
        tags: ['client-work', 'billable'],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
      expect(body.tags).toEqual(['client-work', 'billable']);
    });
  });

  describe('updateTimeEntry', () => {
    it('updates description and project', async () => {
      const updated = {
        id: 123,
        workspace_id: 1,
        description: 'Updated description',
        project_id: 99,
      };
      mockFetch.mockResolvedValueOnce(mockResponse(updated));

      const result = await api.updateTimeEntry(1, 123, {
        description: 'Updated description',
        project_id: 99,
      });

      expect(result.description).toBe('Updated description');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/1/time_entries/123',
        expect.objectContaining({ method: 'PUT' })
      );
    });

    it('updates start and stop times', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ id: 123, workspace_id: 1 }));

      await api.updateTimeEntry(1, 123, {
        start: '2026-03-31T08:00:00Z',
        stop: '2026-03-31T09:00:00Z',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
      expect(body.start).toBe('2026-03-31T08:00:00Z');
      expect(body.stop).toBe('2026-03-31T09:00:00Z');
    });

    it('can set tags to empty array', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ id: 123, workspace_id: 1 }));

      await api.updateTimeEntry(1, 123, { tags: [] });

      const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
      expect(body.tags).toEqual([]);
    });
  });

  describe('deleteTimeEntry', () => {
    it('sends DELETE request with correct URL', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 204));

      await api.deleteTimeEntry(1, 123);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/1/time_entries/123',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  describe('stopTimer', () => {
    it('sends stop time to running entry', async () => {
      const stopped = {
        id: 125,
        workspace_id: 1,
        duration: 3600,
        stop: '2026-03-31T10:00:00Z',
      };
      mockFetch.mockResolvedValueOnce(mockResponse(stopped));

      const result = await api.stopTimer(1, 125);

      expect(result.duration).toBe(3600);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.track.toggl.com/api/v9/workspaces/1/time_entries/125',
        expect.objectContaining({ method: 'PUT' })
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
      expect(body.stop).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('throws descriptive error on auth failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => 'Unauthorized',
      } as any);

      await expect(api.createTimeEntry(1, {
        start: '2026-03-31T07:00:00Z',
        duration: 3600,
      })).rejects.toThrow('Authentication failed');
    });

    it('retries on rate limit (429)', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: { get: () => '1' },
          text: async () => 'Rate limited',
        } as any)
        .mockResolvedValueOnce(mockResponse({ id: 123, workspace_id: 1 }));

      const result = await api.createTimeEntry(1, {
        start: '2026-03-31T07:00:00Z',
        duration: 3600,
      });

      expect(result.id).toBe(123);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
