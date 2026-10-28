/** The device's "Group Needs you at the top" choice (Settings › Appearance). On until the reader turns it off. */

import { useSyncExternalStore } from 'react';
import type { DaemonControlsStore } from '../lib/controls.ts';

export const useGroupNeedsYou = (controls: DaemonControlsStore): boolean =>
  useSyncExternalStore(
    controls.subscribe,
    () => controls.snapshot().device.groupNeedsYou,
    () => controls.snapshot().device.groupNeedsYou,
  );
