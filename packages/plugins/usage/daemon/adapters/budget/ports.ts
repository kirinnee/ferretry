/**
 * What the spend budgets read and remember on this machine (docs/budgets.md): which ferrets are running on which login,
 * and which pauses and hard-limit notices are already on record. A ferret's login is the one Ferrets says it started on;
 * nothing is read from a session store, a transcript or another plugin's files.
 */
import type { FerretsApi, FerretSummary } from '@ferretry/core-ferrets/contract';
import { PAUSE_TOLD_STATE, PAUSES_STATE } from '../../../contract/index.ts';
import type { Pause } from '../../../contract/index.ts';
import type { BudgetSession } from '../../lib/budget/service.ts';
import type { MeteredFerret } from '../../lib/budget/meter.ts';
import type { StatePort } from '@ferretry/kernel/contract';
import { epochMs } from '@ferretry/std';

const RUNNING = new Set<string>(['starting', 'working', 'idle']);

const isRunning = (ferret: FerretSummary): boolean => RUNNING.has(ferret.state);

/** The ferrets the budgets meter and stop, over the Ferrets port. */
export class FerretBudgetSessions {
  constructor(private readonly ferrets: Pick<FerretsApi, 'list' | 'stop'>) {}

  /** Every ferret that may have run since `sinceMs`: running now, or changed since then. */
  async metered(sinceMs: number): Promise<readonly MeteredFerret[]> {
    const all = await this.ferrets.list();
    return all
      .filter(ferret => isRunning(ferret) || epochMs(ferret.stateAt) >= sinceMs)
      .map(ferret => ({ id: ferret.id, login: ferret.login ?? null }));
  }

  /** The running ferrets whose login is one of `logins`. */
  async live(logins: ReadonlySet<string>): Promise<readonly BudgetSession[]> {
    const all = await this.ferrets.list();
    return all
      .filter(ferret => isRunning(ferret) && ferret.login !== undefined && logins.has(ferret.login))
      .map(ferret => ({ id: ferret.id, name: ferret.name, agent: ferret.login as string }));
  }

  /** The ferret most recently active on `logins`. */
  async recent(logins: ReadonlySet<string>): Promise<BudgetSession | undefined> {
    const all = await this.ferrets.list();
    const newest = all
      .filter(ferret => ferret.login !== undefined && logins.has(ferret.login))
      .toSorted((left, right) => epochMs(right.stateAt) - epochMs(left.stateAt))[0];
    return newest === undefined ? undefined : { id: newest.id, name: newest.name, agent: newest.login as string };
  }

  /** Stops a ferret at its hard limit: politely, so its turn is saved. Ferrets' own stop; nothing here ends a process. */
  async stop(session: BudgetSession): Promise<void> {
    await this.ferrets.stop(session.id as FerretSummary['id'], 'polite');
  }
}

/** The pauses last published, kept so a restart starts from them. A damaged file reads as none; the first tick re-measures. */
export class PausesStore {
  constructor(private readonly state: StatePort) {}

  async read(): Promise<Readonly<Record<string, Pause>>> {
    const read = await this.state.read(PAUSES_STATE);
    return read.ok && read.value !== undefined ? read.value.pauses : {};
  }

  async write(pauses: Readonly<Record<string, Pause>>): Promise<void> {
    await this.state.write(PAUSES_STATE, { pauses: { ...pauses } });
  }
}

/** Which hard limits the owner was told about. A damaged record throws; the service keeps its own in-process record so one notice is never one a minute. */
export class ToldStore {
  constructor(private readonly state: StatePort) {}

  async read(): Promise<readonly string[]> {
    const read = await this.state.read(PAUSE_TOLD_STATE);
    if (!read.ok) throw new Error('the record of told budgets is damaged');
    return read.value?.told ?? [];
  }

  async write(keys: readonly string[]): Promise<void> {
    await this.state.write(PAUSE_TOLD_STATE, { told: [...keys] });
  }
}
