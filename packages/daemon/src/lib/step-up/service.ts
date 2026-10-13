import {
  MAX_PASSKEYS_PER_DEVICE,
  PASSKEY_ALGORITHMS,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  PASSKEY_REGISTRATION_WINDOW_SECONDS,
  type PasskeyRegistration,
  type PasskeyRegistrationOptions,
  type PasskeysView,
  type PasskeyView,
  type PresenceGranted,
  type SecuritySettings,
  type PasskeyWindowOpened,
  type StepUpAssertion,
  type StepUpGranted,
  type StepUpOptions,
  type StepUpRefusal,
} from '@ferretry/protocol';
import { fromBase64Url, toBase64Url } from '@ferretry/relay';
import { secretsMatch } from '../api/authentication.ts';
import type { GrantAuditPort } from '../grants/types.ts';
import { type PasskeyCrypto, verifyAssertion, verifyRegistration } from '../passkeys/index.ts';
import type { ChallengeLedger, StepUpRegistry, StepUpSubject } from './registry.ts';
import type {
  DeviceKeyRotationPort,
  PasskeyStore,
  PasskeyVerifierPort,
  StepUpCaller,
  StepUpClock,
  StepUpDeviceDirectory,
  StepUpRandom,
  StoredPasskey,
} from './types.ts';

/** A ceremony's answer: the value, or the one refusal that names the person's next step. */
export type StepUpOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: StepUpRefusal };

export interface StepUpServiceDeps {
  readonly store: PasskeyStore;
  readonly verifier: PasskeyVerifierPort;
  readonly registry: StepUpRegistry;
  readonly challenges: ChallengeLedger;
  readonly random: StepUpRandom;
  readonly clock: StepUpClock;
  readonly devices: StepUpDeviceDirectory;
  /** The app origins this daemon serves (`corsOrigins`), read per call so a config change applies. */
  readonly allowedOrigins: () => readonly string[];
  /** What the authenticator shows as the relying party's name. */
  readonly relyingPartyName: string;
  /**
   * The machine's security settings in force (`docs/design/zero-trust.md` B6), read at every question.
   * Absent means nobody is asked for presence on opening and no key is ever due for rotation.
   */
  readonly settings?: () => SecuritySettings;
  /** Replacing a device's key inside a step-up. Absent means no rotation is ever asked for. */
  readonly rotation?: DeviceKeyRotationPort;
  /** Where the owner re-opening a registration window is written down. */
  readonly audit: Pick<GrantAuditPort, 'record'>;
}

const CHALLENGE_BYTES = 32;
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const refuse = (refusal: StepUpRefusal): { readonly ok: false; readonly refusal: StepUpRefusal } => ({
  ok: false,
  refusal,
});
const instant = (ms: number): string => new Date(ms).toISOString();

/**
 * A relying-party id is the app origin's host — WebAuthn's own default — which is why a passkey made
 * at one copy of the app cannot be used at another (`docs/design/zero-trust.md` B2).
 */
export const relyingPartyIdFor = (origin: string): string => new URL(origin).hostname;

/**
 * THE PASSKEY STEP-UP, VERIFIED BY THE DAEMON (`docs/design/zero-trust.md` B2).
 *
 * The browser performs the ceremony; this decides whether it counts. Nothing it returns or reports
 * carries a challenge, a signature or a key — refusals are one closed set, and the verifier's own
 * finer reason is deliberately collapsed into `not-verified`, because "which check failed" helps an
 * attacker tune a forgery and helps nobody else.
 *
 * WHO MAY ADD A PASSKEY is the rule that keeps a thief holding an unlocked app from adding their own:
 * a copy of the app holding a current step-up, a device with none yet inside the ten minutes after it
 * was paired — the moment its owner is holding it — or a device whose window the OWNER re-opened at the
 * machine. A browser is never the owner, wherever it runs (B4), so that last path is the recovery: a
 * device that missed its first window or lost its authenticator is not locked out.
 */
export class StepUpService {
  /**
   * When each DEVICE last confirmed a person on opening (`presenceOnOpen`). Per device rather than per
   * copy of the app, so it holds across page loads; in memory, so a restart asks again.
   */
  readonly #present = new Map<string, number>();
  /** Registration windows the owner re-opened, by device: when each closes. Spent by one passkey. */
  readonly #reopened = new Map<string, number>();

  constructor(private readonly deps: StepUpServiceDeps) {}

  /**
   * Whether this device must confirm a person is present before it is served at all: the machine asks
   * for it on opening and the device's last confirmation is older than the validity period in force.
   */
  presenceRequired(subject: StepUpSubject): boolean {
    const settings = this.deps.settings?.();
    if (settings?.presenceOnOpen !== true) return false;
    return this.#presentUntil(subject.deviceId, settings) <= this.deps.clock.nowMs();
  }

  /** When a key opened by this device is due for replacement, or nothing when no rotation is asked for. */
  rotateBy(deviceId: string): number | undefined {
    const days = this.deps.settings?.().deviceKeyRotationDays;
    const issuedAt = this.deps.rotation?.keyIssuedAt(deviceId);
    if (days === undefined || issuedAt === undefined) return undefined;
    return issuedAt + days * DAY_MS;
  }

  /**
   * The owner, at the machine, re-opens the registration window for one paired device. Ten minutes,
   * one passkey, audited. Nobody else may: a browser on this host is an ordinary device.
   */
  async reopenRegistration(caller: StepUpCaller, deviceId: string): Promise<StepUpOutcome<PasskeyWindowOpened>> {
    if (!caller.hostLocal) return refuse('not-at-machine');
    const record = await this.deps.devices.device(deviceId);
    if (record === undefined) return refuse('unknown-device');
    const now = this.deps.clock.nowMs();
    const closesAtMs = now + PASSKEY_REGISTRATION_WINDOW_SECONDS * 1_000;
    this.#reopened.set(deviceId, closesAtMs);
    await this.deps.audit.record({
      actor: caller.actor ?? 'unknown',
      changes: [`passkey.registration-window=${deviceId}`],
      at: instant(now),
    });
    return { ok: true, value: { deviceId, deviceName: record.name, closesAt: instant(closesAtMs) } };
  }

  /** Whether this copy of the app holds a current step-up. The authorization boundary's one question. */
  held(subject: StepUpSubject): boolean {
    return this.deps.registry.held(subject, this.deps.clock.nowMs());
  }

  /** One act this copy's step-up admitted. Spends it when the machine asks every time. */
  spend(subject: StepUpSubject): void {
    this.deps.registry.spend(subject);
  }

  /** What this device holds and may do, for the Security panel and the prompt. */
  async view(caller: StepUpCaller): Promise<StepUpOutcome<PasskeysView>> {
    const device = caller.device;
    if (device === undefined) return refuse('not-a-device');
    const now = this.deps.clock.nowMs();
    const passkeys = await this.deps.store.list(device.deviceId);
    const registration = await this.#registration(device, passkeys, now);
    const stepUpUntil = this.deps.registry.expiresAt(device, now);
    return {
      ok: true,
      value: {
        passkeys: passkeys.map(passkeyView),
        registration: registration.kind,
        ...(registration.closesAtMs === undefined ? {} : { registrationClosesAt: instant(registration.closesAtMs) }),
        ...(stepUpUntil === undefined ? {} : { stepUpUntil: instant(stepUpUntil) }),
      },
    };
  }

  async registrationOptions(caller: StepUpCaller, origin: string): Promise<StepUpOutcome<PasskeyRegistrationOptions>> {
    const device = caller.device;
    if (device === undefined) return refuse('not-a-device');
    if (!this.deps.allowedOrigins().includes(origin)) return refuse('origin-not-allowed');
    const now = this.deps.clock.nowMs();
    const passkeys = await this.deps.store.list(device.deviceId);
    const registration = await this.#registration(device, passkeys, now);
    if (registration.kind === 'closed') return refuse('registration-closed');
    if (passkeys.length >= MAX_PASSKEYS_PER_DEVICE) return refuse('too-many-passkeys');
    const record = await this.deps.devices.device(device.deviceId);
    if (record === undefined) return refuse('not-a-device');
    const challenge = this.deps.random.bytes(CHALLENGE_BYTES);
    this.deps.challenges.issue(device, 'register', challenge, now);
    return {
      ok: true,
      value: {
        challenge: toBase64Url(challenge),
        rp: { id: relyingPartyIdFor(origin), name: this.deps.relyingPartyName },
        // The device id names the account a passkey belongs to: one device, one user handle, so a
        // second passkey on the same authenticator replaces nothing it should not.
        user: {
          id: toBase64Url(new TextEncoder().encode(device.deviceId)),
          name: record.name,
          displayName: record.name,
        },
        pubKeyCredParams: PASSKEY_ALGORITHMS.map(alg => ({ type: 'public-key' as const, alg })),
        timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
        excludeCredentials: passkeys.map(passkey => ({ type: 'public-key' as const, id: passkey.credentialId })),
      },
    };
  }

  async register(caller: StepUpCaller, registration: PasskeyRegistration): Promise<StepUpOutcome<PasskeyView>> {
    const device = caller.device;
    if (device === undefined) return refuse('not-a-device');
    const now = this.deps.clock.nowMs();
    // Spent FIRST, whatever happens next: a challenge is answered once, so a refused attempt cannot be
    // retried against the same one.
    const challenge = this.deps.challenges.take(device, 'register', now);
    const passkeys = await this.deps.store.list(device.deviceId);
    // Asked again rather than trusted from the options call: the window can close in between.
    if ((await this.#registration(device, passkeys, now)).kind === 'closed')
      return refuse('registration-closed');
    if (passkeys.length >= MAX_PASSKEYS_PER_DEVICE) return refuse('too-many-passkeys');
    if (challenge === undefined) return refuse('not-verified');
    const clientDataJSON = fromBase64Url(registration.clientDataJSON);
    const attestationObject = fromBase64Url(registration.attestationObject);
    if (clientDataJSON === null || attestationObject === null) return refuse('not-verified');
    const verdict = await this.deps.verifier.verifyRegistration({
      clientDataJSON,
      attestationObject,
      expectedChallenge: challenge,
      allowedOrigins: this.deps.allowedOrigins(),
    });
    if (!verdict.ok) return refuse('not-verified');
    const credentialId = toBase64Url(verdict.credentialId);
    // The id the browser reported must be the one the authenticator attested, and must be new here.
    if (credentialId !== registration.credentialId) return refuse('not-verified');
    if (passkeys.some(passkey => passkey.credentialId === credentialId)) return refuse('not-verified');
    const stored: StoredPasskey = {
      credentialId,
      deviceId: device.deviceId,
      algorithm: verdict.algorithm,
      publicKeySpki: toBase64Url(verdict.publicKeySpki),
      signCount: verdict.signCount,
      origin: verdict.origin,
      createdAt: instant(now),
    };
    await this.deps.store.add(stored);
    // A re-opened window admits ONE passkey: the owner opened it for a recovery, not for a session.
    this.#reopened.delete(device.deviceId);
    // The authenticator just verified the person against a fresh challenge from this daemon, which is
    // exactly what a step-up is — so asking again for the act they registered for would be theatre.
    this.deps.registry.grant(device, now);
    // A confirmation on opening for the same reason: the first passkey is how a device on a machine
    // that asks for one gets in at all.
    this.#present.set(device.deviceId, now);
    return { ok: true, value: passkeyView(stored) };
  }

  async stepUpOptions(caller: StepUpCaller, origin: string): Promise<StepUpOutcome<StepUpOptions>> {
    return await this.#assertionOptions(caller, origin, 'step-up');
  }

  /** Options for a confirmation on opening: the same ceremony, its own challenge. */
  async presenceOptions(caller: StepUpCaller, origin: string): Promise<StepUpOutcome<StepUpOptions>> {
    return await this.#assertionOptions(caller, origin, 'presence');
  }

  /**
   * A confirmation on opening (`presenceOnOpen`). Good for the validity period for the whole DEVICE,
   * and NEVER a step-up: the acts that need one still ask for their own.
   */
  async presence(caller: StepUpCaller, assertion: StepUpAssertion): Promise<StepUpOutcome<PresenceGranted>> {
    const device = caller.device;
    if (device === undefined) return refuse('not-a-device');
    // A key is replaced only inside a step-up, where the browser knows to send one; a rotation here is
    // a client that has confused the two ceremonies.
    if (assertion.rotation !== undefined) return refuse('not-verified');
    const now = this.deps.clock.nowMs();
    const verified = await this.#verify(device, 'presence', assertion, now);
    if (!verified.ok) return verified;
    this.#present.set(device.deviceId, now);
    const settings = this.deps.settings?.();
    return {
      ok: true,
      value: { presentUntil: instant(settings === undefined ? now : this.#presentUntil(device.deviceId, settings)) },
    };
  }

  async #assertionOptions(
    caller: StepUpCaller,
    origin: string,
    purpose: 'step-up' | 'presence',
  ): Promise<StepUpOutcome<StepUpOptions>> {
    const device = caller.device;
    if (device === undefined) return refuse('not-a-device');
    if (!this.deps.allowedOrigins().includes(origin)) return refuse('origin-not-allowed');
    // A passkey answers only at the origin it was made at, so offering the others would be offering
    // the browser credentials it will refuse to use.
    const usable = (await this.deps.store.list(device.deviceId)).filter(passkey => passkey.origin === origin);
    if (usable.length === 0) return refuse('no-passkey');
    const now = this.deps.clock.nowMs();
    const challenge = this.deps.random.bytes(CHALLENGE_BYTES);
    this.deps.challenges.issue(device, purpose, challenge, now);
    return {
      ok: true,
      value: {
        challenge: toBase64Url(challenge),
        rpId: relyingPartyIdFor(origin),
        allowCredentials: usable.map(passkey => ({ type: 'public-key' as const, id: passkey.credentialId })),
        timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
      },
    };
  }

  /**
   * A step-up — and, once the device's key is due for replacement, the replacement too.
   *
   * AN OVERDUE DEVICE MUST ROTATE TO STEP UP (`docs/design/zero-trust.md` B6): the assertion is refused
   * as `rotation-required` unless it carries the new key, so nothing that needs a step-up can be done
   * on a key past its period, while reads that need none keep working. The challenge is NOT spent by
   * that refusal — the browser answers it again with a rotation, without a second passkey sheet.
   *
   * THE NEW KEY'S PROOF IS CHECKED AGAINST THIS SESSION'S TRANSCRIPT, a session the OLD key opened, so
   * a replacement made for one session can never be presented in another, and the person's passkey
   * vouches for the swap in the same ceremony. The swap happens only after the assertion verifies.
   */
  async stepUp(caller: StepUpCaller, assertion: StepUpAssertion): Promise<StepUpOutcome<StepUpGranted>> {
    const device = caller.device;
    if (device === undefined) return refuse('not-a-device');
    const now = this.deps.clock.nowMs();
    const rotateBy = this.rotateBy(device.deviceId);
    const due = rotateBy !== undefined && rotateBy <= now;
    if (due && assertion.rotation === undefined) return refuse('rotation-required');
    const rotation = assertion.rotation;
    // Checked BEFORE the assertion spends the challenge: a forged or mismatched rotation must not cost
    // the person their confirmation, and must never reach the swap.
    if (rotation !== undefined) {
      const rotator = this.deps.rotation;
      const transcriptHash = caller.transcriptHash;
      if (
        rotator === undefined ||
        transcriptHash === undefined ||
        !(await rotator.verify({ transcriptHash, deviceId: device.deviceId, ...rotation }))
      )
        return refuse('not-verified');
    }
    const verified = await this.#verify(device, 'step-up', assertion, now);
    if (!verified.ok) return verified;
    let rotated = false;
    if (rotation !== undefined && this.deps.rotation !== undefined && caller.transcriptHash !== undefined) {
      rotated = await this.deps.rotation.rotate({
        deviceId: device.deviceId,
        deviceKey: rotation.deviceKey,
        transcriptHash: caller.transcriptHash,
      });
      // The device was revoked between the assertion and the swap: nothing to step up any more.
      if (!rotated) return refuse('not-a-device');
    }
    const expiresAt = instant(this.deps.registry.grant(device, now));
    return { ok: true, value: rotated ? { expiresAt, keyRotated: true } : { expiresAt } };
  }

  /**
   * One assertion against the outstanding challenge for `purpose`, verified by the WebAuthn verifier and
   * its counter recorded. The challenge is spent whatever the answer.
   */
  async #verify(
    device: StepUpSubject,
    purpose: 'step-up' | 'presence',
    assertion: StepUpAssertion,
    now: number,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly refusal: StepUpRefusal }> {
    const challenge = this.deps.challenges.take(device, purpose, now);
    if (challenge === undefined) return refuse('not-verified');
    const passkeys = await this.deps.store.list(device.deviceId);
    const credential = passkeys.find(passkey => secretsMatch(passkey.credentialId, assertion.credentialId));
    if (credential === undefined) return refuse('not-verified');
    const clientDataJSON = fromBase64Url(assertion.clientDataJSON);
    const authenticatorData = fromBase64Url(assertion.authenticatorData);
    const signature = fromBase64Url(assertion.signature);
    const publicKeySpki = fromBase64Url(credential.publicKeySpki);
    if (clientDataJSON === null || authenticatorData === null || signature === null || publicKeySpki === null)
      return refuse('not-verified');
    const verdict = await this.deps.verifier.verifyAssertion({
      clientDataJSON,
      authenticatorData,
      signature,
      expectedChallenge: challenge,
      // Only the origin this passkey was made at: an assertion relayed through another allowed copy of
      // the app is a different relying party and is refused by the rpId check anyway.
      allowedOrigins: this.deps.allowedOrigins().filter(origin => origin === credential.origin),
      credential: { algorithm: credential.algorithm, publicKeySpki, signCount: credential.signCount },
    });
    if (!verdict.ok) return refuse('not-verified');
    await this.deps.store.updateSignCount(device.deviceId, credential.credentialId, verdict.signCount);
    return { ok: true };
  }

  #presentUntil(deviceId: string, settings: SecuritySettings): number {
    const at = this.#present.get(deviceId);
    return at === undefined ? 0 : at + settings.presenceValidityHours * HOUR_MS;
  }

  /** Revoking a device forgets its passkeys, its step-ups, its presence and its outstanding challenges. */
  async forgetDevice(deviceId: string): Promise<void> {
    this.#reopened.delete(deviceId);
    this.deps.registry.forgetDevice(deviceId);
    this.#present.delete(deviceId);
    this.deps.challenges.forgetDevice(deviceId);
    await this.deps.store.forgetDevice(deviceId);
  }

  async #registration(
    device: StepUpSubject,
    passkeys: readonly StoredPasskey[],
    nowMs: number,
  ): Promise<{ readonly kind: PasskeysView['registration']; readonly closesAtMs?: number }> {
    if (this.deps.registry.held(device, nowMs)) return { kind: 'stepped-up' };
    const reopened = this.#reopened.get(device.deviceId);
    if (reopened !== undefined && reopened > nowMs) return { kind: 'reopened', closesAtMs: reopened };
    if (reopened !== undefined) this.#reopened.delete(device.deviceId);
    if (passkeys.length > 0) return { kind: 'closed' };
    const record = await this.deps.devices.device(device.deviceId);
    if (record === undefined) return { kind: 'closed' };
    const closesAtMs = Date.parse(record.createdAt) + PASSKEY_REGISTRATION_WINDOW_SECONDS * 1_000;
    return closesAtMs > nowMs ? { kind: 'first-window', closesAtMs } : { kind: 'closed' };
  }
}

const passkeyView = (passkey: StoredPasskey): PasskeyView => ({
  id: passkey.credentialId,
  origin: passkey.origin,
  createdAt: passkey.createdAt,
});

/**
 * The WebAuthn verifier (`../passkeys`) as the step-up service consumes it, bound to one crypto port.
 *
 * Its verdict passes through whole; the service collapses every refusal reason into `not-verified`
 * before anything leaves this daemon.
 */
export const passkeyVerifier = (crypto: PasskeyCrypto): PasskeyVerifierPort => ({
  verifyRegistration: async input => await verifyRegistration(crypto, input),
  verifyAssertion: async input => await verifyAssertion(crypto, input),
});
