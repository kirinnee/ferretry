/**
 * THE CHAT COMPOSER'S PREFERENCES, FOR A COMPOSER THAT IS NOT IN A CHAT: this device's Enter-key choices and
 * dictation settings, and the carrier the composer's own reads go through.
 *
 * A host that draws a composer beside something else (the send-back box under a card) would otherwise have
 * to be handed all of this by every page that can open it. Read here, the box behaves as the chat's does
 * — the same Enter, the same mic — wherever it is drawn, and outside a store (a component suite) it
 * degrades to the defaults with no mic.
 */

import { useSyncExternalStore } from 'react';
import type { ComposerProps } from '../components/composer.tsx';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { useDaemonFetch, useOptionalAppStore } from '../lib/store.tsx';

const noSubscription = (): (() => void) => () => undefined;
const noEnterKey = (): null => null;
const noSettings = (): undefined => undefined;

export type ComposerPreferences = Pick<
  ComposerProps,
  'autocompleteFetcher' | 'dictationSettings' | 'enterKeyPreference' | 'phoneEnterKeyPreference'
>;

/** The preferences the chat composer would use for `daemonId`'s machine. */
export function useComposerPreferences(daemonId: DaemonId): ComposerPreferences {
  const store = useOptionalAppStore();
  const autocompleteFetcher = useDaemonFetch();
  const enterKeyPreference = useSyncExternalStore(
    store?.controls.subscribe ?? noSubscription,
    store === null ? noEnterKey : () => store.controls.controls(daemonId).composerEnterKey,
  );
  const phoneEnterKeyPreference = useSyncExternalStore(
    store?.controls.subscribe ?? noSubscription,
    store === null ? noEnterKey : () => store.controls.controls(daemonId).composerPhoneEnterKey,
  );
  const dictationSettings = useSyncExternalStore(
    store?.stt.subscribe ?? noSubscription,
    store === null ? noSettings : store.stt.get,
  );
  return {
    autocompleteFetcher,
    enterKeyPreference,
    phoneEnterKeyPreference,
    ...(dictationSettings === undefined ? {} : { dictationSettings }),
  };
}
