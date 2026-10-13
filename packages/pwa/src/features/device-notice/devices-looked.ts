/**
 * WHICH DEVICES THIS BROWSER HAS ALREADY SEEN ON EACH MACHINE.
 *
 * One SET OF DEVICE IDS per daemon, kept in browser storage under a key that names the daemon, because a
 * browser can be paired with several machines and "seen on A" says nothing about B. It is a set and not
 * an instant because an instant had to be compared with the daemon's `createdAt`, and two clocks that
 * disagree hide exactly the device that matters (see `devicesNotSeen`). The v1 key held an instant; it is
 * not read, so a browser upgrading takes the first-look path once.
 *
 * STORAGE IS A CONVENIENCE, NEVER A REQUIREMENT. A private window, blocked site data or a browser that
 * throws on the property itself all leave this returning `null` and writing nothing; the notice keeps
 * its own copy in memory and still works for as long as the page is open. Every access is wrapped.
 *
 * A LOOK is also announced as a window event, so the Security panel and the notice — two components
 * that never hold a reference to each other — agree the moment one of them looks, with or without
 * storage underneath them. The Security panel does not read the device list, so its event carries no
 * ids: the notice, which holds the list, marks every device on it as seen.
 */

import type { DaemonId } from '../../lib/daemon-connection.ts';

export type DevicesLookedStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const DEVICES_LOOKED_EVENT = 'ferretry:devices-looked';

export interface DevicesLookedDetail {
  readonly daemonId: DaemonId;
}

export const devicesLookedKey = (daemonId: DaemonId): string => `ferretry.devices-seen.v2:${String(daemonId)}`;

/** `localStorage`, or nothing: Safari private mode throws on the property itself. */
export const browserDevicesLookedStorage = (): DevicesLookedStorage | undefined => {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
};

/** The stored set for one daemon, or `null` when there is none or it cannot be read. */
export function readDevicesSeen(
  storage: DevicesLookedStorage | undefined,
  daemonId: DaemonId,
): ReadonlySet<string> | null {
  try {
    const raw = storage?.getItem(devicesLookedKey(daemonId)) ?? null;
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(id => typeof id === 'string') ? new Set(parsed) : null;
  } catch {
    return null;
  }
}

/** Remembers the set, where it can. Says nothing to the page: the notice is the only writer. */
export function rememberDevicesSeen(
  storage: DevicesLookedStorage | undefined,
  daemonId: DaemonId,
  seen: ReadonlySet<string>,
): void {
  try {
    storage?.setItem(devicesLookedKey(daemonId), JSON.stringify([...seen].toSorted()));
  } catch {
    // Storage refused the write. The notice still holds the set for this page.
  }
}

/** Tells every listener on this page that somebody looked at this machine's devices. */
export function announceDevicesLooked(daemonId: DaemonId): void {
  window.dispatchEvent(new CustomEvent<DevicesLookedDetail>(DEVICES_LOOKED_EVENT, { detail: { daemonId } }));
}
