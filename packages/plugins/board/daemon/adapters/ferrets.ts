import type { FerretsApi, FerretSummary } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import type {
  FerretFocus,
  FerretLiveness,
  FerretLivenessGuard,
  FerretLivenessSource,
  FerretParents,
  FerretRoster,
  HelperDirectory,
} from '../lib/board/index.ts';
import type { SerialRun } from '../lib/lanes/serial.ts';

const asId = (ferret: string): FerretId => ferret as FerretId;

/** Who started whom: `FerretsApi.get(ferret).parent`. A ferret that cannot be read has no parent here. */
export class FerretsParents implements FerretParents {
  constructor(private readonly ferrets: Pick<FerretsApi, 'get'>) {}

  async parentOf(ferret: string): Promise<string | undefined> {
    return (await this.ferrets.get(asId(ferret)))?.parent;
  }
}

/** Who started whom, and what `fy send` takes to reach a ferret: its name when it has one, else its id. */
export class FerretsHelpers implements HelperDirectory {
  constructor(private readonly ferrets: Pick<FerretsApi, 'get'>) {}

  async leadOf(ferret: string): Promise<string | undefined> {
    return (await this.ferrets.get(asId(ferret)).catch(() => undefined))?.parent;
  }

  async addressOf(ferret: string): Promise<string> {
    const found = await this.ferrets.get(asId(ferret)).catch(() => undefined);
    return found?.name ?? ferret;
  }
}

const livenessOf = async (summary: FerretSummary, focus: Pick<FerretFocus, 'focusOf'>): Promise<FerretLiveness> => ({
  id: summary.id,
  status: summary.state,
  focusCard: await focus.focusOf(summary.id).catch(() => null),
  declaredWait: false,
  ...(summary.parent === undefined ? {} : { lead: summary.parent }),
  configRead: true,
  lastActivityAt: summary.stateAt,
});

/**
 * The ferrets as the board's one liveness read. Ferrets reports a state (starting, working, idle, stopped), a parent
 * and when the state last changed; the finer signals today's roster carried (token advance, transcript, subprocess
 * times, a declared wait, the turn state) are not in its contract, so they read as absent and a ferret is judged by
 * its state alone (GAP: see the report).
 */
export class FerretsLiveness implements FerretLivenessSource, FerretLivenessGuard {
  constructor(
    private readonly ferrets: Pick<FerretsApi, 'list' | 'get'>,
    private readonly focus: Pick<FerretFocus, 'focusOf'>,
    private readonly serial: SerialRun,
  ) {}

  async roster(): Promise<FerretRoster> {
    const all = await this.ferrets.list();
    const sessions = new Map<string, FerretLiveness>();
    for (const summary of all) sessions.set(summary.id, await livenessOf(summary, this.focus));
    return { held: new Set(sessions.keys()), sessions };
  }

  /**
   * Ferrets exposes no way to hold a ferret still, so this serializes the board's own decisions that rest on a roster
   * and reads the named ferrets fresh inside that section: the board cannot race itself, a ferret's own end still can
   * (GAP: a hold in the Ferrets contract would close it).
   */
  async settled<T>(ids: readonly string[], work: (fresh: FerretRoster) => Promise<T>): Promise<T> {
    return await this.serial.run('board:liveness', async () => {
      const sessions = new Map<string, FerretLiveness>();
      const held = new Set<string>();
      for (const id of ids) {
        const summary = await this.ferrets.get(asId(id)).catch(() => undefined);
        if (summary === undefined) continue;
        held.add(id);
        sessions.set(id, await livenessOf(summary, this.focus));
      }
      return await work({ held, sessions });
    });
  }
}
