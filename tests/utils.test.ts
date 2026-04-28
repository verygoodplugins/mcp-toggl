import { describe, expect, it } from 'vitest';
import { formatDuration, secondsToHours } from '../src/utils.js';

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
