import { describe, expect, it } from 'vitest';
import { buildTimelineResponse } from '../src/timeline.js';
import type { TimelineEvent } from '../src/types.js';

function event(id: number, filename: string, title = `Sensitive ${id}`): TimelineEvent {
  return {
    id,
    start_time: 1_700_000_000 + id * 100,
    end_time: 1_700_000_060 + id * 100,
    desktop_id: 'desktop-1',
    idle: false,
    filename,
    title,
  };
}

describe('timeline response shaping', () => {
  it('clamps limit below 1 to one returned event', () => {
    const response = buildTimelineResponse([event(1, 'Cursor'), event(2, 'Slack')], { limit: 0 });

    expect(response.total_events).toBe(2);
    expect(response.returned_events).toBe(1);
    expect(response.truncated).toBe(true);
    expect(response.events).toHaveLength(1);
  });

  it('clamps limit above 1000 to 1000 returned events', () => {
    const events = Array.from({ length: 1005 }, (_, index) => event(index + 1, 'Cursor'));
    const response = buildTimelineResponse(events, { limit: 5000 });

    expect(response.total_events).toBe(1005);
    expect(response.returned_events).toBe(1000);
    expect(response.truncated).toBe(true);
    expect(response.events).toHaveLength(1000);
    expect(response.summary).toEqual({ Cursor: 1005 * 60 });
  });

  it('omits events when include_events is false but still computes summary', () => {
    const response = buildTimelineResponse(
      [event(1, 'Cursor'), event(2, 'Slack'), event(3, 'Slack')],
      { include_events: false }
    );

    expect(response.total_events).toBe(3);
    expect(response.returned_events).toBe(0);
    expect(response.truncated).toBe(false);
    expect(response.summary).toEqual({ Slack: 120, Cursor: 60 });
    expect(response).not.toHaveProperty('events');
  });

  it('filters apps using a case-insensitive partial match', () => {
    const response = buildTimelineResponse(
      [event(1, 'Google Chrome'), event(2, 'Cursor'), event(3, 'Chrome Canary')],
      { app: 'chrome' }
    );

    expect(response.total_events).toBe(2);
    expect(response.summary).toEqual({ 'Google Chrome': 60, 'Chrome Canary': 60 });
  });

  it('redacts titles by default while preserving non-sensitive event fields and summary', () => {
    const response = buildTimelineResponse([event(1, 'Mail', 'Inbox - private@example.com')], {});

    expect(response.summary).toEqual({ Mail: 60 });
    expect(response.events?.[0]).toMatchObject({
      id: 1,
      desktop_id: 'desktop-1',
      filename: 'Mail',
      title: null,
      idle: false,
      duration_seconds: 60,
    });
    expect(response.events?.[0]?.start).toBeDefined();
    expect(response.events?.[0]?.end).toBeDefined();
  });

  it('supports explicit redacted title mode', () => {
    const response = buildTimelineResponse([event(1, 'Mail', 'Inbox - private@example.com')], {
      title_mode: 'redacted',
    });

    expect(response.summary).toEqual({ Mail: 60 });
    expect(response.events?.[0]).toMatchObject({
      id: 1,
      desktop_id: 'desktop-1',
      filename: 'Mail',
      title: null,
      idle: false,
      duration_seconds: 60,
    });
    expect(response.events?.[0]?.start).toBeDefined();
    expect(response.events?.[0]?.end).toBeDefined();
  });

  it('returns raw titles only when explicitly requested', () => {
    const response = buildTimelineResponse([event(1, 'Browser', 'OAuth callback token=secret')], {
      title_mode: 'raw',
    });

    expect(response.events?.[0]?.title).toBe('OAuth callback token=secret');
  });

  it('keeps redact_titles false as a deprecated raw-title compatibility flag', () => {
    const response = buildTimelineResponse([event(1, 'Editor', 'private.md')], {
      redact_titles: false,
    });

    expect(response.events?.[0]?.title).toBe('private.md');
  });

  it('rejects invalid title modes before returning events', () => {
    expect(() =>
      buildTimelineResponse([event(1, 'Editor', 'private.md')], {
        title_mode: 'visible',
      })
    ).toThrow('title_mode must be "redacted" or "raw"');
  });

  it('uses four-decimal total_hours precision for timeline display', () => {
    const response = buildTimelineResponse([event(1, 'Cursor')], {});

    expect(response.total_seconds).toBe(60);
    expect(response.total_hours).toBe(0.0167);
  });
});
