import { describe, expect, it } from 'bun:test';
import { launchContextWindow, resolveLaunchCompactAt } from '../../../daemon/lib/launch-compact-at.ts';

const facts = {
  defaultModel: 'small',
  models: [{ id: 'small', context: 128_000 }, { id: 'big', context: 1_000_000 }, { id: 'plain' }],
};

describe('launchContextWindow (v4 contextWindowFor)', () => {
  it('should use the declared window of the model the launch names, else the login’s default model', () => {
    expect(launchContextWindow('big', facts)).toBe(1_000_000);
    expect(launchContextWindow(undefined, facts)).toBe(128_000);
  });

  it('should let a [1m] selector state 1M over a smaller declared window, and ignore the selector otherwise', () => {
    expect(launchContextWindow('small[1m]', facts)).toBe(1_000_000);
    expect(launchContextWindow('small[fast]', facts)).toBe(128_000);
  });

  it('should plan a model that states no window on the 200k default', () => {
    expect(launchContextWindow('plain', facts)).toBe(200_000);
    expect(launchContextWindow('unlisted', facts)).toBe(200_000);
    expect(launchContextWindow(undefined, { models: [] })).toBe(200_000);
  });
});

describe('resolveLaunchCompactAt (v4 resolveCompactAt)', () => {
  it('should use the login’s default when the ferret has none and it fits the window', () => {
    expect(resolveLaunchCompactAt({ own: undefined, accountDefault: 200_000, window: 200_000 })).toBe(200_000);
  });

  it('should let the ferret’s own number win, and its own auto suppress a numeric default', () => {
    expect(resolveLaunchCompactAt({ own: 300_000, accountDefault: 200_000, window: 1_000_000 })).toBe(300_000);
    expect(resolveLaunchCompactAt({ own: 'auto', accountDefault: 200_000, window: 1_000_000 })).toBeUndefined();
  });

  it('should write nothing for Auto, or for a value the model’s window cannot honour', () => {
    expect(resolveLaunchCompactAt({ own: undefined, accountDefault: undefined, window: 200_000 })).toBeUndefined();
    expect(resolveLaunchCompactAt({ own: undefined, accountDefault: 200_000, window: 128_000 })).toBeUndefined();
  });

  it('should drop an oversized own value to Auto rather than fall back to the login’s default', () => {
    expect(resolveLaunchCompactAt({ own: 500_000, accountDefault: 100_000, window: 128_000 })).toBeUndefined();
  });
});
