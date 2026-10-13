/**
 * Every live connection a paired device holds, so taking its grant away also takes away what it
 * already has open.
 *
 * WHY THIS EXISTS. A socket — a terminal, an event feed, a relayed stream — is authorized ONCE, at
 * the upgrade, and then runs for as long as its peer keeps it open. Removing a device's grant stops
 * its next request and its next upgrade, and on its own it did nothing to the sockets the device
 * already had: a revoked phone kept a live shell on this host for as long as it stayed connected.
 *
 * IT RUNS AFTER THE GRANT IS GONE, NOT BEFORE, and that order is the property. Ending a connection
 * while the credential still verified would let the device reconnect in the gap and keep a socket
 * the revocation had already passed. So this is deliberately not a `DeviceScopedState`, whose
 * purge runs before the grant is removed.
 *
 * A DEVICE THAT WAS UNPAIRED STAYS UNPAIRED HERE. A socket ticket bought just before the revocation
 * is still redeemable for its few seconds, so a connection can be authorized AFTER this ran. The id
 * is remembered, and a connection tracked for it later is ended the moment it is tracked. Device ids
 * are minted fresh at every pairing, so a remembered id never names a new device, and the set grows
 * only with an operator's revocations.
 */

/**
 * How a connection is closed when its device is unpaired. `1008` is "policy violation", and the
 * daemon's own socket constants record that Bun passes it to the peer intact.
 */
export const DEVICE_UNPAIRED_CLOSE = { code: 1008, reason: 'this device is no longer paired' } as const;

/** What a transport tells the registry about one live connection. */
export interface DeviceConnectionTracker {
  /**
   * Registers one live connection, authorized for `deviceId`, with the way to end it.
   *
   * `appSession` names the running copy of the app the connection belongs to, when a session proved
   * one, and `recheck` asks the connection to re-ask whether it is still allowed (see {@link
   * LiveDeviceConnections.recheckAll}). Returns the release the transport calls when the connection
   * ends on its own. A connection for a device that was already unpaired is ended before this returns.
   */
  track(deviceId: string, end: () => void, appSession?: string, recheck?: () => void, lapse?: SessionLapse): () => void;
}

/**
 * How one SESSION is ended when its device replaces its key (`docs/design/zero-trust.md` B6): with the
 * lease-ended close, so the browser reopens it with the new key rather than reading an unpair. `key`
 * names the session (its transcript hash, hex) so the one that carried the rotation can be spared.
 */
export interface SessionLapse {
  readonly key: string;
  readonly end: () => void;
}

/**
 * Told when a running copy of the app gains and loses a live connection, so what is bound to that
 * copy — a passkey step-up — can end when the page does, whatever the page's code kept.
 */
export interface AppSessionObserver {
  /** One connection of this copy opened. Returns the call for when it ends. */
  open(subject: { readonly deviceId: string; readonly appSession: string }): () => void;
}

/** What a revocation asks of the registry. */
export interface DeviceConnectionRevoker {
  /** Ends every live connection `deviceId` holds, and every one tracked for it later. */
  endDevice(deviceId: string): number;
}

export class LiveDeviceConnections implements DeviceConnectionTracker, DeviceConnectionRevoker {
  readonly #live = new Map<string, Set<() => void>>();
  readonly #unpaired = new Set<string>();
  readonly #rechecks = new Set<() => void>();
  readonly #lapses = new Map<string, Set<SessionLapse>>();

  constructor(private readonly appSessions?: AppSessionObserver) {}

  track(deviceId: string, end: () => void, appSession?: string, recheck?: () => void, lapse?: SessionLapse): () => void {
    if (this.#unpaired.has(deviceId)) {
      end();
      return () => undefined;
    }
    const ends = this.#live.get(deviceId) ?? new Set<() => void>();
    // Wrapped, so two connections handing over the same function are still two entries.
    const entry = (): void => end();
    ends.add(entry);
    this.#live.set(deviceId, ends);
    const closeAppSession =
      appSession === undefined || this.appSessions === undefined
        ? () => undefined
        : this.appSessions.open({ deviceId, appSession });
    // Wrapped for the same reason as `entry`.
    const recheckEntry = recheck === undefined ? undefined : (): void => recheck();
    if (recheckEntry !== undefined) this.#rechecks.add(recheckEntry);
    const lapseEntry = lapse === undefined ? undefined : { ...lapse };
    if (lapseEntry !== undefined) {
      const lapses = this.#lapses.get(deviceId) ?? new Set<SessionLapse>();
      lapses.add(lapseEntry);
      this.#lapses.set(deviceId, lapses);
    }
    return () => {
      if (recheckEntry !== undefined) this.#rechecks.delete(recheckEntry);
      if (lapseEntry !== undefined) {
        const lapses = this.#lapses.get(deviceId);
        lapses?.delete(lapseEntry);
        if (lapses?.size === 0) this.#lapses.delete(deviceId);
      }
      ends.delete(entry);
      if (ends.size === 0 && this.#live.get(deviceId) === ends) this.#live.delete(deviceId);
      closeAppSession();
    };
  }

  /**
   * Asks every live connection whether what it carries is still allowed — after a grant changed, so
   * a narrowing reaches the streams that were authorized before it rather than only the next one.
   */
  recheckAll(): void {
    for (const recheck of [...this.#rechecks]) {
      try {
        recheck();
      } catch {
        // One transport failing to re-ask must not stop the others from being asked.
      }
    }
  }

  /**
   * Ends every session of this device but the one named `except`, as a lapsed lease — after its key
   * was replaced, so each reopens with the new key. Returns how many it ended.
   */
  lapseDevice(deviceId: string, except: string): number {
    const lapses = [...(this.#lapses.get(deviceId) ?? [])].filter(lapse => lapse.key !== except);
    for (const lapse of lapses) {
      try {
        lapse.end();
      } catch {
        // One transport failing to close must not leave the device's other sessions on the old key.
      }
    }
    return lapses.length;
  }

  endDevice(deviceId: string): number {
    this.#lapses.delete(deviceId);
    this.#unpaired.add(deviceId);
    const ends = [...(this.#live.get(deviceId) ?? [])];
    this.#live.delete(deviceId);
    // Every one is ended even if an earlier one throws: a revocation that stopped at the first
    // misbehaving transport would leave the rest of the device's connections open.
    for (const end of ends) {
      try {
        end();
      } catch {
        // The connection's own transport failed to close it; there is nothing further to do here.
      }
    }
    return ends.length;
  }
}
