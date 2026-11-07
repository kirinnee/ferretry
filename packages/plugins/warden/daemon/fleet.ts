import type { AsksApi } from '@ferretry/core-asks/contract';
import type { FerretsApi, FerretSummary } from '@ferretry/core-ferrets/contract';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import type { WardenFleetSession, WardenSessionStatus } from './lib/index.ts';

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
 * here and the classifiers that need them stay quiet (declared GAP, listed on `daemon/index.ts`).
 */
export function wardenFleetSession(
  ferret: FerretSummary,
  turn: number,
  turnEndedAt: string | undefined,
  directory: string,
  questionSince?: string,
): WardenFleetSession {
  const stoppedAt = ferret.state === 'stopped' ? ferret.stateAt : undefined;
  return {
    // Today's mapping (`fyd.ts` wardenFleetSession), field for field from what Ferrets records: the start's own mode,
    // its label (a warden is `label === WARDEN_LABEL`), the spawn stamp's lineage and the model. Nothing is read off
    // the name, so a ferret the owner called `warden-0000aa` is supervised like any other.
    config: {
      id: ferret.id,
      // A record without a mode is read as a person's terminal: never swept for silence, never acted on alone.
      mode: ferret.mode ?? 'interactive',
      createdAt: ferret.createdAt,
      updatedAt: ferret.stateAt,
      teammate: ferret.name,
      ...(ferret.label === undefined ? {} : { label: ferret.label }),
      ...(ferret.parent === undefined ? {} : { parent: ferret.parent }),
      // A projection of the spawn stamp: the detector's lineage shield survives the warden being pruned first.
      ...(ferret.provenance === undefined ? {} : { wardenLineage: ferret.provenance.wardenLineage }),
      agent: ferret.runtime ?? ferret.harness,
      ...(HARNESS_OF[ferret.harness] === undefined ? {} : { harness: HARNESS_OF[ferret.harness] }),
      ...(ferret.model === undefined ? {} : { model: ferret.model }),
    },
    state: {
      // A ferret with a question open on its board is waiting on someone (`unattended_question` measures how long).
      status: questionSince !== undefined && ferret.state !== 'stopped' ? 'awaiting_question' : statusOf(ferret),
      startedAt: ferret.createdAt,
      ...(stoppedAt === undefined ? { lastActivityAt: questionSince ?? ferret.stateAt } : { finishedAt: stoppedAt }),
      ...(questionSince !== undefined && ferret.state !== 'stopped'
        ? { turnState: 'needs-input' as const, turnStateAt: questionSince }
        : {}),
      turn,
      ...(questionSince === undefined && ferret.state === 'working'
        ? { turnState: 'working' as const, turnStateAt: ferret.stateAt }
        : {}),
      ...(questionSince === undefined && ferret.state === 'idle'
        ? { turnState: 'your-turn' as const, turnStateAt: turnEndedAt ?? ferret.stateAt }
        : {}),
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
  asks: AsksApi,
  turns: TurnOrdinals,
  directoryOf: (ferret: string) => string,
): Promise<readonly WardenFleetSession[]> {
  const all = await ferrets.list();
  const questions = await openQuestions(asks);
  return await Promise.all(
    all.map(async ferret => {
      const current =
        ferret.state === 'stopped' ? undefined : await conversation.currentTurn(ferret.id).catch(() => undefined);
      const ordinal = turns.see(ferret.id, current);
      return wardenFleetSession(
        ferret,
        ordinal,
        turns.endedAt(ferret.id),
        directoryOf(ferret.id),
        questions.get(ferret.id),
      );
    }),
  );
}

/** The oldest open question each ferret has raised itself (a ferret's own ask that wants an answer, not a notice). */
async function openQuestions(asks: AsksApi): Promise<ReadonlyMap<string, string>> {
  const since = new Map<string, string>();
  try {
    for (const ask of await asks.open({ source: 'ferret' as never, state: 'open' }))
      if (
        ask.ferret !== undefined &&
        ask.kind !== 'notice' &&
        ask.kind !== 'task' &&
        (since.get(ask.ferret) ?? '\uffff') > ask.raisedAt
      )
        since.set(ask.ferret, ask.raisedAt);
  } catch {
    // Asks unreadable: no ferret is thought to be waiting, which is the quiet reading.
  }
  return since;
}
