import type { AccountId, AccountKey, GrantMissReason, LoginFieldRole, SignInField } from '@ferretry/protocol';
import type { ApprovedSignInLine } from '../task-plans/service.ts';
import type { SignInGrantLedger } from './ledger.ts';
import { NO_SCRIPTED_ORIGINS, type ScriptedOriginsView, type SignInGrant } from './matcher.ts';

/**
 * TASK-PLAN LINES AS GRANTS (R3a): the owner's ticked sign-in lines, read from the plan service, as the shared matcher
 * reads a grant. A standing rule (`rules.ts`) is another source of the same {@link SignInGrant}; the matcher, the ONE
 * ledger (injected, so neither source forgets the other's attempts or pins), the clear and the reasons are shared.
 */

/** The plan service, as the fills need it: its ticked lines, and where a fill writes back what it spent or stopped. */
export interface PlanGrantLines {
  signInLines(sessionId: string): readonly ApprovedSignInLine[];
  signInLineHeld(planId: string, line: number): boolean;
  lineUsed(planId: string, line: number, at: number): void;
  lineStopped(planId: string, line: number, because: GrantMissReason): Promise<void>;
}

/** What a grant's last check before typing reads, beside the grant itself: who asks, from where, typing what. */
export interface GrantFillAt {
  readonly sessionId: string;
  /** The session's stamped board project, as the fill's sighting read it. */
  readonly project: string | undefined;
  readonly roles: readonly LoginFieldRole[];
  readonly now: number;
}

/** A grant checked again right before its write: still good, or why not (`reason` absent: it could not be told). */
export type GrantVerdict = { readonly ok: true } | { readonly ok: false; readonly reason?: GrantMissReason };

/** What the input service asks of the grants: which apply to a session, an account's key, and the writes back. */
export interface SignInGrantSource {
  /**
   * Whether grant fills run at all. A grant fill closes the card itself, and an app that can't show that would refuse
   * the request list, so fills wait until the daemon advertises the source's feature (`task-plan.1`,
   * `sign-in-rules.1`): the app ships first.
   */
  enabled(): boolean;
  /** The grants that are about a sign-in in this session: in force, spent or stopped, the soonest to expire first. */
  of(sessionId: string): readonly SignInGrant[];
  /** An account's immutable key now, or nothing when the store can't say. */
  keyOf(account: AccountId): Promise<AccountKey | undefined>;
  readonly ledger: SignInGrantLedger;
  /** A fill opened a new attempt: one use of the grant is spent, in `sessionId`. */
  used(grant: SignInGrant, at: number, sessionId: string): void;
  /** A miss that stops the grant: every later fill under it asks. */
  stopped(grant: SignInGrant, because: GrantMissReason): Promise<void>;
  /**
   * Checks a grant again, with I/O, right before the second match (a standing rule's stored proof and pinned facts).
   * A plan line has nothing more to check.
   */
  verify(grant: SignInGrant): Promise<GrantVerdict>;
  /**
   * The LAST check before typing, synchronous (it runs as `held()` / `proceed()`, with nothing awaited before the
   * write): whatever the source alone knows about the grant still holds. A plan line's state is read by the caller.
   */
  holds(grant: SignInGrant, at: GrantFillAt): boolean;
  /** The session's STAMPED board project (a rule's project scope), or nothing. Never resolved from a folder. */
  projectOf(sessionId: string): Promise<string | undefined>;
  /** Where page scripts ran across the machine (a rule's check 15b). */
  scriptedOrigins(): ScriptedOriginsView;
}

const grantIdOf = (planId: string, line: number): string => `plan:${planId}:${String(line)}`;

/** One ticked line as a grant: its own session, its pinned account, place, recipe and form, and its uses left. */
export function planGrantOf(line: ApprovedSignInLine): SignInGrant {
  return {
    id: grantIdOf(line.planId, line.line),
    source: 'plan',
    plan: { id: line.planId, line: line.line },
    sessionId: line.sessionId,
    surface: line.kind === 'sign-in' ? 'page' : 'terminal',
    signIn: line.signIn,
    accountKey: line.pins.accountKey,
    fields: new Set(line.fields as readonly SignInField[]),
    pins: {
      placeKeys: line.pins.placeKeys,
      recipeVersion: line.pins.recipeVersion,
      identities: line.pins.identities,
    },
    expiresAt: line.expiresAt,
    state: line.state === 'approved' ? 'in-force' : line.state,
    remaining: line.remaining,
  };
}

/** The task-plan lines of every session, as grants, with the shared ledger for their uses, attempts, pins and rate. */
export class PlanSignInGrants implements SignInGrantSource {
  constructor(
    private readonly plans: PlanGrantLines,
    private readonly keys: (account: AccountId) => Promise<AccountKey | undefined>,
    private readonly advertised: () => boolean,
    readonly ledger: SignInGrantLedger,
  ) {}

  enabled(): boolean {
    return this.advertised();
  }

  of(sessionId: string): readonly SignInGrant[] {
    // A grant's attempts and pins die with it: a line no longer held is forgotten here.
    this.ledger.retain(id => {
      // Only this source's own grants: the standing rules sharing the ledger keep their attempts and pins.
      if (!id.startsWith('plan:')) return true;
      const [, planId, line] = id.split(':');
      return planId !== undefined && line !== undefined && this.plans.signInLineHeld(planId, Number(line));
    });
    return this.plans
      .signInLines(sessionId)
      .map(planGrantOf)
      .toSorted((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id));
  }

  async keyOf(account: AccountId): Promise<AccountKey | undefined> {
    return await this.keys(account).catch(() => undefined);
  }

  used(grant: SignInGrant, at: number, _sessionId: string): void {
    if (grant.plan !== undefined) this.plans.lineUsed(grant.plan.id, grant.plan.line, at);
  }

  async stopped(grant: SignInGrant, because: GrantMissReason): Promise<void> {
    if (grant.plan !== undefined)
      await this.plans.lineStopped(grant.plan.id, grant.plan.line, because).catch(() => undefined);
  }

  /** A plan line is approved for this session only, in RAM: there is no stored proof to check again. */
  async verify(_grant: SignInGrant): Promise<{ readonly ok: true }> {
    return { ok: true };
  }

  /** The line's state is what the input service reads before the write; the plan knows nothing more. */
  holds(_grant: SignInGrant, _at: { readonly roles: readonly LoginFieldRole[] }): boolean {
    return true;
  }

  /** A plan line is bound to its session: no scope to read. */
  async projectOf(_sessionId: string): Promise<string | undefined> {
    return undefined;
  }

  /** The session-wide script taint covers a plan line (check 15); the machine-wide one is a rule's (15b). */
  scriptedOrigins(): ScriptedOriginsView {
    return NO_SCRIPTED_ORIGINS;
  }
}
