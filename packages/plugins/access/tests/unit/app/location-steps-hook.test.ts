/**
 * The `access.how-to-enable-location` hook Access provides: the device-permissions steps for the device the window is,
 * read when drawn, and a value the contract's narrowing accepts.
 */
import { describe, expect, it } from 'bun:test';
import { ACCESS_HOW_TO_ENABLE_LOCATION_HOOK, ACCESS_PROVIDED_APP_HOOKS } from '../../../contract/index.ts';
import { howToEnable, windowDeviceFacts } from '../../../app/lib/device-permissions.ts';
import { howToEnableLocationHook } from '../../../app/lib/location-steps-hook.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Chrome/130.0 Safari/537.36';

const windowOf = (userAgent: string, maxTouchPoints: number) => ({
  navigator: { userAgent, maxTouchPoints },
  isSecureContext: true,
  matchMedia: () => ({ matches: false }),
});

describe('howToEnableLocationHook', () => {
  it('should give the location steps for the device the window is', () => {
    // Arrange
    const win = windowOf(IPHONE, 5);

    // Act
    const steps = howToEnableLocationHook(win)()();

    // Assert
    expect(steps).toEqual(howToEnable('location', windowDeviceFacts(win)));
    expect(steps.length).toBeGreaterThan(0);
  });

  it('should give a desktop its own steps, not the phone ones', () => {
    expect(howToEnableLocationHook(windowOf(DESKTOP, 0))()()).not.toEqual(
      howToEnableLocationHook(windowOf(IPHONE, 5))()(),
    );
  });

  it('should be a value the contract narrowing accepts, under the name Access declares', () => {
    const narrows = ACCESS_PROVIDED_APP_HOOKS[ACCESS_HOW_TO_ENABLE_LOCATION_HOOK];
    expect(ACCESS_HOW_TO_ENABLE_LOCATION_HOOK.startsWith('access.')).toBe(true);
    expect(narrows(howToEnableLocationHook(windowOf(IPHONE, 5))())).toBe(true);
    expect(narrows('steps')).toBe(false);
  });
});
