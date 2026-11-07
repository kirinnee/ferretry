import type { PairedDaemon } from '../daemons/daemon-list.ts';
import type { SessionDeviceClaim } from './session-client.ts';

/**
 * WHICH GRANT THIS DEVICE PROVES ON A DAEMON, and the non-extractable key that proves it (§4.13, §7.1). The key is
 * Access's (its `device` session mode; IndexedDB `fy-access`): the shell never holds key material, it asks for a
 * claim per session and signs the transcript through the handle it gets back.
 *
 * GAP: the leaf's `AppHalf` has no provide hook through which Access's app half can hand the shell this port, so
 * day 1 wires {@link noDeviceClaims}: every daemon reads "cannot reach yet" and nothing is sent.
 */
export interface DeviceClaims {
  claim(daemon: PairedDaemon): Promise<SessionDeviceClaim | undefined>;
}

export const noDeviceClaims: DeviceClaims = { claim: async () => undefined };
