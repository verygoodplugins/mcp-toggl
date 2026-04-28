process.env.TZ = 'Europe/London';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDuration, getDateRange, parseLocalYMD, secondsToHours, toLocalYMD } from '../src/utils.js';

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
});
