import {
  type EveryCallerStepUpAct,
  type MachineSkippableStepUpAct,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  STEP_UP_TTL_SECONDS,
  type StepUpAct,
  stepUpKeepsProof,
  stepUpSkippableAtMachine,
  type StoredProofStepUpAct,
  type StoredStepUpProof,
} from '@ferretry/protocol';
import { bytesEqual } from '@ferretry/relay';

/** One running copy of the app on one device: what a step-up and a challenge are bound to. */
export interface StepUpSubject {
  readonly deviceId: string;
  readonly appSession: string;
}

const key = (subject: StepUpSubject): string => `${subject.deviceId}\u0000${subject.appSession}`;

/**
 * How long a copy of the app may have no live session at all and still be the same copy: long enough
 * for a lease to end and its session to be reopened, far shorter than a step-up.
 */
export const APP_SESSION_GRACE_MS = 60_000;

/** One verified step-up: when it was proved. Its end is read from the window in force, every time. */
interface HeldStepUp {
  readonly grantedAtMs: number;
}

/** A passkey proved for an act: when, and the act the person said it was for (none when they did not say). */
interface FreshProof {
  readonly provedAtMs: number;
  readonly act: MachineSkippableStepUpAct | undefined;
}

/**
 * What is KEPT of a ceremony for a stored-proof act: the assertion exactly as verified (`evidence`), and the challenge
 * the live ceremony verified it against. A claim must name that same challenge, so a kept proof is only ever handed to a
 * commit of the very bytes it signed.
 */
export interface KeptProof {
  readonly evidence: StoredStepUpProof;
  readonly challenge: Uint8Array;
}

/**
 * A passkey proved for an act asked of EVERY caller (`STEP_UP_ACTS_EVERY_CALLER`), bound to the ONE thing it is for:
 * `bound` is the digest the challenge was issued with (`addTwoFactorKeySubject`, the account and the staged seed), or
 * the staged body's id (`srs_…`) for a stored-proof act.
 *
 * `kept` is present exactly when the act keeps its proof (`STEP_UP_ACTS_STORED_PROOF`), so which claim may take it is
 * decided by the act alone.
 */
interface BoundProof {
  readonly provedAtMs: number;
  readonly act: EveryCallerStepUpAct;
  readonly bound: string;
  readonly kept?: KeptProof;
}

/** An every-caller act whose proof is spent, never kept: `claimFresh` takes it, `claimStoredProof` never does. */
export type SpentProofStepUpAct = Exclude<EveryCallerStepUpAct, StoredProofStepUpAct>;

/**
 * What a `step-up` challenge was asked for, decided when it is issued and carried to the ceremony that answers it:
 * - `act`: an act the machine may skip; the proof it buys is stamped with it.
 * - `bound`: an act every caller must prove, whose proof is spent on the one save it names (`bound`).
 * - `kept`: an act whose proof is STORED; the challenge was derived from the staged body (`stage`), and the ceremony
 *   keeps the assertion.
 * No stamp: an act-less proof.
 */
export type ChallengeStamp =
  | { readonly kind: 'act'; readonly act: MachineSkippableStepUpAct }
  | { readonly kind: 'bound'; readonly act: SpentProofStepUpAct; readonly bound: string }
  | { readonly kind: 'kept'; readonly act: StoredProofStepUpAct; readonly stage: string };

/** The step-up window in force, in minutes. `0` means a step-up admits exactly one governed act. */
export type StepUpWindow = () => number;

const DEFAULT_WINDOW: StepUpWindow = () => STEP_UP_TTL_SECONDS / 60;

/** One copy of the app's unbroken life on this daemon: how many sessions it holds, and since when none. */
interface AppSessionSpan {
  open: number;
  closedAtMs: number | undefined;
}

/**
 * WHICH RUNNING COPIES OF THE APP HAVE PROVED A PASSKEY RECENTLY, held in memory and nowhere else.
 *
 * A verified step-up is never a value the browser holds: there is nothing to steal or carry to another
 * tab. It is a fact this daemon remembers about one `(deviceId, appSession)` for the machine's step-up
 * window (`stepUpWindowMinutes`, fifteen minutes unless the owner changed it), and it ends early on
 * revocation (`forgetDevice`), on a restart (memory), and when the page closes.
 *
 * THE WINDOW IS READ AT EVERY QUESTION, not stamped at the grant, so a shortened window applies to the
 * step-ups already held the moment it is saved. A window of `0` asks every time: a step-up is then
 * good for ONE governed act — spent by the boundary that admits it ({@link spend}) — and lives no
 * longer than a challenge does, which is long enough for the refused request to be sent again.
 *
 * "WHEN THE PAGE CLOSES" IS DECIDED HERE, NOT BY THE PAGE. `appSession` is 16 bytes the page picks,
 * so code running in it — an injected script, a malicious deploy — could keep the value and present it
 * again from a later page of the same device. What it cannot keep is a live session. So a step-up
 * belongs to one SPAN: the unbroken stretch in which that copy holds at least one session, with
 * {@link APP_SESSION_GRACE_MS} of slack for a reconnect. When the span ends, its step-up ends with it,
 * and the same id presented afterwards begins a new span that holds nothing.
 */
export class StepUpRegistry {
  readonly #held = new Map<string, HeldStepUp>();
  /**
   * Step-ups not yet spent on an act that ADDS ACCESS — minting a pairing code, widening a device — by
   * when each was proved. Such an act wants a passkey proved for it, so it takes one of these, and only
   * while it is a challenge's lifetime old: the window a step-up otherwise covers is not enough.
   */
  readonly #fresh = new Map<string, FreshProof>();
  /**
   * Proofs for an act every caller must prove, kept APART from {@link #fresh} and {@link #held}: nothing that asks
   * "did this copy prove a passkey just now?" without naming the act and its subject can see one, and no such proof
   * can be spent on anything but the one save it was proved for. One per copy of the app; a newer one replaces it.
   */
  readonly #bound = new Map<string, BoundProof>();
  readonly #spans = new Map<string, AppSessionSpan>();

  constructor(
    private readonly clock: { readonly nowMs: () => number },
    private readonly window: StepUpWindow = DEFAULT_WINDOW,
  ) {}

  /** A session of this copy of the app opened. Returns the call for when it ends. */
  open(subject: StepUpSubject): () => void {
    const id = key(subject);
    const span = this.#liveSpan(id, this.clock.nowMs()) ?? this.#begin(id);
    span.open += 1;
    span.closedAtMs = undefined;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      span.open -= 1;
      if (span.open > 0) return;
      const now = this.clock.nowMs();
      span.closedAtMs = now;
      this.#sweep(now);
    };
  }

  /**
   * Records a verified step-up and returns when it lapses. `fresh` is whether the passkey was proved FOR
   * AN ACT (a step-up): the unlock opens the machine and is never one (`fresh: false`), so it can never
   * be spent on an act that adds access. `act` stamps the proof with the act it was proved for.
   */
  grant(subject: StepUpSubject, nowMs: number, fresh = true, act?: MachineSkippableStepUpAct): number {
    const held: HeldStepUp = { grantedAtMs: nowMs };
    this.#held.set(key(subject), held);
    if (fresh) this.#fresh.set(key(subject), { provedAtMs: nowMs, act });
    else this.#fresh.delete(key(subject));
    return this.#endOf(held);
  }

  /**
   * Records a passkey proved for an act every caller must prove, bound to `bound`, and returns when it lapses (one
   * challenge's life). It is NOT a step-up: it opens no window ({@link held} stays as it was) and it is not the fresh
   * proof an act-less check reads ({@link freshlyHeld}), so it buys the one save it names and nothing else.
   */
  grantBound(subject: StepUpSubject, nowMs: number, act: SpentProofStepUpAct, bound: string): number;
  /**
   * An act whose proof is STORED also keeps the assertion that proved it and its challenge (`kept`), for
   * {@link claimStoredProof} to hand over once; `bound` is then the staged body's id (`srs_…`). What is kept is required
   * for such an act and refused for every other: a mismatch records nothing and THROWS, never answering a lapse time
   * for a grant that was not made.
   */
  grantBound(subject: StepUpSubject, nowMs: number, act: StoredProofStepUpAct, bound: string, kept: KeptProof): number;
  grantBound(
    subject: StepUpSubject,
    nowMs: number,
    act: EveryCallerStepUpAct,
    bound: string,
    kept?: KeptProof,
  ): number {
    if (stepUpKeepsProof(act) !== (kept !== undefined))
      throw new TypeError('a stored-proof act keeps its proof, and no other act does');
    this.#bound.set(key(subject), { provedAtMs: nowMs, act, bound, ...(kept === undefined ? {} : { kept }) });
    return nowMs + PASSKEY_CHALLENGE_TTL_SECONDS * 1_000;
  }

  /**
   * One governed act was admitted on this copy's step-up. Under a window of `0` that spends it;
   * under any other window a step-up covers every act inside it, and this does nothing.
   */
  spend(subject: StepUpSubject): void {
    if (this.window() === 0) this.#held.delete(key(subject));
  }

  /**
   * When this copy's step-up lapses, or nothing when it holds none. A lapsed one is forgotten here, and
   * so is one whose copy of the app has had no live session for longer than the grace.
   */
  expiresAt(subject: StepUpSubject, nowMs: number): number | undefined {
    const id = key(subject);
    const held = this.#held.get(id);
    if (held === undefined) return undefined;
    const expiresAtMs = this.#endOf(held);
    if (expiresAtMs > nowMs && this.#liveSpan(id, nowMs) !== undefined) return expiresAtMs;
    this.#held.delete(id);
    return undefined;
  }

  held(subject: StepUpSubject, nowMs: number): boolean {
    return this.expiresAt(subject, nowMs) !== undefined;
  }

  /**
   * Whether this copy proved a passkey within a challenge's lifetime and has not spent that proof on an
   * act that adds access. Never true without a live step-up, so a page that closed holds none.
   */
  freshlyHeld(subject: StepUpSubject, nowMs: number): boolean {
    const proof = this.#fresh.get(key(subject));
    return (
      proof !== undefined &&
      nowMs - proof.provedAtMs < PASSKEY_CHALLENGE_TTL_SECONDS * 1_000 &&
      this.held(subject, nowMs)
    );
  }

  /**
   * Takes this copy's fresh proof if it holds one, in ONE step: of two acts racing on one proof exactly
   * one gets `true`. Nothing awaits between the check and the spend.
   *
   * Given an `act`, only a proof stamped for exactly that act is taken: a leftover proof for another act
   * (or none) stays where it is and does not count.
   */
  claimFresh(subject: StepUpSubject, nowMs: number, act?: MachineSkippableStepUpAct): boolean;
  /**
   * An act every caller must prove takes only a proof stamped with that act AND bound to exactly `bound`, within a
   * challenge's life, on a copy of the app with a live session. A proof bound to anything else stays where it is.
   */
  claimFresh(subject: StepUpSubject, nowMs: number, act: SpentProofStepUpAct, bound: string): boolean;
  claimFresh(subject: StepUpSubject, nowMs: number, act?: StepUpAct, bound?: string): boolean {
    if (act !== undefined && !stepUpSkippableAtMachine(act)) return this.#claimBound(subject, nowMs, act, bound);
    if (!this.freshlyHeld(subject, nowMs)) return false;
    if (act !== undefined && this.#fresh.get(key(subject))?.act !== act) return false;
    this.#fresh.delete(key(subject));
    return true;
  }

  #claimBound(subject: StepUpSubject, nowMs: number, act: EveryCallerStepUpAct, bound: string | undefined): boolean {
    // A stored-proof act's proof is handed over as evidence, never spent as a yes: refused here, and left in place.
    if (stepUpKeepsProof(act)) return false;
    const proof = this.#liveBound(subject, nowMs, act, bound);
    if (proof === undefined || proof.kept !== undefined) return false;
    this.#bound.delete(key(subject));
    return true;
  }

  /**
   * Takes the KEPT assertion of a passkey proved for `act` and bound to exactly `bound` (the stage), once, within a
   * challenge's life, on a copy of the app with a live session — and only when `expectedChallenge` is the challenge it
   * was verified against, compared in constant time. The caller derives that challenge again from the bytes it is about
   * to write, so evidence over any other bytes is never handed over. Anything else answers nothing and spends nothing.
   *
   * Only a stored-proof act is ever answered: an ordinary fresh or bound proof stays where it is, so a step-up can never
   * be stored as a rule's proof, and `claimFresh` never takes a proof this hands over.
   */
  claimStoredProof(
    subject: StepUpSubject,
    nowMs: number,
    act: StoredProofStepUpAct,
    bound: string,
    expectedChallenge: Uint8Array,
  ): StoredStepUpProof | undefined {
    if (!stepUpKeepsProof(act)) return undefined;
    const kept = this.#liveBound(subject, nowMs, act, bound)?.kept;
    if (kept === undefined || !bytesEqual(kept.challenge, expectedChallenge)) return undefined;
    this.#bound.delete(key(subject));
    return kept.evidence;
  }

  /** This copy's bound proof when it is for exactly `act` and `bound` and still live; a lapsed one is dropped. */
  #liveBound(
    subject: StepUpSubject,
    nowMs: number,
    act: EveryCallerStepUpAct,
    bound: string | undefined,
  ): BoundProof | undefined {
    const id = key(subject);
    const proof = this.#bound.get(id);
    if (bound === undefined || bound === '' || proof === undefined) return undefined;
    if (nowMs - proof.provedAtMs >= PASSKEY_CHALLENGE_TTL_SECONDS * 1_000) {
      this.#bound.delete(id);
      return undefined;
    }
    if (proof.act !== act || proof.bound !== bound || this.#liveSpan(id, nowMs) === undefined) return undefined;
    return proof;
  }

  /** An act that adds access was admitted on this copy's fresh proof: the next one needs another. */
  spendFresh(subject: StepUpSubject): void {
    this.#fresh.delete(key(subject));
  }

  /** Revoking a device ends every step-up any copy of the app on it holds. */
  forgetDevice(deviceId: string): void {
    for (const id of [...this.#held.keys()]) if (id.startsWith(`${deviceId}\u0000`)) this.#held.delete(id);
    for (const id of [...this.#fresh.keys()]) if (id.startsWith(`${deviceId}\u0000`)) this.#fresh.delete(id);
    for (const id of [...this.#bound.keys()]) if (id.startsWith(`${deviceId}\u0000`)) this.#bound.delete(id);
  }

  /** When a held step-up lapses under the window in force now. A single-use one lasts a challenge's life. */
  #endOf(held: HeldStepUp): number {
    const minutes = this.window();
    return held.grantedAtMs + (minutes === 0 ? PASSKEY_CHALLENGE_TTL_SECONDS * 1_000 : minutes * 60_000);
  }

  /** The span this copy is in, or nothing — and an ended one is dropped with its step-up. */
  #liveSpan(id: string, nowMs: number): AppSessionSpan | undefined {
    const span = this.#spans.get(id);
    if (span === undefined) return undefined;
    if (span.closedAtMs === undefined || nowMs - span.closedAtMs < APP_SESSION_GRACE_MS) return span;
    this.#spans.delete(id);
    this.#held.delete(id);
    this.#fresh.delete(id);
    this.#bound.delete(id);
    return undefined;
  }

  /** A new span. Whatever an earlier life of the same id held does not carry into it. */
  #begin(id: string): AppSessionSpan {
    this.#held.delete(id);
    this.#fresh.delete(id);
    this.#bound.delete(id);
    const span: AppSessionSpan = { open: 0, closedAtMs: undefined };
    this.#spans.set(id, span);
    return span;
  }

  /** Drops every ended span, so the map is bounded by the copies alive in the last minute. */
  #sweep(nowMs: number): void {
    for (const id of [...this.#spans.keys()]) this.#liveSpan(id, nowMs);
  }
}

/**
 * What a challenge was issued for. A registration challenge answers no assertion, and back; and a
 * `register-confirm` challenge — the existing passkey's answer that a later registration needs — is
 * bound to the one registration challenge it was issued with, so neither can be spent on its own. An
 * `unlock` challenge opens the machine to the device and answers nothing else.
 */
export type ChallengePurpose = 'register' | 'register-confirm' | 'step-up' | 'unlock';

interface IssuedChallenge {
  readonly bytes: Uint8Array;
  readonly expiresAtMs: number;
  /** The registration challenge a `register-confirm` was issued with. */
  readonly boundTo?: Uint8Array;
  /** What a `step-up` challenge was asked for, which the proof it buys is stamped with. */
  readonly stamp?: ChallengeStamp;
}

/**
 * The challenges this daemon has issued and nobody has answered yet: one per copy of the app per
 * purpose, two minutes each, spent by the first answer whether it verifies or not.
 *
 * ONE AT A TIME, deliberately. Asking again replaces the outstanding challenge, so a page that opened
 * the prompt twice cannot hold two live ones. That alone bounds nothing — a device can open a session
 * per fresh `appSession`, ask once and leave — so every issue also SWEEPS the lapsed ones: what the
 * ledger holds is bounded by the challenges issued in the last two minutes.
 */
export class ChallengeLedger {
  readonly #issued = new Map<string, IssuedChallenge>();

  issue(
    subject: StepUpSubject,
    purpose: ChallengePurpose,
    bytes: Uint8Array,
    nowMs: number,
    boundTo?: Uint8Array,
    stamp?: ChallengeStamp,
  ): void {
    for (const [id, issued] of this.#issued) if (issued.expiresAtMs <= nowMs) this.#issued.delete(id);
    this.#issued.set(`${purpose}\u0000${key(subject)}`, {
      bytes,
      expiresAtMs: nowMs + PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
      ...(boundTo === undefined ? {} : { boundTo }),
      ...(stamp === undefined ? {} : { stamp }),
    });
  }

  /**
   * The outstanding challenge for this copy and purpose, removed in the same call — so an answer is
   * judged against it exactly once — or nothing when there is none or it lapsed.
   */
  take(subject: StepUpSubject, purpose: ChallengePurpose, nowMs: number): Uint8Array | undefined {
    return this.#take(subject, purpose, nowMs)?.bytes;
  }

  /** {@link take}, with what the challenge was asked for. */
  takeWithAct(
    subject: StepUpSubject,
    purpose: ChallengePurpose,
    nowMs: number,
  ): { readonly bytes: Uint8Array; readonly stamp?: ChallengeStamp } | undefined {
    return this.#take(subject, purpose, nowMs);
  }

  /**
   * The outstanding `register-confirm` challenge, removed in the same call, and only when it was issued
   * with THIS registration challenge: a confirmation left over from an earlier options call is spent
   * and refused, never paired with a newer registration.
   */
  takeConfirmation(subject: StepUpSubject, registration: Uint8Array, nowMs: number): Uint8Array | undefined {
    const issued = this.#take(subject, 'register-confirm', nowMs);
    if (issued?.boundTo === undefined || !bytesEqual(issued.boundTo, registration)) return undefined;
    return issued.bytes;
  }

  /** How many challenges are outstanding, lapsed ones included until the next issue sweeps them. */
  get size(): number {
    return this.#issued.size;
  }

  forgetDevice(deviceId: string): void {
    for (const id of [...this.#issued.keys()]) if (id.split('\u0000')[1] === deviceId) this.#issued.delete(id);
  }

  #take(subject: StepUpSubject, purpose: ChallengePurpose, nowMs: number): IssuedChallenge | undefined {
    const id = `${purpose}\u0000${key(subject)}`;
    const issued = this.#issued.get(id);
    this.#issued.delete(id);
    if (issued === undefined || issued.expiresAtMs <= nowMs) return undefined;
    return issued;
  }
}
