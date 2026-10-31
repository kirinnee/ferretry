import {
  COPY_PLAN_DEFAULT_LIFETIME_SECONDS,
  COPY_PLAN_MAX_ITEMS,
  type CopyPlan,
  type CopyPlanItem,
  type CopyRouteFrom,
  type CopyRouteTo,
} from '@ferretry/protocol';
import { SecureCopyError } from './errors.ts';
import type { PasteRuleCaller, PasteRuleService } from './rules.ts';

/**
 * A FERRET'S PLAN OF PASTES, asked for up front (docs/secure-copy.md): one card listing every paste it means to
 * make. The owner allows some or all of them; each allowed one becomes a rule for that session that allows ONE
 * paste until the plan's expiry. Plans live in RAM: a restart forgets them, and approving a forgotten plan is
 * refused, so the ferret asks again.
 */

/** Plans one session may have waiting at once. */
const MAX_PENDING_PLANS = 3;

export interface CopyPlanCard {
  readonly planId: string;
  readonly ask: string;
  readonly context: string;
  readonly expiresAt: string;
}

/** The agenda, as a plan needs it: raise its card, close it when the plan is settled. */
export interface CopyPlanAgendaPort {
  raise(sessionId: string, card: CopyPlanCard): Promise<{ ok: true; id: string } | { ok: false; message: string }>;
  close(sessionId: string, id: string, note: string): Promise<void>;
}

export interface CopyPlanPorts {
  readonly agenda: CopyPlanAgendaPort;
  readonly rules: Pick<PasteRuleService, 'fromPlan'>;
  /** Tells the ferret how its plan was settled, in words with no value. Total: never rejects. */
  readonly tell: (sessionId: string, agendaId: string, message: string) => Promise<void>;
  readonly clock: { now(): number };
  readonly ids: { planId(): string };
}

export class CopyPlanService {
  private readonly plans = new Map<string, CopyPlan>();
  /** Plans an answer is being recorded for, so a double tap or a retry cannot make their rules twice. */
  private readonly answering = new Set<string>();

  constructor(private readonly ports: CopyPlanPorts) {}

  /** The ferret asks. Nothing in a plan is a value; `why` is its own words and shown as such. */
  async propose(sessionId: string, items: readonly CopyPlanItem[], expiresInSeconds?: number): Promise<CopyPlan> {
    this.sweep();
    if (items.length === 0 || items.length > COPY_PLAN_MAX_ITEMS)
      throw new SecureCopyError('bad_request', `a plan lists 1 to ${String(COPY_PLAN_MAX_ITEMS)} pastes`);
    const waiting = [...this.plans.values()].filter(plan => plan.sessionId === sessionId && plan.state === 'pending');
    if (waiting.length >= MAX_PENDING_PLANS)
      throw new SecureCopyError(
        'capacity',
        `${String(MAX_PENDING_PLANS)} plans are already waiting on the owner; wait for one to be answered`,
      );
    const now = this.ports.clock.now();
    const id = this.ports.ids.planId();
    const expiresAt = new Date(now + (expiresInSeconds ?? COPY_PLAN_DEFAULT_LIFETIME_SECONDS) * 1000).toISOString();
    const card = await this.ports.agenda.raise(sessionId, {
      planId: id,
      ask: `Allow ${items.length === 1 ? 'this paste' : `these ${String(items.length)} pastes`} once each, without asking, until ${expiresAt}?`,
      context: items
        .map((item, index) => `${String(index + 1)}. ${routeOf(item.from, item.to)}. The agent says: ${item.why}`)
        .join('\n'),
      expiresAt,
    });
    if (!card.ok) throw new SecureCopyError('unavailable', card.message);
    const plan: CopyPlan = {
      id,
      sessionId,
      agendaItemId: card.id,
      items: [...items],
      state: 'pending',
      raisedAt: new Date(now).toISOString(),
      expiresAt,
    };
    this.plans.set(id, plan);
    return plan;
  }

  /** The plans still waiting, for one session or all. Owner only. */
  list(caller: PasteRuleCaller, sessionId?: string): readonly CopyPlan[] {
    if (caller.kind !== 'owner') throw new SecureCopyError('forbidden', 'only the owner reads plans to approve');
    this.sweep();
    return [...this.plans.values()].filter(
      plan => plan.state === 'pending' && (sessionId === undefined || plan.sessionId === sessionId),
    );
  }

  /** The owner allows the items it ticked (by index); none declines the plan. Owner only, before anything else. */
  async approve(
    caller: PasteRuleCaller,
    sessionId: string,
    planId: string,
    indices: readonly number[],
  ): Promise<CopyPlan> {
    if (caller.kind !== 'owner')
      throw new SecureCopyError('forbidden', 'only the owner approves a plan; an agent cannot');
    this.sweep();
    const plan = this.plans.get(planId);
    if (plan === undefined || plan.sessionId !== sessionId)
      throw new SecureCopyError('not_found', 'there is no such plan waiting (a daemon restart forgets plans)');
    if (plan.state !== 'pending') throw new SecureCopyError('conflict', `the plan is already ${plan.state}`);
    if (this.answering.has(planId)) throw new SecureCopyError('conflict', 'the plan is already being answered');
    const chosen = [...new Set(indices)].sort((a, b) => a - b);
    if (chosen.some(index => index >= plan.items.length))
      throw new SecureCopyError('bad_request', `the plan has ${String(plan.items.length)} items`);
    this.answering.add(planId);
    try {
      if (chosen.length > 0)
        await this.ports.rules.fromPlan(
          caller,
          sessionId,
          planId,
          chosen.map(index => plan.items[index] as CopyPlanItem),
          Date.parse(plan.expiresAt),
        );
    } finally {
      this.answering.delete(planId);
    }
    const settled: CopyPlan =
      chosen.length === 0 ? { ...plan, state: 'declined' } : { ...plan, state: 'approved', approved: chosen };
    this.plans.set(planId, settled);
    const note =
      chosen.length === 0
        ? 'The owner declined the plan.'
        : `The owner allowed ${chosen.map(index => String(index + 1)).join(', ')} of ${String(plan.items.length)}.`;
    await this.ports.agenda.close(sessionId, plan.agendaItemId, note);
    await this.ports.tell(
      sessionId,
      plan.agendaItemId,
      chosen.length === 0
        ? `${plan.agendaItemId}: the owner declined your paste plan; each paste will ask them.`
        : `${plan.agendaItemId}: ${note} Each allowed paste goes through once with secure.paste, until ${plan.expiresAt}; the rest ask the owner.`,
    );
    return settled;
  }

  /** Ends the plans whose time passed, and forgets settled ones a while later. */
  sweep(): void {
    const now = this.ports.clock.now();
    for (const [id, plan] of this.plans) {
      if (Date.parse(plan.expiresAt) > now) continue;
      if (plan.state === 'pending') {
        this.plans.set(id, { ...plan, state: 'expired' });
        void this.ports.agenda
          .close(plan.sessionId, plan.agendaItemId, 'The paste plan expired.')
          .catch(() => undefined);
      } else this.plans.delete(id);
    }
  }
}

/** "a copy from gh → the vercel program in a terminal", in plain words. */
export function routeOf(from: CopyRouteFrom, to: CopyRouteTo): string {
  const source =
    from.kind === 'command'
      ? `what ${from.program} prints`
      : from.kind === 'browser'
        ? `text from ${from.origin}`
        : `the clipboard of ${from.origin}`;
  const destination =
    to.kind === 'terminal'
      ? `${to.program} in a terminal`
      : to.kind === 'browser'
        ? `a field on ${to.origin}`
        : `the secret ${to.name}`;
  return `${source} → ${destination}`;
}
