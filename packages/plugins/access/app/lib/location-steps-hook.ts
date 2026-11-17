/**
 * THE `access.how-to-enable-location` HOOK (`contract/app-hooks.ts`): the steps that switch this device's location
 * permission back on, from Access's device-permissions guide, for any half that draws a location chip. They depend on
 * the device (an installed iPhone app, a desktop browser, an insecure address), so they are read from the window at the
 * moment they are drawn, not held.
 */
import type { AccessHowToEnableLocation } from '../../contract/index.ts';
import { howToEnable, type PermissionsWindow, windowDeviceFacts } from './device-permissions.ts';

/** The hook's factory over a window (the page's own by default, looked up when the steps are drawn). */
export const howToEnableLocationHook =
  (win?: PermissionsWindow): (() => AccessHowToEnableLocation) =>
  () =>
  () =>
    howToEnable('location', windowDeviceFacts(win ?? window));
