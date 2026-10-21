/**
 * The device-permissions host the entry point created (`main.tsx`), read by anything that needs to
 * know what this device is or what it will let Ferretry do. `null` where none was provided — a test,
 * the component harness — and every consumer then shows its no-host state rather than inventing one.
 *
 * `useDevicePermissions` only READS state, on mount and again when the reader returns to the tab
 * (they may have just flipped a switch in the system Settings app). Asking is `request`, and the page
 * calls it from a tap and nowhere else.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  DEVICE_PERMISSIONS,
  type DeviceFacts,
  type DevicePermissionId,
  type DevicePermissionState,
  type DevicePermissionsHost,
} from '../lib/device-permissions.ts';

export const DevicePermissionsContext = createContext<DevicePermissionsHost | null>(null);

/** Facts for a page with no host: a desktop browser tab on a secure connection. */
export const FALLBACK_DEVICE_FACTS: DeviceFacts = { family: 'desktop', installed: false, secure: true };

export const useDeviceFacts = (): DeviceFacts => useContext(DevicePermissionsContext)?.facts ?? FALLBACK_DEVICE_FACTS;

type PermissionStates = Readonly<Partial<Record<DevicePermissionId, DevicePermissionState>>>;

export interface DevicePermissionsController {
  readonly facts: DeviceFacts;
  /** What is known so far; a row not in here has not been read yet. */
  readonly states: PermissionStates;
  /** Ask the browser. Call from a tap. Resolves to the new state. */
  readonly request: (id: DevicePermissionId) => Promise<DevicePermissionState>;
  readonly refresh: () => void;
}

/** Document events that mean "the reader may have changed a setting elsewhere". */
export interface VisibilityTarget {
  addEventListener(type: 'visibilitychange' | 'focus', listener: () => void): void;
  removeEventListener(type: 'visibilitychange' | 'focus', listener: () => void): void;
}

export const useDevicePermissions = (target: VisibilityTarget | null = null): DevicePermissionsController | null => {
  const host = useContext(DevicePermissionsContext);
  const [states, setStates] = useState<PermissionStates>({});
  const alive = useRef(true);

  const refresh = useCallback((): void => {
    if (host === null) return;
    for (const { id } of DEVICE_PERMISSIONS) {
      void host.status(id).then(state => {
        if (alive.current) setStates(current => (current[id] === state ? current : { ...current, [id]: state }));
      });
    }
  }, [host]);

  useEffect(() => {
    alive.current = true;
    refresh();
    target?.addEventListener('visibilitychange', refresh);
    target?.addEventListener('focus', refresh);
    return () => {
      alive.current = false;
      target?.removeEventListener('visibilitychange', refresh);
      target?.removeEventListener('focus', refresh);
    };
  }, [refresh, target]);

  // Not async: the host's request must start in the tap's own turn, with no `await` before it.
  const request = useCallback(
    (id: DevicePermissionId): Promise<DevicePermissionState> => {
      return (host?.request(id) ?? Promise.resolve<DevicePermissionState>('unsupported')).then(state => {
        if (alive.current) setStates(current => ({ ...current, [id]: state }));
        return state;
      });
    },
    [host],
  );

  return host === null ? null : { facts: host.facts, states, request, refresh };
};
