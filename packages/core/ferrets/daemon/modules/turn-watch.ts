/**
 * THE TURN WATCH, MOUNTED (U4, RULING #44): the session observer's fold on the main thread through the inline host —
 * today's `InlineObserverHost` + `SessionObserver` + `SessionObservationApplier` (`R/bin/fyd.ts:8931–8971`) — with
 * today's turn watcher paced per pane (`PacedTurnWatcher`). The worker host (`WorkerObserverHost`, `WorkerSupervisor`,
 * `workers/session.worker.ts`) stays unmounted: it needs a tmux spawn grant for a worker (K4), and the measured inline
 * cost was accepted in its place.
 *
 * WHAT IS MOUNTED: the turn part. Every live ferret's pane is looked at through `Runner.look` (Terminals reads it
 * inside `kernel.act(terminal %n, 'read')`, so a Vault hold refuses it, and masks it before it parses it), the fold
 * decides, the ONE writer records the change in `state.json` and its journal, and the ferret's registry state follows
 * (`working` / `idle`, `ferret.changed {change: 'state'}`).
 *
 * WHAT IS NOT (each refuses, never a stand-in that answers): the question part (`project` / `questions`: its policy and
 * answer ledger are Conversation's), the liveness look (Terminals' `liveness` serves the Warden) and the send evidence
 * (Conversation's send tracker).
 *
 * THE TRANSCRIPT HALF (U5): the turn fold reads the transcript's tail through the harness that wrote it
 * (`Harness.transcriptTail`), so a turn is decided from the pane AND the transcript, as today: one idle-looking frame
 * between two spinner redraws cannot end a turn while the transcript's newest record says the agent is mid-turn. A ferret
 * whose harness proves no transcript (none offered, none bound yet, unreadable) is decided from the pane alone, which is
 * what today does for a session with no proved transcript.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Log } from '@ferretry/kernel/contract';
import type { FerretId, FerretRecord, Runner, RunnerHandle } from '../../contract/index.ts';
import { turnPaneEvidenceOfLook } from '../adapters/session/observer/runner-look.ts';
import { InlineObserverHost } from '../adapters/session/observer/inline-observer-host.ts';
import { SessionObservationApplier } from '../adapters/session/observer/session-observation-applier.ts';
import { KeyedSerialExecutor } from '../adapters/storage/keyed-serial-executor.ts';
import { type DaemonStorage, InvalidStateDocumentError } from '../adapters/storage/session-storage.ts';
import { SessionObserver } from '../lib/session/observer/observer.ts';
import type { ObserverPatch } from '../lib/session/observer/observer.ts';
import type { QuestionStepPolicy } from '../lib/session/observer/question.ts';
import { PacedTurnWatcher } from '../lib/session/observer/turn-watch.ts';
import type { SessionTurnState } from '../lib/protocol/session.ts';
import type { TurnPaneEvidence } from '../lib/session/peers/turn.ts';
import type { SessionId } from '../lib/session-id.ts';
import type { SessionTranscriptTail } from '../lib/session/peers/reads.ts';

/**
 * The async context of the daemon's own start, taken while this module loads (outside every call). The kernel stamps an
 * act's actor from the call it runs in, and a timer carries the context it was armed in: arming the tick through this
 * puts every look the watch makes under the observer's OWN actor (`ferret`, the most restricted: a hold applies), whoever
 * happens to be calling when Ferrets is (re)built. Nothing here chooses an actor; it only declines to inherit one.
 */
const outsideAnyCall = AsyncLocalStorage.snapshot();

export interface TurnWatchDeps {
  readonly storage: DaemonStorage;
  /** The transcript tail through the harness that wrote it (`HarnessTranscript.tail`). */
  readonly tail: SessionTranscriptTail;
  /** The registry's record of a ferret: which runner and handle its pane is, and whether it still runs. */
  readonly record: (ferret: FerretId) => FerretRecord | undefined;
  readonly runner: () => Runner | undefined;
  /** The ferret's registry state follows a recorded turn (`FerretsService.turnObserved`). */
  readonly turnObserved: (ferret: FerretId, turn: SessionTurnState) => Promise<void>;
  readonly clock: { now(): string };
  /** Runs `tick` every `intervalMs` until the answer is called (`kernel.clock.every`). */
  readonly every: (intervalMs: number, tick: () => void) => () => void;
  /** Hands the event loop back between two panes (`kernel.clock`). */
  readonly yieldToLoop: () => Promise<void>;
  readonly log: Pick<Log, 'warn'>;
}

/** The sentence a part that is not mounted in this build rejects with. */
const notMounted = (part: string): Error => new Error(`${part} is not mounted in this version of Ferretry.`);

/** The question part's policy: Conversation's and the harnesses'. Every member refuses. */
const QUESTIONS_NOT_MOUNTED = new Proxy({} as QuestionStepPolicy, {
  get: () => () => {
    throw notMounted('The question part of the session observer');
  },
});

/**
 * What a turn watch failure may say in the log: a damaged state document by its FILE only (never its text, nor the
 * parser's account of it, which can quote it), anything else by its kind.
 */
export function turnWatchFailureFields(error: unknown): Readonly<Record<string, string>> {
  if (error instanceof InvalidStateDocumentError) return { file: error.file };
  return { error: error instanceof Error ? error.name : 'unknown' };
}

/** The inline host over the turn part, unarmed: `arm()` starts the 2 s tick, `close()` stops it. */
export function buildTurnWatch(deps: TurnWatchDeps): {
  readonly host: InlineObserverHost;
  /** Ferrets typed into this ferret's pane: its next look is due on the next tick, and its wait starts over at 2 s. */
  readonly wake: (ferret: FerretId) => void;
} {
  let watcher: PacedTurnWatcher | undefined;
  const answersNotMounted = {
    all: async (): Promise<never> => {
      throw notMounted('The answer ledger of the session observer');
    },
    append: async (): Promise<never> => {
      throw notMounted('The answer ledger of the session observer');
    },
  };
  const applier = new SessionObservationApplier(
    deps.storage,
    answersNotMounted,
    new KeyedSerialExecutor(),
    QUESTIONS_NOT_MOUNTED,
  );
  // The ONE writer, then the registry: only a turn that was written moves the ferret, and never on the tick's time.
  const recording = {
    apply: async (id: SessionId, patch: ObserverPatch, at: string): Promise<boolean> => {
      const written = await applier.apply(id, patch, at);
      const to = patch.kind === 'turn' ? patch.change.to : undefined;
      if (written && to !== undefined)
        void deps.turnObserved(id as unknown as FerretId, to).catch((error: unknown) =>
          deps.log.warn("a ferret's turn was recorded but its state could not follow", {
            ferret: id,
            ...turnWatchFailureFields(error),
          }),
        );
      return written;
    },
  };
  const ferretOf = (id: SessionId): FerretRecord | undefined => deps.record(id as unknown as FerretId);
  // ONE look at a live ferret's pane, through the runner; anything that cannot be looked at is no evidence.
  const pane = async (id: SessionId): Promise<TurnPaneEvidence | undefined> => {
    const record = ferretOf(id);
    if (record === undefined || record.state === 'stopped' || record.handle === undefined) return undefined;
    const look = await deps
      .runner()
      ?.look?.(record.handle as RunnerHandle)
      .catch(() => undefined);
    return look === undefined ? undefined : turnPaneEvidenceOfLook(look);
  };
  const refused = (part: string) => async (): Promise<never> => {
    throw notMounted(part);
  };
  const host = new InlineObserverHost(
    {
      storage: deps.storage,
      // The question pass is not mounted: it looks at no session.
      questionRoster: () => [],
      tail: deps.tail,
      pane,
      answers: answersNotMounted,
      answerSerial: { runIfIdle: refused('The answer queue of the session observer') },
      applier: recording,
      liveness: {
        screen: refused('The liveness look of the session observer'),
        transcript: refused('The liveness look of the session observer'),
        processes: refused('The liveness look of the session observer'),
        paneWork: () => {
          throw notMounted('The liveness look of the session observer');
        },
      },
      clock: deps.clock,
      yieldToLoop: deps.yieldToLoop,
      // The live readout asks the runner for its own look (`modules/live-events.ts`): no frame is kept for it here.
      paneState: async () => undefined,
      sendEvidence: { read: refused('The send evidence of the session observer') },
      every: (intervalMs, tick) => outsideAnyCall(() => deps.every(intervalMs, tick)),
      // Today's watcher, paced per pane. A ferret the registry does not hold, or holds as stopped, is not live
      // whatever its document says: its recorded turn is cleared and its pane is never looked at.
      turnWatcher: ports =>
        (watcher = new PacedTurnWatcher({
          ...ports,
          sessions: async () =>
            (await ports.sessions()).map(session => {
              const record = ferretOf(session.id);
              return record !== undefined && record.state !== 'stopped'
                ? session
                : { ...session, state: { ...session.state, status: 'stopped' as const } };
            }),
          yieldToLoop: deps.yieldToLoop,
          failed: (id, error) =>
            deps.log.warn("a ferret's turn could not be watched this time", {
              ferret: id,
              ...turnWatchFailureFields(error),
            }),
        })),
    },
    new SessionObserver(text => createHash('sha256').update(text, 'utf8').digest('hex'), QUESTIONS_NOT_MOUNTED),
  );
  return { host, wake: ferret => watcher?.wake(ferret as unknown as SessionId) };
}
