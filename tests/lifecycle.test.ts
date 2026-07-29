import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_PARENT_WATCHDOG_MS,
  parseWatchdogIntervalMs,
  startParentWatchdog,
} from '../src/lifecycle.js';

describe('parseWatchdogIntervalMs', () => {
  it('defaults on unset/invalid/non-positive', () => {
    expect(parseWatchdogIntervalMs(undefined)).toBe(DEFAULT_PARENT_WATCHDOG_MS);
    expect(parseWatchdogIntervalMs('')).toBe(DEFAULT_PARENT_WATCHDOG_MS);
    expect(parseWatchdogIntervalMs('nope')).toBe(DEFAULT_PARENT_WATCHDOG_MS);
    expect(parseWatchdogIntervalMs('0')).toBe(DEFAULT_PARENT_WATCHDOG_MS);
    expect(parseWatchdogIntervalMs('-1')).toBe(DEFAULT_PARENT_WATCHDOG_MS);
  });

  it('honours positive values floored at 100ms', () => {
    expect(parseWatchdogIntervalMs('250')).toBe(250);
    expect(parseWatchdogIntervalMs('50')).toBe(100);
  });
});

describe('startParentWatchdog', () => {
  it('fires once when the probe reports parent gone', async () => {
    vi.useFakeTimers();
    const onDead = vi.fn();
    startParentWatchdog(1, 100, onDead, () => true);
    expect(onDead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(onDead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(onDead).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
