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
   * Returns the release the transport calls when the connection ends on its own. A connection for a
   * device that was already unpaired is ended before this returns.
   */
  track(deviceId: string, end: () => void): () => void;
}

/** What a revocation asks of the registry. */
export interface DeviceConnectionRevoker {
  /** Ends every live connection `deviceId` holds, and every one tracked for it later. */
  endDevice(deviceId: string): number;
}

export class LiveDeviceConnections implements DeviceConnectionTracker, DeviceConnectionRevoker {
  readonly #live = new Map<string, Set<() => void>>();
  readonly #unpaired = new Set<string>();

  track(deviceId: string, end: () => void): () => void {
    if (this.#unpaired.has(deviceId)) {
      end();
      return () => undefined;
    }
    const ends = this.#live.get(deviceId) ?? new Set<() => void>();
    // Wrapped, so two connections handing over the same function are still two entries.
    const entry = (): void => end();
    ends.add(entry);
    this.#live.set(deviceId, ends);
    return () => {
      ends.delete(entry);
      if (ends.size === 0 && this.#live.get(deviceId) === ends) this.#live.delete(deviceId);
    };
  }

  endDevice(deviceId: string): number {
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
