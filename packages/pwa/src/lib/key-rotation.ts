/**
 * THE BROWSER'S HALF OF DEVICE-KEY ROTATION (`docs/design/zero-trust.md` B6).
 *
 * The daemon says when a device's key is due (`rotateBy`, on the record that accepted the session).
 * Once it has passed, the next step-up must carry a replacement key and that key's proof over the
 * transcript of the session carrying the request — so the replacement can be minted, kept and signed
 * only here, where the session and the key store are both in reach, and never by the ceremony.
 *
 * THE ORDER IS THE POINT. The new key is written as PENDING before the request leaves, because the
 * daemon may swap and the answer may never arrive; a device that only held the key in memory would be
 * locked out by a dropped response. Three outcomes follow, and nothing is left ambiguous:
 *
 * - the daemon says `keyRotated` → the pending key is PROMOTED and the old one is gone;
 * - the daemon answers anything else → it did not swap, so the pending key is DISCARDED;
 * - no answer at all → the pending key STAYS, and the carrier tries it once if the old key is refused.
 */

import { type DeviceKeyRotation, StepUpGrantedSchema } from '@ferretry/protocol';
import type { PrivateKeyHandle } from '@ferretry/relay';
import { type DeviceKeyGenerator, type DeviceKeyStore, mintDeviceKey } from './device-keys.ts';

/** The one route a rotation rides, because the daemon's refusal and its acceptance are both there. */
const STEP_UP_PATH = '/v1/step-up';

/** What a session must offer: when it was told to rotate, and a proof only it can make. */
export interface RotatingSession {
  rotateBy(): string | undefined;
  signRotation(deviceId: string, newKey: PrivateKeyHandle, newPublicKey: string): Promise<DeviceKeyRotation>;
}

/** The WebCrypto this needs: a key to mint and the handle the session signs with. */
export interface KeyRotationCrypto extends DeviceKeyGenerator {
  deviceKeyHandle(key: CryptoKey): PrivateKeyHandle;
}

export interface KeyRotationDependencies {
  readonly store: DeviceKeyStore;
  readonly crypto: KeyRotationCrypto;
  /** Epoch milliseconds. A parameter so a suite can place `rotateBy` on either side of now. */
  readonly now?: () => number;
}

/** A request, and whether it now carries a replacement key whose fate must be settled afterwards. */
export interface AmendedRequest {
  readonly init: RequestInit;
  readonly rotated: boolean;
}

export class KeyRotation {
  readonly #store: DeviceKeyStore;
  readonly #crypto: KeyRotationCrypto;
  readonly #now: () => number;

  constructor(deps: KeyRotationDependencies) {
    this.#store = deps.store;
    this.#crypto = deps.crypto;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Adds the replacement to a step-up request, when this is one and the session says it is due.
   *
   * Anything else is returned untouched — another route, a body that is not the JSON object the
   * ceremony wrote, a session that asked for nothing, a `rotateBy` still in the future. An
   * unreadable instant counts as not due: the daemon is the judge, and it will refuse a step-up that
   * needed a rotation in words that say so.
   */
  async amend(
    session: RotatingSession,
    daemon: { readonly daemonId: string; readonly deviceId: string },
    url: string,
    init: RequestInit,
  ): Promise<AmendedRequest> {
    const unchanged = { init, rotated: false };
    if ((init.method ?? 'GET').toUpperCase() !== 'POST' || new URL(url).pathname !== STEP_UP_PATH) return unchanged;
    if (!this.#due(session.rotateBy()) || typeof init.body !== 'string') return unchanged;
    let assertion: unknown;
    try {
      assertion = JSON.parse(init.body);
    } catch {
      return unchanged;
    }
    if (typeof assertion !== 'object' || assertion === null || Array.isArray(assertion)) return unchanged;
    const minted = await mintDeviceKey(this.#crypto);
    // BEFORE it is sent, and the whole of the recovery rests on this line.
    await this.#store.savePending(daemon.daemonId, minted.privateKey);
    const rotation = await session.signRotation(
      daemon.deviceId,
      this.#crypto.deviceKeyHandle(minted.privateKey),
      minted.publicKey,
    );
    return { init: { ...init, body: JSON.stringify({ ...assertion, rotation }) }, rotated: true };
  }

  /** Reads the daemon's answer to a step-up that carried a rotation, and settles the pending key. */
  async settle(daemonId: string, response: Response): Promise<void> {
    if (response.ok && (await grantedRotation(response))) await this.#store.promotePending(daemonId);
    else await this.#store.discardPending(daemonId);
  }

  /** The pending key as a handle to sign a session with, or nothing when no rotation is in flight. */
  async pending(daemonId: string): Promise<PrivateKeyHandle | undefined> {
    const key = await this.#store.loadPending(daemonId);
    return key === undefined ? undefined : this.#crypto.deviceKeyHandle(key);
  }

  /** The old key was refused and the pending one opened a session: it is the key now. */
  async promote(daemonId: string): Promise<void> {
    await this.#store.promotePending(daemonId);
  }

  /** The pending key was refused too: the daemon never swapped, so it is only clutter. */
  async discard(daemonId: string): Promise<void> {
    await this.#store.discardPending(daemonId);
  }

  #due(rotateBy: string | undefined): boolean {
    if (rotateBy === undefined) return false;
    const at = Date.parse(rotateBy);
    return !Number.isNaN(at) && at <= this.#now();
  }
}

/** Whether a granted step-up says the daemon swapped the key. Read from a copy; the body stays. */
const grantedRotation = async (response: Response): Promise<boolean> => {
  try {
    const parsed = StepUpGrantedSchema.safeParse(await response.clone().json());
    return parsed.success && parsed.data.keyRotated === true;
  } catch {
    return false;
  }
};
