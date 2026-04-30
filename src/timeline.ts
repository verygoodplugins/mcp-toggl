import type { EnrichedTimelineEvent, TimelineEvent } from './types.js';
import { localDateRangeFromArgs } from './utils.js';

interface TimelineArgs extends Record<string, unknown> {
  app?: unknown;
  include_events?: unknown;
  limit?: unknown;
  redact_titles?: unknown;
  period?: unknown;
  start_date?: unknown;
  end_date?: unknown;
}

export interface TimelineResponse {
  enabled: true;
  total_events: number;
  returned_events: number;
  truncated: boolean;
  total_seconds: number;
  total_hours: number;
  summary: Record<string, number>;
  events?: EnrichedTimelineEvent[];
}

export function timelineSecondsToHours(seconds: number): number {
  return Math.round((seconds / 3600) * 10000) / 10000;
}

export function buildTimelineResponse(
  allEvents: TimelineEvent[],
  args: TimelineArgs | undefined,
  nowSeconds = Math.floor(Date.now() / 1000)
): TimelineResponse {
  const range = localDateRangeFromArgs(args);
  const startTs = range?.start ? range.start.getTime() / 1000 : null;
  const endTs = range?.end ? range.end.getTime() / 1000 : null;
  const appFilter = typeof args?.app === 'string' ? args.app.toLowerCase() : null;
  const includeEvents = args?.include_events !== false;
  const redactTitles = args?.redact_titles === true;
  const rawLimit = typeof args?.limit === 'number' ? args.limit : 50;
  const limit = Math.max(1, Math.min(Math.floor(rawLimit), 1000));

  const appSummary = new Map<string, number>();
  const events: EnrichedTimelineEvent[] = [];
  let totalEvents = 0;
  let totalSeconds = 0;

  for (const event of allEvents) {
    const eventEnd = event.end_time ?? nowSeconds;

    if (startTs !== null && eventEnd <= startTs) continue;
    if (endTs !== null && event.start_time >= endTs) continue;

    const filename = event.filename ?? 'Unknown';
    if (appFilter && !filename.toLowerCase().includes(appFilter)) continue;

    const clippedStart = startTs !== null ? Math.max(event.start_time, startTs) : event.start_time;
    const clippedEnd = endTs !== null ? Math.min(eventEnd, endTs) : eventEnd;
    const duration = Math.max(0, Math.floor(clippedEnd - clippedStart));

    totalEvents++;
    totalSeconds += duration;
    appSummary.set(filename, (appSummary.get(filename) ?? 0) + duration);

    if (includeEvents && events.length < limit) {
      events.push({
        ...event,
        filename,
        title: redactTitles ? null : event.title,
        start: new Date(clippedStart * 1000).toISOString(),
        end: new Date(clippedEnd * 1000).toISOString(),
        duration_seconds: duration,
      });
    }
  }

  return {
    enabled: true,
    total_events: totalEvents,
    returned_events: events.length,
    truncated: includeEvents && totalEvents > events.length,
    total_seconds: totalSeconds,
    total_hours: timelineSecondsToHours(totalSeconds),
    summary: Object.fromEntries([...appSummary.entries()].sort(([, a], [, b]) => b - a)),
    ...(includeEvents ? { events } : {}),
  };
}
