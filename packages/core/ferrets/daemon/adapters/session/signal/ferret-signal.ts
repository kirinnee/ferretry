import { type FerretId, type FerretRecord, type FerretWaiting, FerretWaitingSchema } from '../../../../contract/index.ts';
import { DEFAULT_COMPLETION_SUMMARY } from '../../../lib/session/signal/policy.ts';
import {
  type DeclaredWait,
  type SignalArtifacts,
  type SignalRepository,
  type SignalTarget,
  type SignalTerminal,
  type SignalTransition,
} from '../../../lib/session/signal/types.ts';
import { type SessionId, tryParseSessionId } from '../../../lib/session-id.ts';
import type { SessionStatus } from '../../../lib/protocol/session-base.ts';

/**
 * Today's signal domain over Ferrets' own records. The decisions (`SessionSignalService`, the deadline and backstop
 * rules, who may wait on whom) are today's and unchanged; these three adapters are the only place the two vocabularies
 * meet, so that a ferret's four states and the old session statuses are never mixed in the domain.
 */

/** What the three adapters need of the daemon half. */
export interface FerretSignalHost {
  ready(): Promise<void>;
  record(ferret: FerretId): FerretRecord | undefined;
  /** The ferret an id or a name addresses (a live holder of a name wins; two on one footing name none). */
  resolve(reference: string): FerretId | undefined;
  waitingOf(ferret: FerretId): FerretWaiting | undefined;
  /** The seconds already credited back for time spent deliberately parked. */
  creditOf(ferret: FerretId): Promise<number | undefined>;
  /** Writes (or, with no wait, ends) the declared wait and the credit, durably, then tells the registry. */
  saveWaiting(ferret: FerretId, waiting: FerretWaiting | undefined, creditSeconds: number | undefined): Promise<void>;
  /** Records that the ferret said `signal done`, at this instant. */
  saveFinished(ferret: FerretId, at: string): Promise<void>;
  /** The ferret's `summary.md`, as the ferret wrote it. */
  writeSummary(ferret: FerretId, text: string): Promise<void>;
  /** One event on the ferret's `history.jsonl`. */
  history(ferret: FerretId, type: string, data: Readonly<Record<string, unknown>>): Promise<void>;
  /** Ends the ferret's process (`stopped`); it can resume. */
  stop(ferret: FerretId, reason: string): Promise<void>;
}

const asFerret = (id: SessionId): FerretId => id as unknown as FerretId;
const asSession = (id: FerretId): SessionId | undefined => tryParseSessionId(id);

/** A ferret's state in the status words the domain reasons in; only `stopped` and `waiting` carry a decision. */
function statusOf(record: FerretRecord, waiting: FerretWaiting | undefined): SessionStatus {
  if (record.state === 'stopped') return 'stopped';
  if (waiting !== undefined) return 'waiting';
  if (record.state === 'starting') return 'starting';
  return record.state === 'idle' ? 'awaiting_user' : 'running';
}

const declared = (waiting: FerretWaiting): DeclaredWait => ({
  since: waiting.since,
  ...(waiting.until === undefined ? {} : { until: waiting.until }),
  ...(waiting.condition === undefined ? {} : { condition: waiting.condition }),
  ...(waiting.peer === undefined ? {} : { peer: waiting.peer }),
  ...(waiting.peerName === undefined ? {} : { peerName: waiting.peerName }),
});

export class FerretSignalRepository implements SignalRepository {
  constructor(private readonly host: FerretSignalHost) {}

  async read(id: SessionId): Promise<SignalTarget | undefined> {
    await this.host.ready();
    const ferret = asFerret(id);
    const record = this.host.record(ferret);
    if (record === undefined) return undefined;
    const waiting = this.host.waitingOf(ferret);
    const credit = await this.host.creditOf(ferret);
    return {
      id,
      status: statusOf(record, waiting),
      // A ferret that was not started in either mode is a person's terminal.
      mode: record.mode === 'auto' ? 'auto' : 'interactive',
      turn: 0,
      teammate: record.name,
      ...(waiting === undefined ? {} : { waiting: declared(waiting) }),
      ...(credit === undefined ? {} : { waitingCreditSeconds: credit }),
    };
  }

  async resolvePeer(reference: string): Promise<SignalTarget | undefined> {
    const ferret = this.host.resolve(reference);
    const id = ferret === undefined ? undefined : asSession(ferret);
    return id === undefined ? undefined : await this.read(id);
  }

  /**
   * Records what a signal changed. A completion or a failure has already ended the process (the domain stops it
   * first), so its verdict is the history event; a wait is a record beside the ferret. Appended after the record is
   * durable, so a history line never describes a change that was not written.
   */
  async transition(id: SessionId, change: SignalTransition): Promise<SignalTarget> {
    const ferret = asFerret(id);
    if (change.event === 'session.waiting' && change.waiting !== undefined && change.waiting !== 'clear')
      await this.host.saveWaiting(
        ferret,
        FerretWaitingSchema.parse(change.waiting),
        await this.host.creditOf(ferret),
      );
    else if (change.event === 'session.completed' && change.finishedAt !== undefined)
      await this.host.saveFinished(ferret, change.finishedAt);
    else if (change.event === 'session.waiting_cleared')
      await this.host.saveWaiting(ferret, undefined, change.waitingCreditSeconds ?? (await this.host.creditOf(ferret)));
    if (change.event !== 'session.waiting_held')
      await this.host.history(ferret, change.event, {
        ...(change.reason === undefined ? {} : { reason: change.reason }),
        ...(change.data ?? {}),
      });
    const target = await this.read(id);
    if (target === undefined) throw new Error(`ferret ${id} is unreadable after a signal`);
    return target;
  }
}

/**
 * The evidence a signal leaves: the summary a finished ferret hands back (`FerretsApi.summary` reads it once the
 * ferret is stopped), and the question an asking ferret raised, which is a history event the ferret's lead can read.
 * There is no completion marker: nothing in the daemon reads one now that the ferret's `stopped` state is the verdict.
 */
export class FerretSignalArtifacts implements SignalArtifacts {
  constructor(private readonly host: FerretSignalHost) {}

  async writeSummary(id: SessionId, message: string | undefined): Promise<void> {
    const trimmed = message?.trim();
    await this.host.writeSummary(asFerret(id), trimmed === undefined || trimmed === '' ? DEFAULT_COMPLETION_SUMMARY : `${trimmed}\n`);
  }

  async markDone(): Promise<void> {}

  async raiseQuestion(id: SessionId, message: string): Promise<void> {
    await this.host.history(asFerret(id), 'interaction.question', { message });
  }
}

/** The terminal side: the final frame is the runner's to keep, and stopping is Ferrets' own stop. */
export class FerretSignalTerminal implements SignalTerminal {
  constructor(private readonly host: FerretSignalHost) {}

  async snapshot(): Promise<void> {}

  async stop(id: SessionId, reason: string): Promise<void> {
    await this.host.stop(asFerret(id), reason);
  }
}
