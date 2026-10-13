/**
 * WHEN THIS BROWSER LAST LOOKED AT WHO IS PAIRED WITH EACH MACHINE.
 *
 * One instant per daemon, kept in browser storage under a key that names the daemon, because a browser
 * can be paired with several machines and "looked at the devices on A" says nothing about B.
 *
 * STORAGE IS A CONVENIENCE, NEVER A REQUIREMENT. A private window, blocked site data or a browser that
 * throws on the property itself all leave this returning `null` and writing nothing; the notice keeps
 * its own copy in memory and still works for as long as the page is open. Every access is wrapped.
 *
 * A mark is also announced as a window event, so the Security panel and the notice — two components
 * that never hold a reference to each other — agree the moment one of them marks, with or without
 * storage underneath them.
 */

import type { DaemonId } from '../../lib/daemon-connection.ts';

export type DevicesLookedStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const DEVICES_LOOKED_EVENT = 'ferretry:devices-looked';

export interface DevicesLookedDetail {
  readonly daemonId: DaemonId;
  readonly at: number;
}

export const devicesLookedKey = (daemonId: DaemonId): string => `ferretry.devices-looked.v1:${String(daemonId)}`;

/** `localStorage`, or nothing: Safari private mode throws on the property itself. */
export const browserDevicesLookedStorage = (): DevicesLookedStorage | undefined => {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
};

/** The stored instant for one daemon, or `null` when there is none or it cannot be read. */
export function readDevicesLooked(storage: DevicesLookedStorage | undefined, daemonId: DaemonId): number | null {
  try {
    const raw = storage?.getItem(devicesLookedKey(daemonId)) ?? null;
    if (raw === null) return null;
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** Remembers the instant, where it can, and tells every listener on this page either way. */
export function markDevicesLooked(storage: DevicesLookedStorage | undefined, daemonId: DaemonId, at: number): void {
  try {
    storage?.setItem(devicesLookedKey(daemonId), String(at));
  } catch {
    // Storage refused the write. The event below still carries the instant to this page.
  }
  window.dispatchEvent(new CustomEvent<DevicesLookedDetail>(DEVICES_LOOKED_EVENT, { detail: { daemonId, at } }));
}
