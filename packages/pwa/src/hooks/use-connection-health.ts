/**
 * How well this browser reaches one daemon, as a React subscription.
 *
 * The state is the health model's own stored object, replaced only when it changes, so an unchanged
 * outage does not re-render and every surface reading it reads the same fact. Retrying is not part of
 * the answer: a surface that offers it calls `health.retryNow(daemonId)` on the same object.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { ConnectionHealth, ConnectionHealthState } from '../lib/connection-health.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';

export function useConnectionHealth(health: ConnectionHealth, daemonId: DaemonId): ConnectionHealthState {
  const subscribe = useCallback((listener: () => void) => health.subscribe(daemonId, listener), [health, daemonId]);
  const snapshot = useCallback(() => health.state(daemonId), [health, daemonId]);
  return useSyncExternalStore(subscribe, snapshot);
}
