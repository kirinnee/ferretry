import type { FerretsApi, FerretSummary } from '@ferretry/core-ferrets/contract';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import { type WardenFleetSession, WARDEN_LABEL, type WardenSessionStatus } from './lib/index.ts';

/** The name a warden's own ferrets carry (`warden-00002a`): the detector's lineage shield reads it. */
export const WARDEN_NAME = /^warden-[0-9a-f]{6}$/u;

const HARNESS_OF: Readonly<Record<string, 'claude' | 'codex'>> = { 'claude-code': 'claude', codex: 'codex' };

interface TurnMemory {
  /** The conversation's own turn id last seen, and the ordinal the sweep counts it as. */
  readonly id: string | undefined;
  readonly ordinal: number;
  readonly endedAt?: string;
}

/**
 * The sweep counts turns (`turn: 3`); Conversation names them (`turn_k3…`). The ordinal is the number of distinct turn
 * ids this daemon has seen for a ferret since it began watching, which is all the liveness track needs: "a new turn
 * starts every clock again".
 */
export class TurnOrdinals {
  private readonly seen = new Map<string, TurnMemory>();

  see(ferret: string, id: string | undefined): number {
    const before = this.seen.get(ferret);
    if (id === undefined || before?.id === id) return before?.ordinal ?? 0;
    const ordinal = (before?.ordinal ?? 0) + 1;
    this.seen.set(ferret, { id, ordinal });
    return ordinal;
  }

  ended(ferret: string, id: string, endedAt: string): void {
    const ordinal = this.see(ferret, id);
    this.seen.set(ferret, { id, ordinal, endedAt });
  }

  endedAt(ferret: string): string | undefined {
    return this.seen.get(ferret)?.endedAt;
  }
}

const statusOf = (ferret: FerretSummary): WardenSessionStatus => {
  switch (ferret.state) {
    case 'starting':
      return 'starting';
    case 'working':
    case 'idle':
      return 'running';
    case 'stopped':
      return 'stopped';
  }
};

/**
 * One ferret as the sweep reads it. Ferrets knows who it is and which of four states it is in; the finer facts today's
 * detector measures (pane frames, token counters, tool processes) are not in the Ferrets contract, so they are absent
 * here and the classifiers that need them stay quiet (declared GAP, `docs/rebuild-ports/warden.md`).
 */
export function wardenFleetSession(
  ferret: FerretSummary,
  turn: number,
  turnEndedAt: string | undefined,
  directory: string,
): WardenFleetSession {
  const isWarden = WARDEN_NAME.test(ferret.name);
  const stoppedAt = ferret.state === 'stopped' ? ferret.stateAt : undefined;
  return {
    config: {
      id: ferret.id,
      // Unattended work is a helper or a pack member; a ferret the owner talks to is never swept for silence.
      mode: ferret.parent !== undefined || ferret.pack !== undefined || isWarden ? 'auto' : 'interactive',
      createdAt: ferret.createdAt,
      updatedAt: ferret.stateAt,
      teammate: ferret.name,
      ...(isWarden ? { label: WARDEN_LABEL, wardenLineage: true } : {}),
      ...(ferret.parent === undefined ? {} : { parent: ferret.parent }),
      agent: ferret.runtime ?? ferret.harness,
      ...(HARNESS_OF[ferret.harness] === undefined ? {} : { harness: HARNESS_OF[ferret.harness] }),
    },
    state: {
      status: statusOf(ferret),
      startedAt: ferret.createdAt,
      ...(stoppedAt === undefined ? { lastActivityAt: ferret.stateAt } : { finishedAt: stoppedAt }),
      turn,
      ...(ferret.state === 'working' ? { turnState: 'working' as const, turnStateAt: ferret.stateAt } : {}),
      ...(ferret.state === 'idle' ? { turnState: 'your-turn' as const, turnStateAt: turnEndedAt ?? ferret.stateAt } : {}),
    },
    directory,
    cwd: ferret.folder,
    turn,
    // Ferrets owns the runner; a ferret it calls running has a live handle by its own account.
    hasLiveMonitor: ferret.state !== 'stopped',
    observedSince: ferret.stateAt,
  };
}

export async function readFleet(
  ferrets: FerretsApi,
  conversation: ConversationApi,
  turns: TurnOrdinals,
  directoryOf: (ferret: string) => string,
): Promise<readonly WardenFleetSession[]> {
  const all = await ferrets.list();
  return await Promise.all(
    all.map(async ferret => {
      const current = ferret.state === 'stopped' ? undefined : await conversation.currentTurn(ferret.id).catch(() => undefined);
      const ordinal = turns.see(ferret.id, current);
      return wardenFleetSession(ferret, ordinal, turns.endedAt(ferret.id), directoryOf(ferret.id));
    }),
  );
}
