/** Hydrate and read this daemon's pickable runtime roster. */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { useEffect, useSyncExternalStore } from 'react';
import { LoginChanged } from '@ferretry/plugin-logins/contract';
import { RuntimesChanged, RuntimesDefaultChanged } from '../../contract/index.ts';
import type { AccountPickerSlice, AccountPickerStore } from '../lib/account-picker-store.ts';

export const useAccountPickerSlice = (
  store: AccountPickerStore,
  client: Pick<PluginClient, 'subscribe'>,
): AccountPickerSlice => {
  useEffect(() => {
    void store.hydrate().catch(() => {});
  }, [store]);
  // The roster was read once, so a runtime added anywhere else never reached the picker until the app was reloaded.
  // It is read again the moment the machine says it moved. The roster is the machine's runtimes; the default moving
  // is a roster change too.
  // The health half (each login's state) moves with Logins' own change event.
  useEffect(() => {
    const reread = (): void => store.reread();
    // A profile or model-set change names no runtime, so it shows nothing in the picker.
    const stops = [
      client.subscribe(RuntimesChanged, changed => {
        if (changed.runtimes.length > 0) reread();
      }),
      client.subscribe(RuntimesDefaultChanged, reread),
      client.subscribe(LoginChanged, reread),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [store, client]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
};
