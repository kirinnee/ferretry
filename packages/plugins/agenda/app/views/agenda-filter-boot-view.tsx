/**
 * AGENDA'S FILTER DOCUMENT AT APP BOOT (shell contract S6): a device view, mounted once at the frame root whether or
 * not a machine is paired. It draws nothing; on mount it writes this device's current notification preferences to the
 * worker's v2 filter document, so a push that arrives while the app is closed is filtered by what the person last chose
 * rather than shown unfiltered until their next change. Every later change is written by the store's `set()`.
 */

import type { DeviceViewProps } from '@ferretry/app';
import { useEffect } from 'react';
import { deviceFilterStore } from '../lib/device-filter-store.ts';

export function AgendaFilterBootView(_props: DeviceViewProps) {
  useEffect(() => {
    deviceFilterStore().mirrorNow();
  }, []);
  return null;
}
