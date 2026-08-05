import {
  type CapabilityGrantView,
  DAEMON_CAPABILITIES,
  type DaemonCapability,
  GRANT_UNLOCK_TTL_SECONDS,
  type GrantRefusal,
  type GrantsPatch,
  type GrantsView,
} from '@ferretry/protocol';
import type { CapabilityDemand, CapabilityGuard, CapabilityPresentation, GrantDecision } from '../api/capability.ts';
import {
  applyGrantPatch,
  decideCapability,
  describeGrantRefusal,
  type GrantEvaluation,
  grantChanges,
  INITIAL_UNLOCK_ATTEMPTS,
  isGovernedCaller,
  isUnlockLocked,
  patchedCapabilities,
  recordUnlockFailure,
  recordUnlockSuccess,
  type UnlockAttemptState,
  unlockAttemptsRemaining,
  widenedBy,
} from './policy.ts';
import type {
  EnforcedGrants,
  GrantAuditPort,
  GrantClock,
  GrantDocumentPort,
  OperatorPasswordPort,
  UnlockOutcome,
  UnlockTokenFactory,
} from './types.ts';

/** A refusal the grant subsystem raises, in a taxonomy the mount turns into a status. */
export type GrantFailure = 'invalid' | 'forbidden' | 'unavailable';

export class GrantError extends Error {
  constructor(
    readonly failure: GrantFailure,
    message: string,
  ) {
    super(message);
    this.name = 'GrantError';
  }
}

/** Everything the subsystem is built from, so nothing is reached for at the point of use. */
export interface CapabilityGrantDeps {
  readonly document: GrantDocumentPort;
  readonly passwords: OperatorPasswordPort;
  readonly tokens: UnlockTokenFactory;
  readonly clock: GrantClock;
  /** Where a change is recorded so it is visible after the fact rather than only in its effect. */
  readonly audit: GrantAuditPort;
  /** The command a human actually types, so a refusal names it rather than inventing one. */
  readonly clientName: string;
}

interface HeldUnlock {
  readonly token: string;
  readonly expiresAtMs: number;
}

/**
 * The operator's per-capability decision, enforced.
 *
 * ## IT HOLDS ITS ANSWER IN MEMORY, AND THAT IS THE DESIGN
 *
 * Authorization runs in front of every request and every socket upgrade. A boundary that read a file
 * to answer would put a filesystem — and a new failure mode — in front of a question that must always
 * have an answer, so the decision is loaded once, refreshed when it changes, and read synchronously.
 * `refresh` is the only path that moves it, and a refresh that FAILS sets the answer to
 * "undetermined" rather than leaving a stale one in place: a daemon that no longer knows what it may
 * do must stop doing it, not carry on from the last thing it remembered.
 *
 * A CHANGE MADE HERE TAKES EFFECT IMMEDIATELY. `patch` writes the document and moves the in-memory
 * answer in the same call, so the next request is decided by the new one — no restart. A document
 * edited by HAND behind the daemon's back is the case that needs a restart, and the command line says
 * so at the moment somebody does it.
 *
 * ## NOTHING HERE CAN WIDEN A CREDENTIAL
 *
 * `decide` is consulted only after the route's scope check has already passed, and every branch
 * either keeps that answer or removes it. A device token cannot reach an `admin` route because a
 * grant says `use: true`, and no document an operator writes can make it.
 *
 * ## THE PASSWORD IS NEVER HERE
 *
 * The subsystem holds no plaintext, no hash and no salt. It asks a port whether a candidate matches
 * and is told yes or no. Nothing it returns, logs or renders can contain a password, its length or
 * any part of the verifier — the same use-never-read shape the secret store is built on.
 */
export class CapabilityGrantService implements CapabilityGuard {
  /** `undefined` until the first successful refresh, and again after a failed one. */
  private grants: EnforcedGrants;
  private passwordSet = false;
  private attempts: UnlockAttemptState = INITIAL_UNLOCK_ATTEMPTS;
  private unlocks: readonly HeldUnlock[] = [];

  constructor(private readonly deps: CapabilityGrantDeps) {}

  /**
   * Re-reads the operator's decision and whether a password exists.
   *
   * Called at boot before the daemon serves, and after every change. It swallows nothing: a failure
   * clears the enforced grants, so the very next request is refused with `undetermined` and a message
   * naming the document, rather than being served from a decision that may no longer be true.
   */
  async refresh(): Promise<void> {
    try {
      const [grants, passwordSet] = await Promise.all([this.deps.document.read(), this.deps.passwords.isSet()]);
      this.grants = grants;
      this.passwordSet = passwordSet;
    } catch (error) {
      this.grants = undefined;
      this.passwordSet = false;
      throw new GrantError(
        'unavailable',
        `this daemon could not read its capability grants, so every governed capability is refused: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The synchronous answer the authorization boundary asks for. */
  decide(demand: CapabilityDemand, presentation: CapabilityPresentation): GrantDecision {
    return decideCapability(demand, this.evaluate(presentation));
  }

  /** The sentence that goes with a refusal, composed here because only this layer knows the client
   *  name a person actually types. */
  explain(demand: CapabilityDemand, refusal: GrantRefusal): string | undefined {
    return describeGrantRefusal(demand, refusal, this.deps.clientName);
  }

  /**
   * What the UI is told, so it can explain a limit BEFORE somebody clicks into it.
   *
   * It reports both axes per capability, what the operator's document says underneath, and the reason
   * each answer reads the way it does — `ungated` among them, so a machine with no operator password
   * can say so plainly beside the controls nothing is standing behind.
   */
  view(presentation: CapabilityPresentation): GrantsView {
    const evaluation = this.evaluate(presentation);
    const now = this.deps.clock.nowMs();
    const held = this.heldUnlock(presentation.unlock, now);
    const capabilities: readonly CapabilityGrantView[] = DAEMON_CAPABILITIES.map(capability =>
      this.capabilityView(capability, evaluation),
    );
    const lockedUntilMs = isUnlockLocked(this.attempts, now) ? this.attempts.lockedUntilMs : undefined;
    return {
      capabilities,
      passwordSet: this.passwordSet,
      unlocked: held !== undefined,
      ...(held === undefined ? {} : { unlockExpiresAt: new Date(held.expiresAtMs).toISOString() }),
      ...(this.passwordSet ? { attemptsRemaining: unlockAttemptsRemaining(this.attempts, now) } : {}),
      ...(lockedUntilMs === undefined ? {} : { lockedUntil: new Date(lockedUntilMs).toISOString() }),
    };
  }

  /**
   * Spends one password attempt.
   *
   * THE RATE LIMIT IS CHECKED FIRST and applies to every caller, including one that would have got
   * the password right: a limiter that let correct guesses through early would leak whether a guess
   * was correct while claiming to be closed.
   *
   * A DAEMON WITH NO PASSWORD REFUSES TO MINT rather than unlocking. Nothing is gated on such a
   * machine, so an unlock would be a token that proves nothing, and handing one out would let a
   * client believe it had passed a check that never happened.
   */
  async unlock(password: string): Promise<UnlockOutcome> {
    const now = this.deps.clock.nowMs();
    if (isUnlockLocked(this.attempts, now))
      return {
        kind: 'refused',
        refusal: { reason: 'rate-limited', attemptsRemaining: 0, ...unlockLockout(this.attempts) },
      };
    if (!this.passwordSet) return { kind: 'refused', refusal: { reason: 'no-password', attemptsRemaining: 0 } };
    if (!(await this.deps.passwords.verify(password))) {
      this.attempts = recordUnlockFailure(this.attempts, now);
      return {
        kind: 'refused',
        refusal: {
          reason: isUnlockLocked(this.attempts, now) ? 'rate-limited' : 'wrong-password',
          attemptsRemaining: unlockAttemptsRemaining(this.attempts, now),
          ...unlockLockout(this.attempts),
        },
      };
    }
    this.attempts = recordUnlockSuccess();
    const token = this.deps.tokens.mint();
    const expiresAtMs = now + GRANT_UNLOCK_TTL_SECONDS * 1_000;
    // Expired unlocks are dropped on every mint rather than by a timer: the list is only read and
    // written here and in `heldUnlock`, so a sweep with no caller would be a timer with no work.
    this.unlocks = [...this.unlocks.filter(unlock => unlock.expiresAtMs > now), { token, expiresAtMs }];
    return { kind: 'unlocked', token, expiresAtMs };
  }

  /**
   * Records a change to the grants themselves.
   *
   * TWO GATES, AND THEY ARE NOT THE SAME GATE.
   *
   * The FIRST is the grant: changing capability X's own grant is a `configure` act on X, so a governed
   * caller must already hold `configure` for every capability the patch names. That is what stops the
   * layer being self-defeating — a UI that may not configure the warden may not grant itself
   * permission to. The host's own command line is ungoverned and skips it.
   *
   * The SECOND is the password, and it applies to WIDENING ONLY, on every path including the host's.
   * Turning an axis on is the one change that hands a remote browser more than it had. Turning one off
   * is what somebody does in an incident, and a password prompt between a person and shutting a door
   * is a liability, so a patch that only narrows is never gated — by the password or by the lockout.
   */
  async patch(patch: GrantsPatch, presentation: CapabilityPresentation): Promise<GrantsView> {
    const current = this.grants;
    if (current === undefined)
      throw new GrantError('unavailable', 'this daemon could not read its capability grants, so it will not change them');
    const evaluation = this.evaluate(presentation);
    if (evaluation.governed) {
      for (const capability of patchedCapabilities(patch)) {
        // The grant alone, deliberately NOT `decideCapability(configure)`: that would demand an unlock
        // for a change that only revokes, and revoking must never be harder than granting.
        const grant = current[capability];
        if (!grant.use || !grant.configure)
          throw new GrantError(
            'forbidden',
            `the operator of this machine has not granted the UI permission to change the ${capability} grant`,
          );
      }
    }
    const next = applyGrantPatch(current, patch);
    const widened = widenedBy(current, next);
    if (widened.length > 0 && this.passwordSet) {
      const now = this.deps.clock.nowMs();
      if (isUnlockLocked(this.attempts, now))
        throw new GrantError(
          'forbidden',
          `too many wrong operator passwords have been tried, so this daemon is not checking any more of them for now; ${widened.join(', ')} cannot be granted until the lockout passes`,
        );
      if (!evaluation.unlockHeld)
        throw new GrantError(
          'forbidden',
          `granting ${widened.join(', ')} needs the operator password on this machine; revoking never does`,
        );
    }
    const changes = grantChanges(current, next);
    await this.deps.document.write(next);
    this.grants = next;
    // AFTER the write, so a record can never claim a change that did not reach the document. A failing
    // audit is not swallowed: a change nobody can see afterwards is the state this exists to prevent.
    await this.deps.audit.record({ actor: presentation.actor, changes, at: new Date(this.deps.clock.nowMs()).toISOString() });
    return this.view(presentation);
  }

  /**
   * Sets or clears the operator password from the HOST.
   *
   * Deliberately not reachable from a governed caller — the mount serves it on a `host` route — so a
   * browser can never rotate or remove the secret that gates it. Every held unlock is dropped: a
   * password that changed must invalidate what the old one bought, or rotating it after a device is
   * lost achieves nothing.
   */
  async setPassword(password: string | undefined): Promise<void> {
    if (password === undefined) await this.deps.passwords.clear();
    else await this.deps.passwords.set(password);
    this.passwordSet = password !== undefined;
    this.attempts = INITIAL_UNLOCK_ATTEMPTS;
    this.unlocks = [];
  }

  /** Whether this machine has the security layer turned on. Never the password itself. */
  hasPassword(): boolean {
    return this.passwordSet;
  }

  /** What the daemon's own reports may say about this subsystem. Never the password itself. */
  enforced(): EnforcedGrants {
    return this.grants;
  }

  private capabilityView(capability: DaemonCapability, evaluation: GrantEvaluation): CapabilityGrantView {
    const use = decideCapability({ capability, axis: 'use' }, evaluation);
    const configure = decideCapability({ capability, axis: 'configure' }, evaluation);
    // The document's own answer travels beside the effective one so a UI can distinguish "you said no"
    // from "you said yes but no unlock is held" without inferring it from two booleans. An
    // undetermined document reports both axes shut, which is what is being enforced.
    const granted = evaluation.grants?.[capability] ?? { use: false, configure: false };
    return {
      capability,
      use: use.allowed,
      configure: configure.allowed,
      granted,
      useRefusal: use.refusal,
      configureRefusal: configure.refusal,
    };
  }

  private evaluate(presentation: CapabilityPresentation): GrantEvaluation {
    const now = this.deps.clock.nowMs();
    return {
      grants: this.grants,
      passwordSet: this.passwordSet,
      unlockHeld: this.heldUnlock(presentation.unlock, now) !== undefined,
      rateLimited: isUnlockLocked(this.attempts, now),
      governed: isGovernedCaller(presentation.loopback),
    };
  }

  /**
   * The unlock a caller is presenting, if this daemon minted it and it has not expired.
   *
   * A BLANK STRING MATCHES NOTHING, checked here rather than trusted to the comparison: a caller that
   * sends the header with no value must not match an entry that somehow arrived empty.
   */
  private heldUnlock(presented: string | undefined, nowMs: number): HeldUnlock | undefined {
    const candidate = presented?.trim();
    if (candidate === undefined || candidate === '') return undefined;
    return this.unlocks.find(unlock => unlock.token === candidate && unlock.expiresAtMs > nowMs);
  }
}

function unlockLockout(state: UnlockAttemptState): { readonly lockedUntilMs?: number } {
  return state.lockedUntilMs === undefined ? {} : { lockedUntilMs: state.lockedUntilMs };
}
