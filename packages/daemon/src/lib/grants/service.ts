import {
  type CapabilityGrantView,
  DAEMON_CAPABILITIES,
  type DaemonCapability,
  GRANT_UNLOCK_TTL_SECONDS,
  type GrantAuditView,
  type GrantRefusal,
  type GrantsPatch,
  type GrantsView,
} from '@ferretry/protocol';
import type {
  CallerGovernance,
  CapabilityDemand,
  CapabilityGuard,
  CapabilityPresentation,
  ChangeConfirmation,
  GrantDecision,
} from '../api/capability.ts';
import {
  applyGrantPatch,
  type CallerArrival,
  decideCapability,
  describeGrantRefusal,
  type GrantEvaluation,
  grantChanges,
  INITIAL_UNLOCK_ATTEMPTS,
  isGovernedCaller,
  isUnlockLocked,
  mayChangeOperatorPassword,
  patchedCapabilities,
  recordUnlockFailure,
  recordUnlockSuccess,
  requiresChangeConfirmation,
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
  /** Which capabilities the document actually names, for the provenance column. */
  private writtenDown: readonly DaemonCapability[] = [];
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
      const [grants, written, passwordSet] = await Promise.all([
        this.deps.document.read(),
        this.deps.document.written(),
        this.deps.passwords.isSet(),
      ]);
      this.grants = grants;
      this.writtenDown = written;
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

  /**
   * Where this caller stands relative to the gate, for a handler that must honour or render it.
   *
   * Built from the SAME `evaluate` every decision above uses, so a route that asks for one more step
   * can never be reasoning about a different caller than the one the boundary just allowed.
   */
  governance(presentation: CapabilityPresentation): CallerGovernance {
    const evaluation = this.evaluate(presentation);
    return {
      governed: evaluation.governed,
      passwordSet: evaluation.passwordSet,
      confirmChange: requiresChangeConfirmation(evaluation, evaluation.governed),
      // The SAME evaluation, captured once, rather than a fresh one per question: two reads of the
      // clock inside one request could straddle an unlock's expiry and answer one axis as unlocked
      // and the next as locked, which is a request describing two different callers.
      decide: demand => decideCapability(demand, evaluation),
    };
  }

  /**
   * Proves the operator password for ONE change, spending one attempt and minting NOTHING.
   *
   * ## IT SHARES THE UNLOCK'S LEDGER, DELIBERATELY
   *
   * A separate budget here would hand an attacker a fresh five tries for every surface that asked,
   * which is the exact reasoning `UnlockAttemptState` already records for keying the ledger per
   * daemon rather than per caller. So a wrong confirmation costs one of the same five, and the same
   * fifteen-minute lockout follows. The rate limit is checked FIRST and applies to a caller that
   * would have got it right, for the same reason it does in {@link unlock}: a limiter that let
   * correct guesses through early would leak whether a guess was correct while claiming to be closed.
   *
   * ## IT MINTS NO TOKEN, AND THAT IS THE DIFFERENCE FROM `unlock`
   *
   * An unlock is a bearer value good for five minutes and any number of `configure` demands. This is
   * spent inside the one request that carries it and leaves nothing behind, which is what makes it
   * bind to a single change rather than open a window.
   */
  async confirmChange(password: string): Promise<ChangeConfirmation> {
    const now = this.deps.clock.nowMs();
    if (isUnlockLocked(this.attempts, now)) return { kind: 'refused', reason: 'rate-limited' };
    // A machine with no password has nothing to confirm against. Reporting this rather than passing
    // is what stops a caller believing it cleared a check that never ran — the same reason `unlock`
    // refuses to mint on such a machine instead of handing out a token that proves nothing.
    if (!this.passwordSet) return { kind: 'refused', reason: 'no-password' };
    if (!(await this.deps.passwords.verify(password))) {
      this.attempts = recordUnlockFailure(this.attempts, now);
      return { kind: 'refused', reason: isUnlockLocked(this.attempts, now) ? 'rate-limited' : 'wrong-password' };
    }
    this.attempts = recordUnlockSuccess();
    return { kind: 'confirmed' };
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
      // Projected, never re-derived: it is the same `isGovernedCaller` answer every decision above was
      // made with, so a view can never disagree with the enforcement it describes.
      governed: evaluation.governed,
      // The SECOND, independent fact. A local browser that has not unlocked is governed AND on this
      // host, so a screen needs both to say which sentence is true; collapsing them would tell somebody
      // at the machine they were remote the moment their unlock expired.
      hostLocal: evaluation.hostLocal,
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
   * ## WIDENING AND NARROWING ARE NOT THE SAME ACT, AND THEY ARE NOT GATED THE SAME WAY
   *
   * Turning an axis ON hands a remote caller more than it had. Turning one OFF is what somebody does
   * during an incident, and a password prompt between a person and shutting a door is a liability —
   * so revoking is never harder than granting, and a patch that only narrows is never gated by the
   * password or by the lockout.
   *
   * ## WIDENING IS A LOCAL ACT. THERE IS NO REMOTE PATH TO IT AT ALL.
   *
   * A governed caller may never turn a capability ON — not with the operator password, not with a
   * valid unlock, not ever. Locality is the boundary, and this is the whole of it: a stolen phone
   * cannot grant itself anything, so the worst it can do is narrow the machine's own permissions.
   *
   * THIS REPLACED A PASSWORD GATE, and it is strictly stronger. The password used to be what stood
   * between a remote caller and widening, which meant the security of the model rested on a secret a
   * person chose. Now it rests on where the socket came from, which nothing a caller sends can move.
   *
   * IT IS A ONE-WAY DOOR AND THAT IS SAID OUT LOUD. An operator who switches something off from a
   * phone cannot switch it back on from that phone — the refusal names the remedy exactly, and the
   * grant view carries `mayGrant` so a UI can say so BEFORE somebody walks through the door rather
   * than after.
   *
   * ## THE PATCH IS ALL OR NOTHING
   *
   * A patch that widens one capability and narrows another is refused ENTIRELY. Applying the safe half
   * would leave the operator with a machine in a state they did not ask for and did not get told
   * about, which is worse than either outcome — and the refusal would be indistinguishable from a
   * total one. `next` is computed before anything is written, so this holds by construction.
   *
   * ## NARROWING
   *
   * A governed caller that has NOT proved the password must already hold `configure` on every
   * capability it names. That is what stops the layer being self-defeating: a UI the operator has
   * excluded from warden configuration cannot quietly rewrite the warden grant. A caller that HAS
   * proved the password is the operator, so the per-capability gate has nothing left to add.
   */
  async patch(patch: GrantsPatch, presentation: CapabilityPresentation): Promise<GrantsView> {
    const current = this.grants;
    if (current === undefined)
      throw new GrantError(
        'unavailable',
        'this daemon could not read its capability grants, so it will not change them',
      );
    const evaluation = this.evaluate(presentation);
    const next = applyGrantPatch(current, patch);
    const widened = widenedBy(current, next);
    // Computed over the WHOLE patch and refused before anything is written, so a mixed patch takes
    // neither half. The password is deliberately not consulted: it cannot buy this.
    if (widened.length > 0 && !evaluation.hostLocal)
      throw new GrantError(
        'forbidden',
        `${widened.join(', ')} can only be turned on from the machine itself — no remote caller may, with or without the operator password. Run \`${this.deps.clientName} daemon config set ${widened[0]?.split('.')[0] ?? 'fleet'} --${widened[0]?.split('.')[1] ?? 'use'}\` on the host.`,
      );
    // ON the host and still governed means a local browser that has not unlocked yet. Its remedy is the
    // password, NOT the sentence above: telling somebody standing at the machine that only the machine
    // may do this is the dead end this surface exists to remove. The way back is named for the reader
    // who does not have the password either, because this is the point they would get stuck at.
    if (widened.length > 0 && evaluation.governed)
      throw new GrantError(
        'forbidden',
        `turning ${widened.join(', ')} on needs this machine's operator password — enter it to unlock, and the change goes through. If you do not have it, replace it on this machine with \`${this.deps.clientName} daemon password set\`, which never asks for the old one.`,
      );
    if (evaluation.governed && !evaluation.unlockHeld) {
      for (const capability of patchedCapabilities(patch)) {
        // The grant alone, deliberately NOT `decideCapability(configure)`: that would demand an unlock
        // for a change that only revokes, and revoking must never be harder than granting.
        const grant = current[capability];
        if (!grant.use || !grant.configure)
          throw new GrantError(
            'forbidden',
            // TWO READERS, TWO REMEDIES. Off the host, the document is the answer and the operator is
            // somebody else. ON the host, the reader IS the operator: telling them their own document
            // refuses them, when entering the password they already have would let it through, sends them
            // to edit a file for a limit that was never theirs.
            evaluation.hostLocal
              ? `changing the ${capability} grant needs this machine's operator password, because the document does not grant the UI permission to change it. Enter it to unlock, or replace it on this machine with \`${this.deps.clientName} daemon password set\`, which never asks for the old one.`
              : `the operator of this machine has not granted the UI permission to change the ${capability} grant`,
          );
      }
    }
    const changes = grantChanges(current, next);
    await this.deps.document.write(next);
    this.grants = next;
    // AFTER the write, so a record can never claim a change that did not reach the document. A failing
    // audit is not swallowed: a change nobody can see afterwards is the state this exists to prevent.
    await this.deps.audit.record({
      actor: presentation.actor,
      changes,
      at: new Date(this.deps.clock.nowMs()).toISOString(),
    });
    return this.view(presentation);
  }

  /**
   * Sets or replaces the operator password. LOCAL ONLY, and only past the gate.
   *
   * ## THERE IS NO REMOVAL, AND THAT ASYMMETRY IS DELIBERATE
   *
   * This once accepted an absent password as "remove it". Removal revokes no device, so a machine that
   * had paired one — and `PairingService.mint` refuses to pair without a password, so every paired
   * machine had one — was left with paired devices and nothing in front of them. Setting a password is
   * therefore ONE-WAY. The cost is accepted knowingly: somebody who sets one and pairs nothing has no
   * route back to a passwordless machine and unlocks to change local settings from a browser.
   *
   * ## THE HOST'S COMMAND LINE MAY ALWAYS DO THIS, AND THAT IS THE ESCAPE HATCH
   *
   * A local browser needs an unlock here, exactly as it needs one to change a grant — otherwise the
   * gate would be one tap wide and would buy nothing. But that alone would let a FORGOTTEN password
   * brick a machine forever: no remote path, no local path, nothing. So the admin token is ungoverned
   * (`isGovernedCaller`) and `fy daemon password set` never asks for the old one. That door is
   * load-bearing and must stay open; a change that closes it produces the one outcome this design says
   * must never occur.
   *
   * A remote caller never arrives here at all — the route is `privilegedOnly` — so this check is about
   * WHICH local caller, not about locality.
   *
   * Every held unlock is dropped: a password that changed must invalidate what the old one bought, or
   * rotating it after a device is lost achieves nothing.
   */
  async setPassword(password: string, presentation: CapabilityPresentation): Promise<void> {
    const held = this.heldUnlock(presentation.unlock, this.deps.clock.nowMs()) !== undefined;
    if (!mayChangeOperatorPassword(this.arrival(presentation, held)))
      throw new GrantError(
        'forbidden',
        `changing this machine's operator password needs the password it already has — enter it to unlock first. If you do not have it, replace it from a terminal on this machine with \`${this.deps.clientName} daemon password set\`, which never asks for the old one.`,
      );
    await this.deps.passwords.set(password);
    this.passwordSet = true;
    this.attempts = INITIAL_UNLOCK_ATTEMPTS;
    this.unlocks = [];
  }

  /** Whether this machine has the security layer turned on. Never the password itself. */
  hasPassword(): boolean {
    return this.passwordSet;
  }

  /**
   * Who changed what, most recent first.
   *
   * IT IS NOT GATED ON THE GRANTS IT REPORTS. A caller refused a capability is exactly the caller who
   * needs to know when and by whom it was refused — gating the history behind the decision would make
   * the answer unreachable to the only person asking the question. It discloses actors and axes; no
   * credential and nothing about the password has ever been written to that file.
   */
  async history(limit: number): Promise<GrantAuditView> {
    const reading = await this.deps.audit.recent(limit);
    return {
      entries: reading.entries.map(entry => ({ at: entry.at, actor: entry.actor, changes: entry.changes })),
      unreadable: reading.unreadable,
      truncated: reading.truncated,
    };
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
      // LOCALITY decides it, and nothing else can: no caller off this host ever widens. It is
      // deliberately not `!governed` any more — a local browser waiting to unlock is governed and may
      // still widen once it has, and reporting `false` there would call a door one-way that is not.
      mayGrant: evaluation.hostLocal,
      origin: this.writtenDown.includes(capability) ? 'config file' : 'default',
    };
  }

  private evaluate(presentation: CapabilityPresentation): GrantEvaluation {
    const now = this.deps.clock.nowMs();
    const unlockHeld = this.heldUnlock(presentation.unlock, now) !== undefined;
    return {
      grants: this.grants,
      passwordSet: this.passwordSet,
      unlockHeld,
      rateLimited: isUnlockLocked(this.attempts, now),
      governed: isGovernedCaller(this.arrival(presentation, unlockHeld)),
      hostLocal: presentation.loopback,
    };
  }

  /**
   * The four facts governance reads, gathered in ONE place.
   *
   * Assembled here rather than at each question so `decide`, `view`, `patch` and `setPassword` cannot
   * come to different answers about the same request — a view that disagreed with the enforcement it
   * describes is the defect this whole surface is written to avoid.
   */
  private arrival(presentation: CapabilityPresentation, unlockHeld: boolean): CallerArrival {
    return {
      loopback: presentation.loopback,
      adminToken: presentation.adminToken,
      passwordSet: this.passwordSet,
      unlockHeld,
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
