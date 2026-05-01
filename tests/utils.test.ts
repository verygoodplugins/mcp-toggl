process.env.TZ = 'Europe/London';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateWeeklyReport,
  formatDuration,
  getDateRange,
  isDatePeriod,
  localDateRangeFromArgs,
  parseLocalYMD,
  secondsToHours,
  toLocalYMD,
} from '../src/utils.js';
import type { HydratedTimeEntry } from '../src/types.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('time formatting utilities', () => {
  it('converts seconds to decimal hours', () => {
    expect(secondsToHours(5400)).toBe(1.5);
  });

  it('formats durations compactly', () => {
    expect(formatDuration(3661)).toBe('1h 1m');
    expect(formatDuration(61)).toBe('1m 1s');
    expect(formatDuration(42)).toBe('42s');
  });
});

describe('local date ranges', () => {
  it('formats local midnight without shifting east-of-UTC dates backward', () => {
    const localMidnight = new Date(2026, 3, 19);

    expect(localMidnight.toISOString().split('T')[0]).toBe('2026-04-18');
    expect(toLocalYMD(localMidnight)).toBe('2026-04-19');
  });

  it('parses YYYY-MM-DD at local midnight', () => {
    const parsed = parseLocalYMD('2026-04-19');

    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(3);
    expect(parsed.getDate()).toBe(19);
    expect(parsed.getHours()).toBe(0);
  });

  it('rejects malformed and impossible local dates', () => {
    expect(() => parseLocalYMD('2026-4-19')).toThrow('Invalid date format');
    expect(() => parseLocalYMD('2026-02-30')).toThrow('Invalid calendar date');
  });

  it('validates supported period names', () => {
    expect(isDatePeriod('today')).toBe(true);
    expect(isDatePeriod('lastMonth')).toBe(true);
    expect(isDatePeriod('quarter')).toBe(false);
  });

  it('resolves inclusive end dates to exclusive local boundaries', () => {
    const range = localDateRangeFromArgs({
      start_date: '2026-04-19',
      end_date: '2026-04-20',
    });

    expect(range?.start && toLocalYMD(range.start)).toBe('2026-04-19');
    expect(range?.end && toLocalYMD(range.end)).toBe('2026-04-21');
  });

  it('uses exclusive local period ends for Toggl date filters', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-19T11:00:00Z'));

    const week = getDateRange('week');
    const month = getDateRange('month');

    expect(toLocalYMD(week.start)).toBe('2026-04-13');
    expect(toLocalYMD(week.end)).toBe('2026-04-20');
    expect(toLocalYMD(month.start)).toBe('2026-04-01');
    expect(toLocalYMD(month.end)).toBe('2026-05-01');
  });

  it('groups weekly report entries by local date', () => {
    const entry = {
      id: 1,
      workspace_id: 1,
      workspace_name: 'Workspace',
      start: '2026-04-18T23:30:00.000Z',
      stop: '2026-04-19T00:00:00.000Z',
      duration: 1800,
      description: 'Late work',
      billable: false,
      tags: [],
    } as HydratedTimeEntry;

    const report = generateWeeklyReport(parseLocalYMD('2026-04-13'), parseLocalYMD('2026-04-19'), [
      entry,
    ]);

    expect(report.daily_breakdown).toHaveLength(1);
    expect(report.daily_breakdown[0]?.date).toBe('2026-04-19');
  });
});
