/**
 * A MEMBER'S PASSKEYS AND UNLOCK (docs/design/zero-trust.md B2, docs/catalogs.md § Members).
 *
 * The same WebAuthn ceremonies a paired device runs, on the same verifier, for a browser that holds a member key:
 * the key id plays the device id. A member reads and installs; it never steps up for anything, so there is no
 * step-up here, only the unlock — one assertion that opens `/v1/shared/*` for `memberUnlockDays`.
 *
 * WHO MAY ADD A PASSKEY: before the first unlock, ONLY the key's own window (ten minutes after the join) and only
 * while it holds none. Once unlocked, more are allowed — a person adds a second authenticator from a browser that
 * already proved the first. A member's passkey is not a path to anything else: it opens no capability.
 *
 * THE USER HANDLE IS THE KEY ID, never the member id, so a synced passkey manager (which replaces a passkey with
 * the same relying party and handle) cannot let a member's second browser overwrite the first browser's passkey.
 */
import {
  MAX_PASSKEYS_PER_DEVICE,
  MEMBER_UNLOCK_DAYS_MAX,
  memberPasskeyName,
  PASSKEY_ALGORITHMS,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  type PasskeyRegistration,
  type PasskeyRegistrationOptions,
  type PasskeyView,
  type StepUpAssertion,
  type StepUpOptions,
  type UnlockGranted,
} from '@ferretry/protocol';
import { fromBase64Url, toBase64Url } from '@ferretry/relay';
import { secretsMatch } from '../api/authentication.ts';
import { relyingPartyIdFor } from '../step-up/service.ts';
import type { PasskeysChangedSignal } from '../step-up/passkeys-changed.ts';
import type { ChallengeLedger } from '../step-up/registry.ts';
import type {
  PasskeyStore,
  PasskeyVerifierPort,
  StepUpClock,
  StepUpRandom,
  StoredPasskey,
  UnlockLedgerPort,
} from '../step-up/types.ts';
import type { MemberAuditSink } from './ports.ts';
import type { MemberAccess } from './service.ts';

/** Why a member ceremony said no. One closed set; a finer reason helps only a forger. */
export const MEMBER_PASSKEY_REFUSALS = [
  'origin-not-allowed',
  'registration-closed',
  'too-many-passkeys',
  'no-passkey',
  'not-verified',
] as const;
export type MemberPasskeyRefusal = (typeof MEMBER_PASSKEY_REFUSALS)[number];

export type MemberPasskeyOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: MemberPasskeyRefusal };

/** One running copy of the app on one member key: what a challenge is bound to. */
export interface MemberPasskeyCaller {
  readonly access: MemberAccess;
  readonly appSession: string;
}

export interface MemberPasskeyDeps {
  readonly store: PasskeyStore;
  readonly verifier: PasskeyVerifierPort;
  readonly challenges: ChallengeLedger;
  readonly random: StepUpRandom;
  readonly clock: StepUpClock;
  readonly unlocks?: UnlockLedgerPort;
  readonly members: {
    passkeyAdded(keyId: string): Promise<number>;
    /** The key as it stands now; nothing when it was removed or time ended it. */
    access(keyId: string): Promise<MemberAccess | undefined>;
  };
  /** The names of the catalogs by id, for the passkey's account name. Read per call. */
  readonly catalogNames: () => Promise<ReadonlyMap<string, string>>;
  readonly allowedOrigins: () => readonly string[];
  /** What the authenticator shows as the relying party's name. */
  readonly relyingPartyName: string;
  readonly daemonName: () => string;
  readonly unlockDays: () => number;
  readonly audit: MemberAuditSink;
  /**
   * Told after a key is forgotten with its passkeys. A member's passkey backs no kept proof today (a standing rule is a
   * paired device's), so this only keeps "a passkey was removed" one signal whichever route removed it.
   */
  readonly passkeysChanged?: PasskeysChangedSignal;
}

const CHALLENGE_BYTES = 32;
const DAY_MS = 24 * 60 * 60 * 1_000;
const refuse = (refusal: MemberPasskeyRefusal): { readonly ok: false; readonly refusal: MemberPasskeyRefusal } => ({
  ok: false,
  refusal,
});
const instant = (ms: number): string => new Date(ms).toISOString();
const subjectOf = (caller: MemberPasskeyCaller) => ({ deviceId: caller.access.keyId, appSession: caller.appSession });
const passkeyView = (passkey: StoredPasskey): PasskeyView => ({
  id: passkey.credentialId,
  origin: passkey.origin,
  createdAt: passkey.createdAt,
});

export class MemberPasskeyService {
  /** When each member key last unlocked. Read back by {@link restore}, so a restart does not ask again. */
  readonly #unlockedAt = new Map<string, number>();
  #persisting: Promise<unknown> = Promise.resolve();
  /** The registration in flight per key: one key adds its passkeys one at a time. */
  readonly #registering = new Map<string, Promise<void>>();

  constructor(private readonly deps: MemberPasskeyDeps) {}

  /** Reads back the unlocks a previous run granted, before anything is served. A damaged ledger asks everyone again. */
  async restore(): Promise<string | undefined> {
    const ledger = this.deps.unlocks;
    if (ledger === undefined) return undefined;
    let stored: ReadonlyMap<string, number>;
    try {
      stored = await ledger.read();
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return `the member unlock ledger could not be read (${cause}), so every member is asked to unlock again`;
    }
    const now = this.deps.clock.nowMs();
    for (const [keyId, at] of stored) if (at <= now && !this.#unlockedAt.has(keyId)) this.#unlockedAt.set(keyId, at);
    return undefined;
  }

  /** When this key's unlock ends, or nothing when it is not unlocked. */
  unlockExpiresAt(keyId: string): number | undefined {
    const at = this.#unlockedAt.get(keyId);
    if (at === undefined) return undefined;
    const ends = at + this.deps.unlockDays() * DAY_MS;
    return ends > this.deps.clock.nowMs() ? ends : undefined;
  }

  async passkeyCount(keyId: string): Promise<number> {
    return (await this.deps.store.list(keyId)).length;
  }

  /** Whether this key may add a passkey now: unlocked, or inside its own window with none yet. */
  async mayRegister(access: MemberAccess): Promise<boolean> {
    const held = await this.passkeyCount(access.keyId);
    if (held >= MAX_PASSKEYS_PER_DEVICE) return false;
    if (this.unlockExpiresAt(access.keyId) !== undefined) return true;
    const closes = access.passkeyWindowEndsAt === undefined ? 0 : Date.parse(access.passkeyWindowEndsAt);
    return held === 0 && closes > this.deps.clock.nowMs();
  }

  async registrationOptions(
    caller: MemberPasskeyCaller,
    origin: string,
  ): Promise<MemberPasskeyOutcome<PasskeyRegistrationOptions>> {
    if (!this.deps.allowedOrigins().includes(origin)) return refuse('origin-not-allowed');
    const { access } = caller;
    const held = await this.deps.store.list(access.keyId);
    if (held.length >= MAX_PASSKEYS_PER_DEVICE) return refuse('too-many-passkeys');
    if (!(await this.mayRegister(access))) return refuse('registration-closed');
    const challenge = this.deps.random.bytes(CHALLENGE_BYTES);
    this.deps.challenges.issue(subjectOf(caller), 'register', challenge, this.deps.clock.nowMs());
    const names = await this.deps.catalogNames();
    const catalogs = access.catalogIds.flatMap(id => (names.has(id) ? [names.get(id) ?? ''] : []));
    const name = memberPasskeyName(access.label, catalogs, this.deps.daemonName());
    return {
      ok: true,
      value: {
        challenge: toBase64Url(challenge),
        rp: { id: relyingPartyIdFor(origin), name: this.deps.relyingPartyName },
        user: { id: toBase64Url(new TextEncoder().encode(access.keyId)), name, displayName: name },
        pubKeyCredParams: PASSKEY_ALGORITHMS.map(alg => ({ type: 'public-key' as const, alg })),
        timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
        excludeCredentials: held.map(passkey => ({ type: 'public-key' as const, id: passkey.credentialId })),
      },
    };
  }

  async register(
    caller: MemberPasskeyCaller,
    registration: Omit<PasskeyRegistration, 'confirmation'>,
  ): Promise<MemberPasskeyOutcome<PasskeyView>> {
    const now = this.deps.clock.nowMs();
    // Spent FIRST, whatever happens next: a challenge is answered once.
    const challenge = this.deps.challenges.take(subjectOf(caller), 'register', now);
    return await this.#exclusively(
      caller.access.keyId,
      async () => await this.#register(caller, registration, challenge, now),
    );
  }

  /** Runs `work` after every earlier one of this key finished, whatever way it finished. */
  async #exclusively<T>(keyId: string, work: () => Promise<T>): Promise<T> {
    const done = (this.#registering.get(keyId) ?? Promise.resolve()).then(work);
    const tail = done.then(
      () => undefined,
      () => undefined,
    );
    this.#registering.set(keyId, tail);
    void tail.then(() => {
      if (this.#registering.get(keyId) === tail) this.#registering.delete(keyId);
    });
    return await done;
  }

  async #register(
    caller: MemberPasskeyCaller,
    registration: Omit<PasskeyRegistration, 'confirmation'>,
    challenge: Uint8Array | undefined,
    now: number,
  ): Promise<MemberPasskeyOutcome<PasskeyView>> {
    // The key as it is now, not as the request saw it: it may have gone, or its window closed, while this queued.
    const access = await this.deps.members.access(caller.access.keyId);
    if (access === undefined) return refuse('registration-closed');
    const held = await this.deps.store.list(access.keyId);
    if (held.length >= MAX_PASSKEYS_PER_DEVICE) return refuse('too-many-passkeys');
    if (!(await this.mayRegister(access))) return refuse('registration-closed');
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
    if (credentialId !== registration.credentialId) return refuse('not-verified');
    // Any key's: a credential belongs to the one key that registered it.
    if ((await this.deps.store.holder(credentialId)) !== undefined) return refuse('not-verified');
    const stored: StoredPasskey = {
      credentialId,
      deviceId: access.keyId,
      algorithm: verdict.algorithm,
      publicKeySpki: toBase64Url(verdict.publicKeySpki),
      signCount: verdict.signCount,
      origin: verdict.origin,
      createdAt: instant(now),
    };
    // Once more, immediately before the add: the verify above is the slow part, and a key removed meanwhile
    // must not leave a passkey row behind.
    const current = await this.deps.members.access(access.keyId);
    if (current === undefined || !(await this.mayRegister(current))) return refuse('registration-closed');
    await this.deps.store.add(stored);
    await this.deps.members.passkeyAdded(access.keyId);
    await this.deps.audit
      .record({
        actor: { kind: 'anonymous' },
        event: 'catalog.member.passkey-added',
        subject: access.memberId,
        outcome: 'succeeded',
        detail: { memberLabel: access.label, keyId: access.keyId, clientName: access.clientName },
      })
      .catch(() => undefined);
    return { ok: true, value: passkeyView(stored) };
  }

  async unlockOptions(caller: MemberPasskeyCaller, origin: string): Promise<MemberPasskeyOutcome<StepUpOptions>> {
    if (!this.deps.allowedOrigins().includes(origin)) return refuse('origin-not-allowed');
    // A passkey answers only at the origin it was made at.
    const usable = (await this.deps.store.list(caller.access.keyId)).filter(passkey => passkey.origin === origin);
    if (usable.length === 0) return refuse('no-passkey');
    const challenge = this.deps.random.bytes(CHALLENGE_BYTES);
    this.deps.challenges.issue(subjectOf(caller), 'unlock', challenge, this.deps.clock.nowMs());
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

  /** One assertion that opens `/v1/shared/*` to this key for the unlock period. */
  async unlock(
    caller: MemberPasskeyCaller,
    assertion: Omit<StepUpAssertion, 'rotation'>,
  ): Promise<MemberPasskeyOutcome<UnlockGranted>> {
    const { access } = caller;
    const now = this.deps.clock.nowMs();
    const challenge = this.deps.challenges.take(subjectOf(caller), 'unlock', now);
    if (challenge === undefined) return refuse('not-verified');
    if (!(await this.#verify(access.keyId, assertion, challenge))) return refuse('not-verified');
    this.#unlockedAt.set(access.keyId, now);
    await this.#persist();
    await this.deps.audit
      .record({
        actor: { kind: 'anonymous' },
        event: 'catalog.member.unlocked',
        subject: access.memberId,
        outcome: 'succeeded',
        detail: { memberLabel: access.label, keyId: access.keyId },
      })
      .catch(() => undefined);
    return { ok: true, value: { unlockedUntil: instant(now + this.deps.unlockDays() * DAY_MS) } };
  }

  /** Every passkey the key holds, for the view. */
  async views(keyId: string): Promise<readonly PasskeyView[]> {
    return (await this.deps.store.list(keyId)).map(passkeyView);
  }

  /** A key left or was removed: its passkeys, unlock and challenges go with it, and the passkeys-changed signal is told. */
  async forgetKey(keyId: string): Promise<void> {
    this.deps.challenges.forgetDevice(keyId);
    if (this.#unlockedAt.delete(keyId)) await this.#persist();
    await this.deps.store.forgetDevice(keyId);
    await this.deps.passkeysChanged?.emit({ cause: 'member-key-forgotten', keyId });
  }

  async #verify(keyId: string, assertion: Omit<StepUpAssertion, 'rotation'>, challenge: Uint8Array): Promise<boolean> {
    const passkeys = await this.deps.store.list(keyId);
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
      allowedOrigins: this.deps.allowedOrigins().filter(origin => origin === credential.origin),
      credential: { algorithm: credential.algorithm, publicKeySpki, signCount: credential.signCount },
    });
    return verdict.ok && (await this.deps.store.updateSignCount(keyId, credential.credentialId, verdict.signCount));
  }

  /** A write that fails leaves the unlock good in memory and costs only the next restart's prompt. */
  async #persist(): Promise<void> {
    const ledger = this.deps.unlocks;
    if (ledger === undefined) return;
    const now = this.deps.clock.nowMs();
    const longest = MEMBER_UNLOCK_DAYS_MAX * DAY_MS;
    for (const [keyId, at] of this.#unlockedAt) if (now - at >= longest) this.#unlockedAt.delete(keyId);
    const snapshot = new Map(this.#unlockedAt);
    const operation = this.#persisting.then(async () => await ledger.write(snapshot));
    this.#persisting = operation.catch(() => undefined);
    await operation.catch(() => undefined);
  }
}
