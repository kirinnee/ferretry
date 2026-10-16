/**
 * The login quota Info › Usage shows, from the app's one usage store — or nothing, when the host has no
 * store (a harness, a test). Never a second poll: the composer already keeps the feed live.
 */

import type { SessionView } from '@ferretry/protocol';
import { useSyncExternalStore } from 'react';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import type { DaemonUsageStore } from '../../lib/usage-store.ts';
import type { ResolvedQuota } from '../../lib/usage.ts';

const noSubscription = (): (() => void) => () => undefined;
const nothing = (): null => null;

export function useInfoQuota(
  store: DaemonUsageStore | undefined,
  daemonId: DaemonId,
  view: SessionView,
): ResolvedQuota | null {
  useSyncExternalStore(store?.subscribe ?? noSubscription, store?.getSnapshot ?? nothing, store?.getSnapshot ?? nothing);
  return store === undefined ? null : store.quotaFor(daemonId, view);
}
