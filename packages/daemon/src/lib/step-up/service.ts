import {
  asksStepUpPerAction,
  MAX_PASSKEYS_PER_DEVICE,
  PASSKEY_ALGORITHMS,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  PASSKEY_REGISTRATION_WINDOW_SECONDS,
  type PasskeyRegistration,
  type PasskeyRegistrationOptions,
  type PasskeysView,
  type PasskeyView,
  type PasskeyWindowOpened,
  type PushNotificationPayload,
  PushNotificationPayloadSchema,
  SECURITY_SETTING_BOUNDS,
  type SecuritySettings,
  type EveryCallerStepUpAct,
  type MachineSkippableStepUpAct,
  type StepUpAct,
  stepUpSkippableAtMachine,
  type StepUpAssertion,
  type StepUpGranted,
  type StepUpOptions,
  type StepUpRefusal,
  type UnlockGranted,
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
  UnlockLedgerPort,
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
   * This machine's name as a paired device knows it — the pairing state's `daemonName`, never a second
   * reading of the hostname — so a phone's passkeys for two machines read differently in its password
   * manager.
   */
  readonly machineName: string;
  /**
   * The machine's security settings in force (`docs/design/zero-trust.md` B6), read at every question.
   * Absent means nobody is asked to unlock on opening and no key is ever due for rotation.
   */
  readonly settings?: () => SecuritySettings;
  /** Replacing a device's key inside a passkey ceremony. Absent means no rotation is ever asked for. */
  readonly rotation?: DeviceKeyRotationPort;
  /**
   * Where the owner re-opening a registration window, an added passkey and a refused counter are written
   * down — the grant journal, until the audit log lands.
   */
  readonly audit: Pick<GrantAuditPort, 'record'>;
  /**
   * Tells the owner's other devices a passkey was added. Best effort: a notice that cannot be delivered
   * never undoes the registration, which the journal has already recorded.
   */
  readonly announce?: (notice: PushNotificationPayload) => Promise<unknown>;
  /**
   * Where each device's unlock is kept so a restart — an update — does not ask again inside its period.
   * Absent keeps unlocks in memory only, and a restart asks every device again.
   */
  readonly unlocks?: UnlockLedgerPort;
}

const CHALLENGE_BYTES = 32;
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
/** The longest an unlock can be valid under any setting: an older one is dropped rather than kept. */
const LONGEST_UNLOCK_MS = SECURITY_SETTING_BOUNDS.unlockValidityHours.max * HOUR_MS;
const refuse = (refusal: StepUpRefusal): { readonly ok: false; readonly refusal: StepUpRefusal } => ({
  ok: false,
  refusal,
});
const instant = (ms: number): string => new Date(ms).toISOString();

/**
 * The most a passkey's account name may take, in UTF-8 bytes: WebAuthn lets an authenticator truncate
 * `user.name` and `user.displayName` to 64 bytes, so the name is bounded here, where it can end cleanly.
 */
const PASSKEY_ACCOUNT_NAME_MAX_BYTES = 64;
/** What the device part always keeps, so a long machine name never squeezes it out entirely. */
const DEVICE_PART_MIN_BYTES = 12;
const ARROW = ' → ';
const ELLIPSIS = '…';
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** `text` within `maxBytes`, cut at a code point and ended with an ellipsis when anything was dropped. */
function fitBytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  let kept = '';
  for (const symbol of text) {
    if (utf8Bytes(kept + symbol + ELLIPSIS) > maxBytes) break;
    kept += symbol;
  }
  return kept + ELLIPSIS;
}

/**
 * "‹device› → ‹machine›" within `maxBytes`. The machine is the part that tells two passkeys on one
 * phone apart, so it is kept whole wherever it fits and the device name gives way first.
 */
function passkeyAccountName(device: string, machine: string, maxBytes: number): string {
  const room = maxBytes - utf8Bytes(ARROW);
  const machinePart = fitBytes(machine, room - DEVICE_PART_MIN_BYTES);
  return `${fitBytes(device, room - utf8Bytes(machinePart))}${ARROW}${machinePart}`;
}

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
 * WHO MAY ADD A PASSKEY is the rule that keeps a thief holding an unlocked app — or code in the page —
 * from adding their own: a device with none yet inside the ten minutes after it was paired (the moment
 * its owner is holding it); a device whose window the OWNER re-opened at the machine; or a device that
 * proves, in the same ceremony, a passkey it already holds. A browser is never the owner, wherever it
 * runs (B4), so the re-opened window is the recovery for a device that missed its first window or lost
 * its authenticator.
 *
 * HOLDING A STEP-UP ADDS NOTHING, and a registration GRANTS nothing. With attestation `none` nothing in
 * a registration proves an authenticator exists — page code can build one with WebCrypto, flags and all —
 * so a registration authorized by a held step-up let page code mint a passkey and step up with it later
 * without the owner. What page code cannot build is a signature by a passkey this daemon already holds,
 * over a challenge issued for THIS registration; that is the binding.
 */
export class StepUpService {
  /**
   * When each DEVICE last confirmed a person on opening (`unlockOnOpen`). Per device rather than per
   * copy of the app, so it holds across page loads; written to {@link StepUpServiceDeps.unlocks} and
   * read back by {@link restore}, so it holds across a restart too.
   */
  readonly #unlockedAt = new Map<string, number>();
  /** Serializes the unlock ledger's writes, so an older map can never land after a newer one. */
  #persisting: Promise<unknown> = Promise.resolve();
  /** Registration windows the owner re-opened, by device: when each closes. Spent by one passkey. */
  readonly #reopened = new Map<string, number>();

  constructor(private readonly deps: StepUpServiceDeps) {}

  /**
   * Reads back the unlocks a previous run of this daemon granted, before anything is served. Kept: a
   * device that is still paired, unlocked no later than now and within the longest period any setting
   * allows; whether it is still unlocked is then asked of the settings in force, as for any unlock.
   *
   * Returns a sentence for the boot trail when the ledger could not be read. A damaged ledger is never
   * thrown: every device is asked to unlock again, which is how a machine without one behaved.
   */
  async restore(): Promise<string | undefined> {
    const ledger = this.deps.unlocks;
    if (ledger === undefined) return undefined;
    let stored: ReadonlyMap<string, number>;
    try {
      stored = await ledger.read();
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return `the unlock ledger could not be read (${cause}), so every device is asked to unlock again`;
    }
    const now = this.deps.clock.nowMs();
    for (const [deviceId, at] of stored) {
      if (at > now || now - at >= LONGEST_UNLOCK_MS) continue;
      if ((await this.deps.devices.device(deviceId)) === undefined) continue;
      this.#unlockedAt.set(deviceId, at);
    }
    return undefined;
  }

  /**
   * Whether this device must confirm a person is present before it is served at all: the machine asks
   * for it on opening and the device's last confirmation is older than the validity period in force.
   */
  unlockRequired(subject: StepUpSubject): boolean {
    const settings = this.deps.settings?.();
    if (settings?.unlockOnOpen !== true) return false;
    return this.#unlockedUntil(subject.deviceId, settings) <= this.deps.clock.nowMs();
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

  /**
   * Whether this copy of the app may do an act that needs a step-up. The authorization boundary's one
   * question.
   *
   * THE UNLOCK IS THE STEP-UP (owner decision 2026-10-14, `docs/design/zero-trust.md` B6): on a machine
   * that unlocks on opening and does not ask again per act, a device holding a current unlock may do
   * every act its grants allow, with no further prompt. Otherwise — the owner asked per act too, or
   * there is no unlock — a per-act step-up for this copy of the app is what counts.
   */
  held(subject: StepUpSubject): boolean {
    const now = this.deps.clock.nowMs();
    const settings = this.deps.settings?.();
    if (
      settings !== undefined &&
      !asksStepUpPerAction(settings) &&
      this.#unlockedUntil(subject.deviceId, settings) > now
    )
      return true;
    return this.deps.registry.held(subject, now);
  }

  /**
   * Whether this copy may do an act that ADDS ACCESS — mint a pairing code, widen a device — which needs
   * a passkey proved for it (owner decision 2026-10-14, `docs/design/zero-trust.md` row 66). NOT the
   * unlock, and not a step-up merely inside its window, whatever `stepUpOnActions` says: the unlock
   * alone must never be enough to put another device on this machine.
   */
  freshlyHeld(subject: StepUpSubject): boolean {
    return this.deps.registry.freshlyHeld(subject, this.deps.clock.nowMs());
  }

  /** Takes the fresh proof for an act, atomically: of concurrent acts on one proof, one gets `true`. */
  claimFresh(subject: StepUpSubject, act?: MachineSkippableStepUpAct): boolean;
  /**
   * An act every caller must prove takes only a proof proved for it AND bound to `bound` (the staged save it is for):
   * there is no way to ask for one without naming what it is bound to.
   */
  claimFresh(subject: StepUpSubject, act: EveryCallerStepUpAct, bound: string): boolean;
  claimFresh(subject: StepUpSubject, act?: StepUpAct, bound?: string): boolean {
    const now = this.deps.clock.nowMs();
    if (act !== undefined && !stepUpSkippableAtMachine(act))
      return bound !== undefined && this.deps.registry.claimFresh(subject, now, act, bound);
    return this.deps.registry.claimFresh(subject, now, act as MachineSkippableStepUpAct | undefined);
  }

  /** Spends the fresh proof an act that adds access was admitted on. */
  spendFresh(subject: StepUpSubject): void {
    this.deps.registry.spendFresh(subject);
  }

  /**
   * One act this copy's step-up admitted. Spends a single-use per-act step-up; an unlock is never
   * spent by an act — it is good for its whole validity.
   */
  spend(subject: StepUpSubject): void {
    const settings = this.deps.settings?.();
    if (settings !== undefined && !asksStepUpPerAction(settings)) return;
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
    // The passkeys that can answer here: a passkey asserts only at the origin it was made at.
    const usable = passkeys.filter(passkey => passkey.origin === origin);
    if (registration.kind === 'confirm-existing' && usable.length === 0) return refuse('no-passkey');
    const challenge = this.deps.random.bytes(CHALLENGE_BYTES);
    this.deps.challenges.issue(device, 'register', challenge, now);
    const prefix = `${this.deps.relyingPartyName}: `;
    const confirm =
      registration.kind === 'confirm-existing'
        ? this.#confirmOptions(device, origin, usable, challenge, now)
        : undefined;
    return {
      ok: true,
      value: {
        challenge: toBase64Url(challenge),
        rp: { id: relyingPartyIdFor(origin), name: this.deps.relyingPartyName },
        // The device id names the account a passkey belongs to: one device, one user handle, so a
        // second passkey on the same authenticator replaces nothing it should not. The names are only
        // what a password manager shows — "Ferretry: iPhone → studio" — and a passkey keeps the name it
        // was made with.
        user: {
          id: toBase64Url(new TextEncoder().encode(device.deviceId)),
          name: passkeyAccountName(record.name, this.deps.machineName, PASSKEY_ACCOUNT_NAME_MAX_BYTES),
          displayName: `${prefix}${passkeyAccountName(record.name, this.deps.machineName, PASSKEY_ACCOUNT_NAME_MAX_BYTES - utf8Bytes(prefix))}`,
        },
        pubKeyCredParams: PASSKEY_ALGORITHMS.map(alg => ({ type: 'public-key' as const, alg })),
        timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
        excludeCredentials: passkeys.map(passkey => ({ type: 'public-key' as const, id: passkey.credentialId })),
        ...(confirm === undefined ? {} : { confirm }),
      },
    };
  }

  async register(caller: StepUpCaller, registration: PasskeyRegistration): Promise<StepUpOutcome<PasskeyView>> {
    const device = caller.device;
    if (device === undefined) return refuse('not-a-device');
    const now = this.deps.clock.nowMs();
    // Spent FIRST, whatever happens next: a challenge is answered once, so a refused attempt cannot be
    // retried against the same one.
    // Both are spent, and the confirmation only pairs with the registration challenge it was issued with.
    const challenge = this.deps.challenges.take(device, 'register', now);
    const confirmChallenge = this.deps.challenges.takeConfirmation(device, challenge ?? new Uint8Array(0), now);
    const passkeys = await this.deps.store.list(device.deviceId);
    // Asked again rather than trusted from the options call: the window can close in between.
    const kind = (await this.#registration(device, passkeys, now)).kind;
    if (kind === 'closed') return refuse('registration-closed');
    if (passkeys.length >= MAX_PASSKEYS_PER_DEVICE) return refuse('too-many-passkeys');
    if (challenge === undefined) return refuse('not-verified');
    // A device that already holds a passkey proves it first. Nothing else this caller holds — a session,
    // a step-up, a live tab — stands in for it.
    if (kind === 'confirm-existing') {
      if (registration.confirmation === undefined || confirmChallenge === undefined) return refuse('not-verified');
      const confirmed = await this.#verifyAssertion(device, passkeys, registration.confirmation, confirmChallenge, now);
      if (!confirmed) return refuse('not-verified');
    }
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
    // ANY device's, not only this one's: a credential is bound to the device that registered it, so one
    // already held elsewhere — a synced copy, or an id a device learned — is never re-registered here,
    // which would move another device's passkey out from under it.
    if ((await this.deps.store.holder(credentialId)) !== undefined) return refuse('not-verified');
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
    // NO STEP-UP AND NO UNLOCK ARE GRANTED. A registration proves nothing about the person (see the class
    // comment), so a device that has just added its first passkey unlocks with it next, like any other.
    await this.deps.audit.record({
      actor: caller.actor ?? `device:${device.deviceId}`,
      changes: [`passkey.added=${device.deviceId}`],
      at: instant(now),
    });
    const record = await this.deps.devices.device(device.deviceId);
    if (this.deps.announce !== undefined && record !== undefined)
      await this.deps.announce(passkeyAddedNotice(record.name)).catch(() => undefined);
    return { ok: true, value: passkeyView(stored) };
  }

  async stepUpOptions(
    caller: StepUpCaller,
    origin: string,
    act?: MachineSkippableStepUpAct,
  ): Promise<StepUpOutcome<StepUpOptions>>;
  /**
   * Options for an act every caller must prove: the challenge, and so the proof it buys, is bound to `bound` (the one
   * staged save it is for, `addTwoFactorKeySubject`), and the proof is spent only on that.
   */
  async stepUpOptions(
    caller: StepUpCaller,
    origin: string,
    act: EveryCallerStepUpAct,
    bound: string,
  ): Promise<StepUpOutcome<StepUpOptions>>;
  async stepUpOptions(
    caller: StepUpCaller,
    origin: string,
    act?: StepUpAct,
    bound?: string,
  ): Promise<StepUpOutcome<StepUpOptions>> {
    // Never a challenge for such an act without what it is bound to, nor a binding on any other act.
    if ((act !== undefined && !stepUpSkippableAtMachine(act)) !== (bound !== undefined && bound !== ''))
      return refuse('not-verified');
    return await this.#assertionOptions(caller, origin, 'step-up', act, bound);
  }

  /** Options for a confirmation on opening: the same ceremony, its own challenge. */
  async unlockOptions(caller: StepUpCaller, origin: string): Promise<StepUpOutcome<StepUpOptions>> {
    return await this.#assertionOptions(caller, origin, 'unlock');
  }

  /**
   * The UNLOCK (`unlockOnOpen`, owner decision 2026-10-14): one passkey assertion that opens this
   * machine to this DEVICE for the validity period, across page loads — and, unless the owner asked for
   * a confirmation per act as well, IS the step-up for every act inside it (see {@link held}).
   *
   * It is the passkey ceremony a device meets first, so an overdue key is replaced here exactly as in a
   * step-up ({@link #ceremony}). An unlock also grants a per-act step-up for this copy of the app, so a
   * machine that asks per act does not ask again for the first act right after unlocking.
   */
  async unlock(caller: StepUpCaller, assertion: StepUpAssertion): Promise<StepUpOutcome<UnlockGranted>> {
    const device = caller.device;
    if (device === undefined) return refuse('not-a-device');
    const now = this.deps.clock.nowMs();
    const done = await this.#ceremony(caller, device, 'unlock', assertion, now);
    if (!done.ok) return done;
    this.#unlockedAt.set(device.deviceId, now);
    await this.#persistUnlocks();
    this.deps.registry.grant(device, now, false);
    const settings = this.deps.settings?.();
    const unlockedUntil = instant(settings === undefined ? now : this.#unlockedUntil(device.deviceId, settings));
    return { ok: true, value: done.rotated ? { unlockedUntil, keyRotated: true } : { unlockedUntil } };
  }

  async #assertionOptions(
    caller: StepUpCaller,
    origin: string,
    purpose: 'step-up' | 'unlock',
    act?: StepUpAct,
    bound?: string,
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
    this.deps.challenges.issue(device, purpose, challenge, now, undefined, act, bound);
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
    const done = await this.#ceremony(caller, device, 'step-up', assertion, now);
    if (!done.ok) return done;
    // A proof for an act every caller must prove opens no step-up window and is not the fresh proof an act-less check
    // reads: it is kept bound to the one save its challenge named, and only that save can spend it.
    const act = done.act;
    if (act !== undefined && !stepUpSkippableAtMachine(act)) {
      if (done.bound === undefined) return refuse('not-verified');
      const until = instant(this.deps.registry.grantBound(device, now, act, done.bound));
      return { ok: true, value: done.rotated ? { expiresAt: until, keyRotated: true } : { expiresAt: until } };
    }
    const expiresAt = instant(this.deps.registry.grant(device, now, true, act));
    return { ok: true, value: done.rotated ? { expiresAt, keyRotated: true } : { expiresAt } };
  }

  /**
   * One verified passkey ceremony — and, once the device's key is due for replacement, the replacement.
   *
   * AN OVERDUE DEVICE MUST ROTATE TO FINISH IT (`docs/design/zero-trust.md` B6): the assertion is refused
   * as `rotation-required` unless it carries the new key. The challenge is NOT spent by that refusal, so
   * the browser answers it again with a rotation, without a second passkey sheet.
   *
   * THE NEW KEY'S PROOF IS CHECKED AGAINST THIS SESSION'S TRANSCRIPT, a session the OLD key opened, so a
   * replacement made for one session can never be presented in another, and the person's passkey
   * vouches for the swap in the same ceremony. The swap happens only after the assertion verifies.
   */
  async #ceremony(
    caller: StepUpCaller,
    device: StepUpSubject,
    purpose: 'step-up' | 'unlock',
    assertion: StepUpAssertion,
    now: number,
  ): Promise<
    | { readonly ok: true; readonly rotated: boolean; readonly act?: StepUpAct; readonly bound?: string }
    | { readonly ok: false; readonly refusal: StepUpRefusal }
  > {
    const rotateBy = this.rotateBy(device.deviceId);
    if (rotateBy !== undefined && rotateBy <= now && assertion.rotation === undefined)
      return refuse('rotation-required');
    const rotation = assertion.rotation;
    // Checked BEFORE the assertion spends the challenge: a forged or mismatched rotation must not cost
    // the person their confirmation, and must never reach the swap.
    const transcriptHash = caller.transcriptHash;
    if (rotation !== undefined) {
      const rotator = this.deps.rotation;
      if (
        rotator === undefined ||
        transcriptHash === undefined ||
        !(await rotator.verify({ transcriptHash, deviceId: device.deviceId, ...rotation }))
      )
        return refuse('not-verified');
    }
    const verified = await this.#verify(device, purpose, assertion, now);
    if (!verified.ok) return verified;
    const stamp = {
      ...(verified.act === undefined ? {} : { act: verified.act }),
      ...(verified.bound === undefined ? {} : { bound: verified.bound }),
    };
    if (rotation === undefined || this.deps.rotation === undefined || transcriptHash === undefined)
      return { ok: true, rotated: false, ...stamp };
    // The device was revoked between the assertion and the swap: nothing to step up any more.
    if (
      !(await this.deps.rotation.rotate({ deviceId: device.deviceId, deviceKey: rotation.deviceKey, transcriptHash }))
    )
      return refuse('not-a-device');
    return { ok: true, rotated: true, ...stamp };
  }

  /**
   * One assertion against the outstanding challenge for `purpose`, verified by the WebAuthn verifier and
   * its counter recorded. The challenge is spent whatever the answer.
   */
  async #verify(
    device: StepUpSubject,
    purpose: 'step-up' | 'unlock',
    assertion: StepUpAssertion,
    now: number,
  ): Promise<
    | { readonly ok: true; readonly act?: StepUpAct; readonly bound?: string }
    | { readonly ok: false; readonly refusal: StepUpRefusal }
  > {
    const issued = this.deps.challenges.takeWithAct(device, purpose, now);
    if (issued === undefined) return refuse('not-verified');
    const passkeys = await this.deps.store.list(device.deviceId);
    if (!(await this.#verifyAssertion(device, passkeys, assertion, issued.bytes, now))) return refuse('not-verified');
    return {
      ok: true,
      ...(issued.act === undefined ? {} : { act: issued.act }),
      ...(issued.bound === undefined ? {} : { bound: issued.bound }),
    };
  }

  /**
   * Writes the unlocks held now, dropping any no setting could still honour. A write that fails leaves
   * the unlock good in memory and costs only the next restart's prompt — the behaviour before the ledger
   * — so it is swallowed rather than failing a ceremony the person already completed.
   */
  async #persistUnlocks(): Promise<void> {
    const ledger = this.deps.unlocks;
    if (ledger === undefined) return;
    const now = this.deps.clock.nowMs();
    for (const [deviceId, at] of this.#unlockedAt) if (now - at >= LONGEST_UNLOCK_MS) this.#unlockedAt.delete(deviceId);
    const snapshot = new Map(this.#unlockedAt);
    const operation = this.#persisting.then(async () => await ledger.write(snapshot));
    this.#persisting = operation.catch(() => undefined);
    await operation.catch(() => undefined);
  }

  #unlockedUntil(deviceId: string, settings: SecuritySettings): number {
    const at = this.#unlockedAt.get(deviceId);
    return at === undefined ? 0 : at + settings.unlockValidityHours * HOUR_MS;
  }

  /** Revoking a device forgets its passkeys, its step-ups, its unlock and its outstanding challenges. */
  async forgetDevice(deviceId: string): Promise<void> {
    this.#reopened.delete(deviceId);
    this.deps.registry.forgetDevice(deviceId);
    this.#unlockedAt.delete(deviceId);
    await this.#persistUnlocks();
    this.deps.challenges.forgetDevice(deviceId);
    await this.deps.store.forgetDevice(deviceId);
  }

  /** The `register-confirm` challenge, issued bound to this registration's, and the options it travels in. */
  #confirmOptions(
    device: StepUpSubject,
    origin: string,
    usable: readonly StoredPasskey[],
    registration: Uint8Array,
    nowMs: number,
  ): StepUpOptions {
    const challenge = this.deps.random.bytes(CHALLENGE_BYTES);
    this.deps.challenges.issue(device, 'register-confirm', challenge, nowMs, registration);
    return {
      challenge: toBase64Url(challenge),
      rpId: relyingPartyIdFor(origin),
      allowCredentials: usable.map(passkey => ({ type: 'public-key' as const, id: passkey.credentialId })),
      timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
    };
  }

  /**
   * One assertion by a passkey THIS device holds, against `challenge`, its counter moved by the store's
   * compare-and-set. A counter that did not move — stalled, rewound, or beaten by a concurrent assertion
   * from another copy of the app — refuses, and is written down, because it is the one sign a cloned
   * authenticator leaves.
   */
  async #verifyAssertion(
    device: StepUpSubject,
    passkeys: readonly StoredPasskey[],
    assertion: StepUpAssertion,
    challenge: Uint8Array,
    nowMs: number,
  ): Promise<boolean> {
    const credential = passkeys.find(passkey => secretsMatch(passkey.credentialId, assertion.credentialId));
    if (credential === undefined) return false;
    const clientDataJSON = fromBase64Url(assertion.clientDataJSON);
    const authenticatorData = fromBase64Url(assertion.authenticatorData);
    const signature = fromBase64Url(assertion.signature);
    const publicKeySpki = fromBase64Url(credential.publicKeySpki);
    if (clientDataJSON === null || authenticatorData === null || signature === null || publicKeySpki === null)
      return false;
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
    const moved =
      verdict.ok &&
      (await this.deps.store.updateSignCount(device.deviceId, credential.credentialId, verdict.signCount));
    if (moved) return true;
    if (verdict.ok || verdict.reason === 'counter-not-increased')
      await this.deps.audit.record({
        actor: `device:${device.deviceId}`,
        changes: [`passkey.counter-refused=${device.deviceId}`],
        at: instant(nowMs),
      });
    return false;
  }

  async #registration(
    device: StepUpSubject,
    passkeys: readonly StoredPasskey[],
    nowMs: number,
  ): Promise<{ readonly kind: PasskeysView['registration']; readonly closesAtMs?: number }> {
    const reopened = this.#reopened.get(device.deviceId);
    if (reopened !== undefined && reopened > nowMs) return { kind: 'reopened', closesAtMs: reopened };
    if (reopened !== undefined) this.#reopened.delete(device.deviceId);
    if (passkeys.length > 0) return { kind: 'confirm-existing' };
    const record = await this.deps.devices.device(device.deviceId);
    if (record === undefined) return { kind: 'closed' };
    const closesAtMs = Date.parse(record.createdAt) + PASSKEY_REGISTRATION_WINDOW_SECONDS * 1_000;
    return closesAtMs > nowMs ? { kind: 'first-window', closesAtMs } : { kind: 'closed' };
  }
}

/**
 * What the owner's devices are told when a passkey is added, naming the device it was added to. Never
 * an id, a key or an origin: the person needs "was that me?", and a stranger reading a lock screen
 * needs nothing more.
 */
export function passkeyAddedNotice(deviceName: string): PushNotificationPayload {
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: 'passkey-added',
    title: 'A passkey was added',
    body: `${deviceName} has a new passkey for this machine. If that was not you, revoke the device at the machine.`,
    tag: 'passkey-added',
    url: '/',
    count: 1,
  });
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
