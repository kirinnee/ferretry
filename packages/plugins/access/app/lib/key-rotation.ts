/**
 * THE BROWSER'S HALF OF DEVICE-KEY ROTATION (`docs/design/zero-trust.md` B6).
 *
 * The daemon says when a device's key is due (`rotateBy`, on the record that accepted the session).
 * Once it has passed, the next passkey ceremony — the unlock that opens the app, or a step-up — must
 * carry a replacement key and that key's proof over the
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
 *
 * In 5.0 it is the ONE implementation behind the session layer's `SessionKeyRotation` port (`@ferretry/app`), which
 * Access provides beside its device claims: the shell's session transport applies it to `POST /v1/unlock` and
 * `POST /v1/step-up` on the session carrying them, settles it on the answer, and tries the pending key once on a
 * refused session. The request and the answer are the transport's (a JSON value, a status), not `fetch`'s.
 */

import type { AmendedRotation, RotatingSession, RotationRequest, SessionKeyRotation } from '@ferretry/app';
import { UnlockGrantedSchema } from '@ferretry/core-gate/contract';
import { StepUpGrantedSchema } from '../../contract/index.ts';
import type { PrivateKeyHandle } from '../shell-pairing.ts';
import { type DeviceKeyGenerator, type DeviceKeyStore, mintDeviceKey } from './device-keys.ts';

/** The routes a rotation rides: the two passkey ceremonies, because the daemon's refusal and acceptance are there. */
const ROTATING_PATHS: readonly string[] = ['/v1/step-up', '/v1/unlock'];

/** What a session must offer: when it was told to rotate, and a proof only it can make (the session layer's). */
export type { RotatingSession };

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

/** The body a ceremony wrote: the JSON object (or its text), or `undefined` for anything else. */
const assertionOf = (body: unknown): Readonly<Record<string, unknown>> | undefined => {
  let value: unknown = body;
  if (typeof body === 'string') {
    try {
      value = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
};

export class KeyRotation implements SessionKeyRotation {
  readonly #store: DeviceKeyStore;
  readonly #crypto: KeyRotationCrypto;
  readonly #now: () => number;

  constructor(deps: KeyRotationDependencies) {
    this.#store = deps.store;
    this.#crypto = deps.crypto;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Adds the replacement to an unlock or step-up request, when this is one and the session says it is due.
   *
   * Anything else is returned untouched — another route, a body that is not the JSON object the
   * ceremony wrote, a session that asked for nothing, a `rotateBy` still in the future. An
   * unreadable instant counts as not due: the daemon is the judge, and it will refuse a step-up that
   * needed a rotation in words that say so.
   */
  async amend<Request extends RotationRequest>(
    session: RotatingSession,
    daemon: { readonly daemonId: string; readonly deviceId: string },
    request: Request,
  ): Promise<AmendedRotation<Request>> {
    const unchanged = { request, rotated: false };
    if (request.method.toUpperCase() !== 'POST' || !ROTATING_PATHS.includes(request.path)) return unchanged;
    if (!this.#due(session.rotateBy())) return unchanged;
    const assertion = assertionOf(request.body);
    if (assertion === undefined) return unchanged;
    const minted = await mintDeviceKey(this.#crypto);
    // BEFORE it is sent, and the whole of the recovery rests on this line.
    await this.#store.savePending(daemon.daemonId, minted.privateKey);
    const rotation = await session.signRotation(
      daemon.deviceId,
      this.#crypto.deviceKeyHandle(minted.privateKey),
      minted.publicKey,
    );
    return { request: { ...request, body: { ...assertion, rotation } }, rotated: true };
  }

  /** Reads the daemon's answer to an unlock or step-up that carried a rotation, and settles the pending key. */
  async settle(daemonId: string, answer: Parameters<SessionKeyRotation['settle']>[1]): Promise<void> {
    const ok = answer.status >= 200 && answer.status < 300;
    if (ok && grantedRotation(answer.body)) await this.#store.promotePending(daemonId);
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

/** Whether a granted unlock or step-up says the daemon swapped the key. */
const grantedRotation = (body: unknown): boolean => {
  const parsed = StepUpGrantedSchema.safeParse(body);
  if (parsed.success) return parsed.data.keyRotated === true;
  const unlocked = UnlockGrantedSchema.safeParse(body);
  return unlocked.success && unlocked.data.keyRotated === true;
};
