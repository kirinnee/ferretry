import { type SessionState, SessionStateSchema } from '@ferretry/protocol';
import {
  type AnswerLedger,
  type ClockPort,
  INITIAL_OBSERVER_STATE,
  type JsonValue,
  LIVENESS_TAIL_LINES,
  type LivenessSample,
  type LivenessTarget,
  type ObserverFacts,
  observerFactsOf,
  type ProcessObservation,
  QUESTION_TAIL_EVENTS,
  type SessionId,
  type SessionObserver,
  type SessionObserverHost,
  type SessionTranscriptTail,
  type SessionTurnPorts,
  SessionTurnWatcher,
  TURN_TAIL_EVENTS,
  type TurnPaneEvidence,
  type TurnWatchLoop,
  type TurnWatchSession,
  turnLeftToSettle,
} from '../../../lib/index.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';
import type { SessionObservationApplier } from './session-observation-applier.ts';

/** What the inline host reads through, all of it on the main thread. */
export interface InlineObserverPorts {
  /** The opened storage: its index roster, its documents and its `facts` hook. */
  readonly storage: Pick<DaemonStorage, 'listSessions' | 'readState' | 'subscribeStates'>;
  /** The sessions the question part looks at — every one the index does not say has ended. */
  readonly questionRoster: () => readonly SessionId[];
  /** The ONE transcript tail every part reads, over the daemon-wide tail cache. */
  readonly tail: SessionTranscriptTail;
  /** One live frame of a session's pane, read as turn evidence. */
  readonly pane: (id: SessionId) => Promise<TurnPaneEvidence | undefined>;
  readonly answers: Pick<AnswerLedger, 'all'>;
  /**
   * The answer queue. A projection never waits behind a live answer drive: that drive owns the
   * freshest state, and a later look projects it once the session's key is idle.
   */
  readonly answerSerial: { runIfIdle<T>(key: string, work: () => Promise<T>): Promise<T | undefined> };
  readonly applier: Pick<SessionObservationApplier, 'apply'>;
  /** The liveness look, through the operator reads (already masked by the vault redactor). */
  readonly liveness: {
    screen(id: string): Promise<string>;
    transcript(id: string, lines: number): Promise<string>;
    processes(tmuxSession: string): Promise<ProcessObservation>;
  };
  readonly clock: ClockPort;
  /** Hands the event loop back between two sessions of a question pass. */
  readonly yieldToLoop: () => Promise<void>;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * THE SESSION OBSERVER ON THE MAIN THREAD, on the timers that already exist.
 *
 * Stage 3a of `docs/design/session-workers.md`: the observation the turn watcher, the monitor's
 * question pass and the Warden's liveness tick each made is now one fold (`SessionObserver`) whose
 * patches go to the one writer (`SessionObservationApplier`). This host runs it where they ran, at the
 * cadence they ran — the 2 s turn tick, the 15 s question pass, the 30 s liveness tick — so nothing a
 * person sees changes. Stage 3b's worker host implements the same port.
 *
 * WHAT IT NO LONGER READS. The turn tick re-read and re-parsed every session's state document every
 * two seconds to learn a handful of fields this daemon had itself written. Storage now TELLS the host
 * each state it writes (`subscribeStates`), so a document is read only for a session the host has never
 * been told about, and a question look — which reads the document anyway — refreshes what it was told.
 * A state document edited behind the daemon's back is therefore seen by the turn part only at that
 * session's next question look or write: storage is the one writer the doctrine allows.
 *
 * ONE TAIL. Every part asks the same daemon-wide tail cache for the same window — the question part's
 * {@link QUESTION_TAIL_EVENTS} — so a transcript that changed is parsed once for all of them; the turn
 * part decides from its last {@link TURN_TAIL_EVENTS}, exactly the window it always read.
 */
export class InlineObserverHost implements SessionObserverHost {
  readonly turns: TurnWatchLoop;
  /** What storage last told the host about each session: its turn and question fields. */
  private readonly facts = new Map<SessionId, ObserverFacts>();
  private readonly listeners = new Set<(id: SessionId, facts: ObserverFacts | undefined) => void>();
  /** How many writes storage has told of per session, so a read taken before one never overwrites it. */
  private readonly told = new Map<SessionId, number>();

  constructor(
    private readonly ports: InlineObserverPorts,
    private readonly observer: SessionObserver,
  ) {
    // For as long as the storage is open: closing it drops every listener, this one included.
    ports.storage.subscribeStates((id, state) => this.tell(id, state));
    this.turns = new SessionTurnWatcher(this.turnPortsFor(async () => await this.turnRoster()));
  }

  /** Nothing to stop: the timers that drive this host are the composition root's. */
  close(): void {}

  /**
   * Every change to what the host knows about a session, as it learns it — a write storage told of, or a
   * document it read — and `undefined` when a document stopped parsing. A worker host forwards these to
   * the session's worker, so a worker never reads a document either.
   */
  onFacts(listener: (id: SessionId, facts: ObserverFacts | undefined) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async project(id: SessionId): Promise<void> {
    await this.ports.answerSerial.runIfIdle(id, async () => {
      const transcript = await this.ports.tail.tail(id, QUESTION_TAIL_EVENTS);
      // A transcript that cannot be proved belongs to this session is not a benign empty transcript.
      // Leave the durable state untouched: its own parser will make a damaged session read fail
      // rather than inventing an answerable absence from missing evidence.
      if (transcript.kind !== 'read') return;
      const revision = this.revision(id);
      const current = SessionStateSchema.safeParse(await this.ports.storage.readState(id));
      if (!current.success) return;
      this.remember(id, revision, current.data);
      const answers = await this.ports.answers.all(id);
      const step = this.observer.step(INITIAL_OBSERVER_STATE, {
        kind: 'look',
        question: { state: current.data, events: transcript.events, answers },
      });
      for (const patch of step.patches) await this.ports.applier.apply(id, patch, this.ports.clock.now());
    });
  }

  /**
   * LIVE SESSIONS ONLY, ONE AT A TIME, handing the loop back between them. Every session's tail at once
   * was thirty-six transcript windows parsed together on a Mac's first tick, and the loop stalled for
   * seconds. A session the index says has ended asks no question anyone can answer here; its evidence is
   * projected when it is next read.
   */
  async questions(): Promise<ReadonlyMap<string, string>> {
    const failures = new Map<string, string>();
    for (const id of this.ports.questionRoster()) {
      try {
        await this.project(id);
      } catch (error) {
        failures.set(id, message(error));
      }
      await this.ports.yieldToLoop();
    }
    return failures;
  }

  /**
   * Three looks, each total: what cannot be read this tick is simply not evidence this tick. The screen
   * and the transcript are the operator reads, and only their digests are kept.
   */
  async liveness(target: LivenessTarget): Promise<LivenessSample> {
    const reads = this.ports.liveness;
    // The SCREEN, not the scrollback: the work counters and background-terminal footer live on it, and
    // any change to the scrollback moves the screen too — at a fraction of the bytes per tick.
    const screen = await reads.screen(target.id).catch(() => undefined);
    const transcript = await reads.transcript(target.id, LIVENESS_TAIL_LINES).catch(() => undefined);
    const observed =
      target.tmuxSession === undefined ? undefined : await reads.processes(target.tmuxSession).catch(() => undefined);
    const children = observed?.kind === 'observed' ? observed.processes.length > 0 : undefined;
    const step = this.observer.step(INITIAL_OBSERVER_STATE, {
      kind: 'look',
      liveness: { screen, transcript, children },
    });
    return step.samples[0] ?? {};
  }

  async midTurn(): Promise<number> {
    return (await this.turnRoster()).filter(session => session.state.turnState === 'working').length;
  }

  /**
   * The turn part's ports over the shared tail, the pane reader and the one writer, for the sessions
   * `roster` names: this host's own watcher takes every one, a worker host only those no worker observes.
   */
  turnPortsFor(roster: () => Promise<readonly TurnWatchSession[]>): SessionTurnPorts {
    return {
      sessions: roster,
      transcript: async id => {
        const read = await this.ports.tail.tail(id, QUESTION_TAIL_EVENTS);
        return read.kind === 'read' ? read.events.slice(-TURN_TAIL_EVENTS) : undefined;
      },
      pane: async id => await this.ports.pane(id),
      record: async (id, change, at) => await this.ports.applier.apply(id, { kind: 'turn', change }, at),
      clock: this.ports.clock,
    };
  }

  /**
   * Every indexed session with a turn left to decide — live, or not live but still recording a turn to
   * clear — from what storage told the host. A session it was never told about is read, once.
   */
  async turnRoster(): Promise<readonly TurnWatchSession[]> {
    const listed = this.ports.storage.listSessions();
    const roster = new Set(listed.map(session => session.id));
    for (const id of this.facts.keys()) if (!roster.has(id)) this.facts.delete(id);
    const sessions = await Promise.all(
      listed.map(async ({ id }) => {
        const facts = this.facts.get(id) ?? (await this.read(id));
        return facts === undefined || !turnLeftToSettle(facts)
          ? undefined
          : ({ id, state: facts } satisfies TurnWatchSession);
      }),
    );
    return sessions.filter(session => session !== undefined);
  }

  /** A session storage has not told the host about: its document, read and remembered. */
  private async read(id: SessionId): Promise<ObserverFacts | undefined> {
    const revision = this.revision(id);
    const state = SessionStateSchema.safeParse(await this.ports.storage.readState(id).catch(() => undefined));
    if (!state.success) return undefined;
    this.remember(id, revision, state.data);
    return this.facts.get(id) ?? observerFactsOf(state.data);
  }

  /** Storage wrote a session's state: remember its turn fields, or forget a document that does not parse. */
  private tell(id: SessionId, raw: JsonValue): void {
    this.told.set(id, this.revision(id) + 1);
    const state = SessionStateSchema.safeParse(raw);
    if (state.success) this.learn(id, observerFactsOf(state.data));
    else this.learn(id, undefined);
  }

  /** Remembers a document read at `revision`, unless storage has told of a newer write since. */
  private remember(id: SessionId, revision: number, state: SessionState): void {
    if (this.revision(id) === revision) this.learn(id, observerFactsOf(state));
  }

  private learn(id: SessionId, facts: ObserverFacts | undefined): void {
    if (facts === undefined) this.facts.delete(id);
    else this.facts.set(id, facts);
    for (const listener of this.listeners) {
      try {
        listener(id, facts);
      } catch {}
    }
  }

  private revision(id: SessionId): number {
    return this.told.get(id) ?? 0;
  }
}
