/**
 * A LATER JOIN PROVES THE PERSON (docs/catalogs.md § Joining as someone who is already here, docs/relay-protocol.md
 * §14 "Member sessions").
 *
 * A share code for a person who already has a passkey is not enough to add a browser to them: whoever holds a
 * forwarded invite would be Alice. So the joining browser first asks `join-options` and is handed a WebAuthn challenge
 * for ONE of Alice's passkeys (`allowCredentials` is every one of hers at the page's origin, so a synced passkey or a
 * phone's hybrid QR just works), then carries the assertion in its `join`. Nothing is filed and no code is spent until
 * the assertion holds.
 *
 * ## The challenge
 *
 * Random, issued per `(share, browser key)` and held in memory only, for the same two minutes a step-up challenge
 * lives. It is TAKEN when a join arrives and spent whether or not the assertion verifies, so a captured assertion
 * proves nothing twice and a failed try needs fresh options. It is bound to the share, the browser key that asked and
 * the person: an assertion for another share, another key or another person's credential does not verify.
 *
 * The ledger is bounded (a hostile holder of a live code cannot grow it) and is not the step-up ledger, which keys by
 * a subject a stranger does not have yet.
 *
 * ## The verifier
 *
 * The same one an unlock uses, with the same origin, rpId, user-verification and signCount rules; the credential is
 * found among the passkeys of the browsers of THIS person and nowhere else, so a revoked person, a removed browser
 * and another person's credential all find nothing.
 */
import {
  type JoinProofOptions,
  MAX_JOIN_PROOF_PASSKEYS,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  type MemberJoinProof,
} from '../boundary.ts';
import { fromBase64Url, toBase64Url } from '../relay-wire/index.ts';
import { secretsMatch } from '../secrets-match.ts';
import { relyingPartyIdFor } from '../member-passkeys/helpers.ts';
import type {
  PasskeyStore,
  PasskeyVerifierPort,
  StepUpClock,
  StepUpRandom,
  StoredPasskey,
} from '../member-passkeys/types.ts';

const CHALLENGE_BYTES = 32;
/**
 * The credential ids one challenge may list, in characters. The sealed answer is padded to a fixed size and one that
 * does not fit becomes a refusal, so a person with very long ids is offered their newest ones that fit.
 */
const ALLOWED_IDS_BUDGET = 12 * 1024;
/** Challenges held at once, across every share. Past it the oldest go first. */
const CHALLENGES_MAX = 1_024;
/** Challenges held for one share: a holder of one code cannot push everyone else's out. */
const CHALLENGES_PER_SHARE_MAX = 16;

/** Who is asking: the share, the person it names, and the browser key that will carry the assertion. */
export interface JoinProofSubject {
  readonly shareId: string;
  readonly memberId: string;
  readonly memberKey: string;
}

interface Issued {
  readonly shareId: string;
  readonly memberId: string;
  readonly challenge: Uint8Array;
  readonly origin: string;
  readonly expiresAt: number;
}

export interface JoinProofDeps {
  /** Every passkey of every browser one person has; none for a person who is gone. */
  readonly passkeysOf: (memberId: string) => Promise<readonly StoredPasskey[]>;
  readonly store: Pick<PasskeyStore, 'updateSignCount'>;
  readonly verifier: PasskeyVerifierPort;
  readonly random: StepUpRandom;
  readonly clock: StepUpClock;
  readonly allowedOrigins: () => readonly string[];
}

/** The newest passkeys first, as many as the challenge may list (the count cap and the size budget). */
function newestFitting(passkeys: readonly StoredPasskey[]): readonly StoredPasskey[] {
  const newest = [...passkeys].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const chosen: StoredPasskey[] = [];
  let size = 0;
  for (const passkey of newest) {
    size += passkey.credentialId.length;
    if (chosen.length >= MAX_JOIN_PROOF_PASSKEYS || size > ALLOWED_IDS_BUDGET) break;
    chosen.push(passkey);
  }
  return chosen;
}

const keyOf = (subject: JoinProofSubject): string => `${subject.shareId}\u0000${subject.memberKey}`;

export class MemberJoinProver {
  readonly #issued = new Map<string, Issued>();

  constructor(private readonly deps: JoinProofDeps) {}

  /**
   * The challenge for one of this person's passkeys made at `origin`, or nothing when this machine does not serve
   * that origin or the person has no passkey that answers there (they cannot prove, so the join is refused).
   */
  async options(subject: JoinProofSubject, origin: string): Promise<JoinProofOptions | undefined> {
    if (!this.deps.allowedOrigins().includes(origin)) return undefined;
    const usable = (await this.deps.passkeysOf(subject.memberId)).filter(passkey => passkey.origin === origin);
    if (usable.length === 0) return undefined;
    const challenge = this.deps.random.bytes(CHALLENGE_BYTES);
    const now = this.deps.clock.nowMs();
    this.#issue(subject, { challenge, origin, expiresAt: now + PASSKEY_CHALLENGE_TTL_SECONDS * 1_000 }, now);
    return {
      challenge: toBase64Url(challenge),
      rpId: relyingPartyIdFor(origin),
      allowCredentials: newestFitting(usable).map(passkey => ({
        type: 'public-key' as const,
        id: passkey.credentialId,
      })),
      timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
    };
  }

  /**
   * Whether this assertion is one of the person's passkeys signing the challenge issued to this share and key. The
   * challenge is spent first, whatever follows. Never throws.
   */
  async verify(subject: JoinProofSubject, assertion: MemberJoinProof): Promise<boolean> {
    const issued = this.#take(subject);
    if (issued === undefined) return false;
    try {
      const passkeys = await this.deps.passkeysOf(subject.memberId);
      const credential = passkeys.find(
        passkey => passkey.origin === issued.origin && secretsMatch(passkey.credentialId, assertion.credentialId),
      );
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
        expectedChallenge: issued.challenge,
        allowedOrigins: this.deps.allowedOrigins().filter(origin => origin === credential.origin),
        credential: { algorithm: credential.algorithm, publicKeySpki, signCount: credential.signCount },
      });
      return (
        verdict.ok &&
        (await this.deps.store.updateSignCount(credential.deviceId, credential.credentialId, verdict.signCount))
      );
    } catch {
      return false;
    }
  }

  /** The challenges held, for the tests. */
  get held(): number {
    return this.#issued.size;
  }

  #issue(subject: JoinProofSubject, fresh: Pick<Issued, 'challenge' | 'origin' | 'expiresAt'>, now: number): void {
    for (const [key, entry] of this.#issued) if (entry.expiresAt <= now) this.#issued.delete(key);
    const key = keyOf(subject);
    this.#issued.delete(key);
    const ofShare = [...this.#issued].filter(([, entry]) => entry.shareId === subject.shareId);
    for (const [oldest] of ofShare.slice(0, Math.max(0, ofShare.length - CHALLENGES_PER_SHARE_MAX + 1)))
      this.#issued.delete(oldest);
    for (const oldest of this.#issued.keys()) {
      if (this.#issued.size < CHALLENGES_MAX) break;
      this.#issued.delete(oldest);
    }
    this.#issued.set(key, { shareId: subject.shareId, memberId: subject.memberId, ...fresh });
  }

  #take(subject: JoinProofSubject): Issued | undefined {
    const key = keyOf(subject);
    const issued = this.#issued.get(key);
    this.#issued.delete(key);
    if (issued === undefined || issued.expiresAt <= this.deps.clock.nowMs()) return undefined;
    return issued.memberId === subject.memberId ? issued : undefined;
  }
}
