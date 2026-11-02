import type { AgendaId, BoardTaskId, TidyPlan } from '@ferretry/protocol';
import { refuse } from '../tasks/errors';
import type { ITidyAgenda, ITidyCards, ITidyOutput, ITidyPlanGateway } from './ports';
import { renderApplied, renderDryRun, type TidyOutcome, type TidyResult } from './render';

export interface TidyFlags {
  readonly yes?: boolean | undefined;
  readonly reason?: string | undefined;
  readonly json?: boolean | undefined;
  readonly session?: string | undefined;
}

export interface TidyDependencies {
  readonly plans: ITidyPlanGateway;
  readonly cards: ITidyCards;
  readonly agenda: ITidyAgenda;
  readonly output: ITidyOutput;
  readonly binary: string;
  /** `FY_SESSION_ID`: the ferret this process is, when it is one. */
  readonly environmentSessionId: string | undefined;
}

const DEFAULT_REASON = 'tidy: the board is opt-in and this only tracked work';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * `fy tidy`: a ferret drops its own unwanted cards and closes its own work-tracking agenda items. The daemon
 * decides; this applies the plan with the same card drop and agenda "done" the ferret could type itself,
 * one by one, and says each failure without stopping.
 */
export class TidyController {
  constructor(private readonly deps: TidyDependencies) {}

  async tidy(flags: TidyFlags): Promise<void> {
    const typed = flags.session?.trim();
    const as = typed !== undefined && typed !== '' ? typed : this.deps.environmentSessionId;
    if (as === undefined || as === '') {
      return refuse(
        `${this.deps.binary} tidy tidies the ferret that runs it: run it inside a ferret's own pane, or pass --session <id>`,
      );
    }
    const reason = flags.reason?.trim();
    if (flags.reason !== undefined && (reason === undefined || reason === '')) {
      return refuse('--reason needs words: why these are being tidied');
    }
    const plan = await this.deps.plans.plan(as);
    if (plan === undefined) {
      return refuse(
        `this machine's daemon is older than ${this.deps.binary} tidy and cannot plan it: update it with ${this.deps.binary} daemon update`,
      );
    }
    if (flags.yes !== true) {
      return this.deps.output.success(
        flags.json === true ? JSON.stringify({ applied: false, plan }, null, 2) : renderDryRun(plan, this.deps.binary),
      );
    }
    const result = await this.apply(plan, as, reason ?? DEFAULT_REASON);
    this.deps.output.success(
      flags.json === true ? JSON.stringify({ applied: true, plan, result }, null, 2) : renderApplied(plan, result),
    );
    const failed = [...result.dropped, ...result.closed].filter(outcome => outcome.error !== undefined).length;
    if (failed > 0) refuse(`${String(failed)} change(s) failed; the rest were applied (see above)`);
  }

  private async apply(plan: TidyPlan, as: string, reason: string): Promise<TidyResult> {
    const dropped: TidyOutcome[] = [];
    for (const each of plan.drop) dropped.push(await this.drop(as, each.id, each.title, reason));
    const closed: TidyOutcome[] = [];
    for (const each of plan.close) closed.push(await this.close(as, each.id, each.subject, reason));
    return { dropped, closed };
  }

  private async drop(as: string, id: BoardTaskId, title: string, reason: string): Promise<TidyOutcome> {
    try {
      await this.deps.cards.act(as, id, { action: 'drop', reason });
      return { reference: `&${id}`, title };
    } catch (error) {
      return { reference: `&${id}`, title, error: messageOf(error) };
    }
  }

  private async close(as: string, id: AgendaId, title: string, reason: string): Promise<TidyOutcome> {
    try {
      await this.deps.agenda.apply(as, { action: 'resolve', id, note: reason });
      return { reference: `!${id}`, title };
    } catch (error) {
      return { reference: `!${id}`, title, error: messageOf(error) };
    }
  }
}
