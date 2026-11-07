import { type AskSummary, type AsksApi, SourceKeySchema } from '@ferretry/core-asks/contract';
import type { FerretId, FerretsApi, FerretSummary } from '@ferretry/core-ferrets/contract';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import {
  type ExchangeSend,
  type LivenessTarget,
  textFingerprint,
  WARDEN_LABEL,
  type WardenFleetSession,
  type WardenLivenessMonitor,
  type WardenSessionStatus,
  withBatchMembers,
  withLivenessLedger,
} from './lib/index.ts';

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
 * detector measures (pane frames, token counters, tool processes) come from the liveness monitor, laid over this by
 * {@link withLiveness} while Terminals is on. Without it they are absent and the classifiers that need them stay quiet.
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
    // Without the liveness monitor (Terminals off), Ferrets' own account: a ferret it calls running has a live handle,
    // so `dead_monitor` does not run. With it, {@link withLiveness} says whether the monitor is really watching.
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

/** Asks' own source for a ferret's `fy ask`. */
const FERRET_SOURCE = SourceKeySchema.parse('ferret');

/** A ferret's own ask that wants an answer: not a notice, not a card. */
const isQuestion = (ask: AskSummary): boolean => ask.kind !== 'notice' && ask.kind !== 'task';

/**
 * Whether one ferret has a question of its own open (today's `pendingQuestion`). An Asks that cannot be read throws:
 * the caller is a refusal check, and an unknown answer must not read as "no question".
 */
export async function hasOpenQuestion(asks: AsksApi, ferret: FerretId): Promise<boolean> {
  return (await asks.open({ source: FERRET_SOURCE, ferret, state: 'open' })).some(isQuestion);
}

/** The oldest open question each ferret has raised itself (a ferret's own ask that wants an answer, not a notice). */
async function openQuestions(asks: AsksApi): Promise<ReadonlyMap<string, string>> {
  const since = new Map<string, string>();
  try {
    for (const ask of await asks.open({ source: FERRET_SOURCE, state: 'open' }))
      if (ask.ferret !== undefined && isQuestion(ask) && (since.get(ask.ferret) ?? '\uffff') > ask.raisedAt)
        since.set(ask.ferret, ask.raisedAt);
  } catch {
    // Asks unreadable: no ferret is thought to be waiting, which is the quiet reading.
  }
  return since;
}

/** At most this many pages of one ferret's send ledger are read in one look (a ledger is bounded; a loop is a bug). */
const SEND_PAGES = 64;

/**
 * Every send one ferret was sent, the latest line of each, as the overdue-report check reads it (today's
 * `exchanges.sends`: the send ledger with the batch members its queue says rode one turn). Throws when Conversation
 * cannot be read: the sweep treats an unreadable ledger as proving nothing this sweep.
 */
export async function exchangeSends(conversation: ConversationApi, ferret: FerretId): Promise<readonly ExchangeSend[]> {
  const sends: ExchangeSend[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < SEND_PAGES; page++) {
    const listed = await conversation.sends(ferret, cursor);
    for (const send of listed.sends)
      sends.push({
        sendId: send.sendId,
        from: send.from,
        acceptedAt: send.acceptedAt,
        turn: send.turn,
        replyExpected: send.replyExpected,
        fate: send.fate,
      });
    if (listed.nextCursor === undefined || listed.nextCursor === null) break;
    cursor = listed.nextCursor;
  }
  return withBatchMembers(sends, (await conversation.queue(ferret)).messages);
}

/** What the sweep reads of the liveness monitor for one ferret (today's `wardenFleetSession` overlay, `fyd.ts`). */
export type LivenessOverlay = Pick<
  WardenLivenessMonitor,
  'ledger' | 'watching' | 'frozenAt' | 'observedSince' | 'leftoverBrowserSince'
>;

/**
 * A ferret with what the liveness monitor saw laid over it, as today: its ledger over its own state, watched only
 * while the monitor has looked at it recently (a working ferret it cannot look at is a `dead_monitor`), frozen when
 * the reflex confirmed it, silence measured from when this daemon began watching (now, for one no tick has reached),
 * and since when a browser it launched has outlived its turn. `leftovers: false` (Browsers off) leaves that last
 * fact out, so the leftover check does not run: nothing could close what it found.
 */
export function withLiveness(
  session: WardenFleetSession,
  monitor: LivenessOverlay,
  nowIso: string,
  leftovers: boolean,
): WardenFleetSession {
  const id = session.config.id;
  const { frozenAt: _frozen, leftoverBrowserSince: _leftover, ...rest } = session;
  const frozenAt = monitor.frozenAt(id);
  const leftoverBrowserSince = leftovers ? monitor.leftoverBrowserSince(id) : undefined;
  return {
    ...rest,
    state: withLivenessLedger(session.state, monitor.ledger(id)),
    hasLiveMonitor: monitor.watching(id),
    ...(frozenAt === undefined ? {} : { frozenAt }),
    observedSince: monitor.observedSince(id) ?? nowIso,
    ...(leftoverBrowserSince === undefined ? {} : { leftoverBrowserSince }),
  };
}

/**
 * The ferrets the liveness monitor may look at (today's `targets`): every ferret the sweep reads, wardens excluded.
 * Ferrets stores each ferret's declared wait and its own nudge and frozen times, but `FerretSummary` does not carry
 * them, so none reads as waiting and the reflex uses its defaults. That is why the reflex only DETECTS on 5.0
 * (`WardenSweepSettings.reflexNudges` false; declared GAP in `ports-pending.json`).
 */
export function livenessTargets(fleet: readonly WardenFleetSession[]): readonly LivenessTarget[] {
  return fleet
    .filter(session => session.config.label !== WARDEN_LABEL)
    .map(session => ({
      id: session.config.id,
      status: session.state.status,
      turn: session.turn ?? 0,
      mode: session.config.mode,
      waiting: false,
      ...(session.state.turnState === undefined ? {} : { turnState: session.state.turnState }),
    }));
}

/** How many of the newest transcript events the liveness digest covers: enough that a new one always changes it. */
export const LIVENESS_TAIL_EVENTS = 20;

/**
 * A fingerprint of the ferret's transcript tail, from Conversation (the transcript's owner): it moves when the
 * conversation grows. Its input is today's (`operatorReads.logs(id, 20)`): the masked log text of the newest events of
 * EVERY kind — reasoning, usage, turn markers and compactions as well as messages and tool calls — so a long think
 * that writes only reasoning still moves it. Total: a transcript that cannot be read, or a Conversation without that
 * read, is `undefined`, no evidence this tick. Only the fingerprint is kept, never the text.
 */
export async function transcriptDigest(conversation: ConversationApi, ferret: FerretId): Promise<string | undefined> {
  if (conversation.transcriptLog === undefined) return undefined;
  const tail = await conversation.transcriptLog(ferret, { limit: LIVENESS_TAIL_EVENTS }).catch(() => undefined);
  return tail?.ok === true ? textFingerprint(tail.value.log) : undefined;
}
