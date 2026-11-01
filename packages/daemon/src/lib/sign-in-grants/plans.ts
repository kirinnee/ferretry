import type { AccountId, AccountKey, GrantMissReason, SignInField } from '@ferretry/protocol';
import type { ApprovedSignInLine } from '../task-plans/service.ts';
import { SignInGrantLedger } from './ledger.ts';
import type { SignInGrant } from './matcher.ts';

/**
 * TASK-PLAN LINES AS GRANTS (R3a): the owner's ticked sign-in lines, read from the plan service, as the shared matcher
 * reads a grant. A standing rule (R3c) is another source of the same {@link SignInGrant}; the matcher, the ledger, the
 * clear and the reasons are shared.
 */

/** The plan service, as the fills need it: its ticked lines, and where a fill writes back what it spent or stopped. */
export interface PlanGrantLines {
  signInLines(sessionId: string): readonly ApprovedSignInLine[];
  signInLineHeld(planId: string, line: number): boolean;
  lineUsed(planId: string, line: number, at: number): void;
  lineStopped(planId: string, line: number, because: GrantMissReason): Promise<void>;
}

/** What the input service asks of the grants: which apply to a session, an account's key, and the writes back. */
export interface SignInGrantSource {
  /**
   * Whether grant fills run at all. A plan fill closes the card itself, and an app that can't show that would refuse
   * the request list, so fills wait until the daemon advertises `task-plan.1` (the app ships first).
   */
  enabled(): boolean;
  /** The grants that are about a sign-in in this session: in force, spent or stopped, the soonest to expire first. */
  of(sessionId: string): readonly SignInGrant[];
  /** An account's immutable key now, or nothing when the store can't say. */
  keyOf(account: AccountId): Promise<AccountKey | undefined>;
  readonly ledger: SignInGrantLedger;
  /** A fill opened a new attempt: one use of the grant is spent. */
  used(grant: SignInGrant, at: number): void;
  /** A miss that stops the grant: every later fill under it asks. */
  stopped(grant: SignInGrant, because: GrantMissReason): Promise<void>;
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

/** The task-plan lines of every session, as grants, with one ledger for their uses, attempts, pins and rate. */
export class PlanSignInGrants implements SignInGrantSource {
  readonly ledger = new SignInGrantLedger();

  constructor(
    private readonly plans: PlanGrantLines,
    private readonly keys: (account: AccountId) => Promise<AccountKey | undefined>,
    private readonly advertised: () => boolean,
  ) {}

  enabled(): boolean {
    return this.advertised();
  }

  of(sessionId: string): readonly SignInGrant[] {
    // A grant's attempts and pins die with it: a line no longer held is forgotten here.
    this.ledger.retain(id => {
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

  used(grant: SignInGrant, at: number): void {
    if (grant.plan !== undefined) this.plans.lineUsed(grant.plan.id, grant.plan.line, at);
  }

  async stopped(grant: SignInGrant, because: GrantMissReason): Promise<void> {
    if (grant.plan !== undefined)
      await this.plans.lineStopped(grant.plan.id, grant.plan.line, because).catch(() => undefined);
  }
}
