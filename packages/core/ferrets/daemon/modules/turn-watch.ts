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
 *
 * THE REGISTRY FOLLOWS THE RECORD, NOT ONLY ITS CHANGES: a look that decides the turn already recorded still moves a
 * registry state that disagrees with it (`agreed`), because a launch sets `working` without touching the record.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Log } from '@ferretry/kernel/contract';
import type { FerretId, FerretRecord, Runner, RunnerExit, RunnerHandle } from '../../contract/index.ts';
import { turnPaneEvidenceOfLook } from '../adapters/session/observer/runner-look.ts';
import { InlineObserverHost } from '../adapters/session/observer/inline-observer-host.ts';
import { SessionObservationApplier } from '../adapters/session/observer/session-observation-applier.ts';
import { KeyedSerialExecutor } from '../adapters/storage/keyed-serial-executor.ts';
import { type DaemonStorage, InvalidStateDocumentError } from '../adapters/storage/session-storage.ts';
import { SessionObserver } from '../lib/session/observer/observer.ts';
import type { ObserverPatch } from '../lib/session/observer/observer.ts';
import type { QuestionStepPolicy } from '../lib/session/observer/question.ts';
import { PacedTurnWatcher } from '../lib/session/observer/turn-watch.ts';
import { SessionStateSchema, type SessionTurnState } from '../lib/protocol/session.ts';
import type { BootPassGate } from '../lib/session/auto-resume/boot-gate.ts';
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
  /** Every ferret the registry holds, with the runner handle the list view leaves out: what the gone sweep walks. */
  readonly live?: () => readonly FerretRecord[];
  readonly runner: () => Runner | undefined;
  /** The ferret's registry state follows a recorded turn (`FerretsService.turnObserved`). */
  readonly turnObserved: (ferret: FerretId, turn: SessionTurnState) => Promise<void>;
  /**
   * A live ferret whose pane a look could not read and the runner PROVES gone is settled stopped, `terminal_gone`, on
   * exactly that handle, or exactly NO handle for a record that holds none (`FerretsService.settleGone`: a compare-and-set
   * that a stop or a resume in between wins). Absent:
   * a vanished pane is never noticed after boot.
   */
  readonly settleGone?: (
    ferret: FerretId,
    handle: string | undefined,
    exited: { readonly from: string; readonly reason: string },
    stillGone: () => Promise<boolean>,
  ) => Promise<boolean>;
  /**
   * A live ferret whose pane a look could not read and the runner PROVES is still there with its program ended (the
   * harness was killed or crashed and the pane was kept) is settled stopped WITH HOW IT ENDED
   * (`FerretsService.settleExited`: the same compare-and-set, and a second proof inside the ferret's queue). Absent: a
   * dead pane that stayed is never noticed after boot.
   */
  readonly settleExited?: (
    ferret: FerretId,
    handle: string,
    exit: RunnerExit,
    from: string,
    stillExited: () => Promise<boolean>,
  ) => Promise<boolean>;
  readonly clock: { now(): string };
  /**
   * Held back until the auto-resume boot pass has closed its recorder: only a settle that pass lands is owed a resume, so
   * a vanished ferret the sweep or a look's failure notice settled first would be stopped and never resumed. Until it is
   * open, no vanished terminal is noticed (the sweep may be registered, its ticks settle nothing). Absent: always open.
   */
  readonly bootPass?: Pick<BootPassGate, 'open'>;
  /** Whether the ferret's owner stores a question that is open now (the `turn.question-open` provider); `false` with none. */
  readonly questionOpen?: (ferret: FerretId) => Promise<boolean>;
  /** Runs `tick` every `intervalMs` until the answer is called (`kernel.clock.every`). */
  readonly every: (intervalMs: number, tick: () => void) => () => void;
  /** Hands the event loop back between two panes (`kernel.clock`). */
  readonly yieldToLoop: () => Promise<void>;
  readonly log: Pick<Log, 'warn'>;
}

/** What a settled vanished terminal says (the boot exit pass's own sentence for a `gone` pane). */
const GONE_REASON = 'the agent is no longer running: its terminal is gone, so how it exited was not recorded';

/**
 * The statuses of a session document that are a RECORDED OUTCOME: the ferret finished, failed or was stopped, and somebody
 * wrote that down. Deliberately not "everything but a running agent": `rate_limited`, `retrying`, `kill_failed`,
 * `created`, `starting` and `stalled` are statuses of a ferret whose pane is still meant to be there (or is being made),
 * so a pane that vanishes under them is exactly what the settle is for.
 */
const OUTCOME_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped']);

/** How often every live ferret is asked whether its terminal is still there, whatever its document says. */
const GONE_SWEEP_MS = 30_000;

/** The sentence a part that is not mounted in this build rejects with. */
const notMounted = (part: string): Error => new Error(`${part} is not mounted in this version of Ferretry.`);

/** The question part's policy: Conversation's and the harnesses'. Every member refuses. */
const QUESTIONS_NOT_MOUNTED = new Proxy({} as QuestionStepPolicy, {
  get: () => () => {
    throw notMounted('The question part of the session observer');
  },
});

/**
 * What a turn watch failure may say in the log: a refused state document by its FILE and its KIND (a fixed word; never
 * its text, nor the parser's account of it, which can quote it), anything else by its kind.
 */
export function turnWatchFailureFields(error: unknown): Readonly<Record<string, string>> {
  if (error instanceof InvalidStateDocumentError) return { file: error.file, why: error.damage };
  return { error: error instanceof Error ? error.name : 'unknown' };
}

/** What each kind of damage says, in words that carry nothing of the file (the kinds are a fixed vocabulary). */
const DAMAGE_SENTENCE: Readonly<Record<Exclude<InvalidStateDocumentError['damage'], 'refused_write'>, string>> = {
  unparsable: 'it is not JSON',
  no_format: 'it has no format number',
  lower_format: 'it is in an older format than this daemon reads',
  higher_format: 'it is in a newer format than this daemon reads',
  schema: 'it does not match the state document it should be',
  missing: 'it is missing',
  io: 'it could not be read',
};

/**
 * What a failed look says in the log, for one ferret: WHICH ferret and WHY, and nothing of the document (never its bytes,
 * nor the parser's account of it, which can quote them).
 */
export function turnWatchFailureSentence(ferret: string, error: unknown): string {
  // The daemon's own value was refused before it reached the disk: the file on disk is not what is wrong, so it is not
  // told as damage there.
  if (error instanceof InvalidStateDocumentError) {
    const kind = error.damage;
    if (kind === 'refused_write')
      return `ferret ${ferret}'s turn could not be recorded: the state document the daemon built for it does not match the state document it should be (nothing was written, and the state.json on disk is as it was)`;
    return `ferret ${ferret}'s turn cannot be watched until its state.json is mended: ${DAMAGE_SENTENCE[kind]}`;
  }
  return `ferret ${ferret}'s turn could not be watched this time`;
}

/**
 * What makes one refused state document the SAME report: its file, its kind and a digest of the file as last written
 * (the port's version etag: inode, size and modification time, so a rewrite is a new report even of identical bytes; the
 * port's account stands in where it gave no etag, and that account can quote the document, so only its digest is kept
 * and it is never logged). A fixed file clears it by recording a turn again. Any other failure has no key, so it is told
 * every time.
 */
export function turnWatchFailureKey(error: unknown): string | undefined {
  if (!(error instanceof InvalidStateDocumentError)) return undefined;
  const digest = createHash('sha256')
    .update(error.etag ?? error.reason, 'utf8')
    .digest('hex');
  return `${error.file}\u0000${error.damage}\u0000${digest}`;
}

/** The inline host over the turn part, unarmed: `arm()` starts the 2 s tick, `close()` stops it. */
export function buildTurnWatch(deps: TurnWatchDeps): {
  readonly host: InlineObserverHost;
  /** Ferrets typed into this ferret's pane: its next look is due on the next tick, and its wait starts over at 2 s. */
  readonly wake: (ferret: FerretId) => void;
  /** Starts the 30 s sweep that asks the runner about every live ferret's terminal; the answer stops it. */
  readonly startSweep: () => () => void;
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
      ?.look?.(record.handle as RunnerHandle, record.id)
      .catch(() => undefined);
    if (look === undefined) noticeGone(record);
    return look === undefined ? undefined : turnPaneEvidenceOfLook(look);
  };
  // A pane no look can read may be a pane that is not there: a tmux session killed by hand, or lost with its server, left
  // the registry saying `working` for ever (the boot exit pass runs once). Or it may be a pane tmux KEPT with its program
  // ended (`remain-on-exit`: a harness killed or crashed), which reads alive to `gone` and was never settled. Only the
  // runner's PROOF settles either, and never on the tick's time: the settle waits in the ferret's own queue, which a long
  // stop or restart can hold. A stop the owner made has already moved the record out of working/idle there.
  const settling = new Set<FerretId>();
  // Whether the ferret's session document RECORDS an outcome (completed, failed or stopped). That is an outcome somebody
  // already wrote: a pane gone after it is that outcome's normal end, and settling it again would write a second
  // `session.exited` and a `terminal_gone` over it. Any other status (a rate limit, a retry, a stalled or half-started
  // ferret) still means the pane is meant to be there. A document that is missing or unreadable says nothing either way,
  // so the runner's proof alone decides, as it did before.
  const outcomeRecorded = async (ferret: FerretId): Promise<boolean> => {
    const document = SessionStateSchema.safeParse(
      await deps.storage.readState(ferret as unknown as SessionId).catch(() => undefined),
    );
    return document.success && OUTCOME_STATUSES.has(document.data.status);
  };
  const notFinished = async (ferret: FerretId): Promise<boolean> => !(await outcomeRecorded(ferret));
  const noticeGone = (record: FerretRecord): void => {
    const runner = deps.runner();
    const handle = record.handle;
    if (deps.settleGone === undefined || runner?.gone === undefined) return;
    if (deps.bootPass !== undefined && !deps.bootPass.open) return;
    if (settling.has(record.id)) return;
    settling.add(record.id);
    const from = record.state === 'idle' ? 'awaiting_user' : 'running';
    void notFinished(record.id)
      .then(async claims => {
        if (!claims) return;
        return await runner.gone?.(record.id);
      })
      .then(async gone => {
        if (gone === undefined) return;
        // The proof above was taken outside the ferret's queue: the settle asks again once it holds the queue, because a
        // restart that ran in between may have put a live pane on this very handle, or a `signal done` may have
        // recorded the ferret's outcome (asked again here too, so the outcome in the document is never overwritten).
        if (gone) {
          await deps.settleGone?.(
            record.id,
            handle,
            { from, reason: GONE_REASON },
            async () => (await runner.gone?.(record.id)) === true && (await notFinished(record.id)),
          );
          return;
        }
        // The terminal is there. A pane the runner PROVES is there with its program ended (the harness was killed or
        // crashed and the pane was kept) is no live agent either: settled with how it ended, in the ferret's queue. A
        // record with no handle names no pane to ask about.
        if (handle === undefined) return;
        const exit = await runner.exited?.(record.id, handle as RunnerHandle);
        if (exit !== undefined)
          await deps.settleExited?.(
            record.id,
            handle,
            exit,
            from,
            async () =>
              (await runner.exited?.(record.id, handle as RunnerHandle)) !== undefined &&
              (await notFinished(record.id)),
          );
      })
      .catch((error: unknown) =>
        deps.log.warn("a ferret's vanished terminal could not be settled", {
          ferret: record.id,
          ...turnWatchFailureFields(error),
        }),
      )
      .finally(() => settling.delete(record.id));
  };
  // The watch's roster drops a session whose document is in no turn status (a declared `waiting`, a converted v4 copy), so
  // no look of it would ever come back empty and ask. The sweep asks about EVERY live registry record, one cheap
  // `has-session` each per {@link GONE_SWEEP_MS}, whatever its document says: a record with NO handle too (a converted
  // v4 ferret has none, so no look is ever taken of it, and only this sweep can settle it).
  const sweepGone = (): void => {
    for (const record of deps.live?.() ?? []) {
      if (record.state === 'working' || record.state === 'idle') noticeGone(record);
    }
  };
  const startSweep = (): (() => void) => deps.every(GONE_SWEEP_MS, sweepGone);
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
          // An open question is a person being asked: the look reads it as `needs-input`, as it does a recorded one.
          ...(deps.questionOpen === undefined
            ? {}
            : {
                questionOpen: (id: SessionId) =>
                  deps.questionOpen?.(id as unknown as FerretId) ?? Promise.resolve(false),
              }),
          // A look that agrees with the recorded turn records nothing, so the registry is moved here when it disagrees:
          // a launch (start, resume, attach) set it `working` while the document kept the last run's `your-turn` (a
          // resume that beat the tick which would have cleared it), and a run whose turns all end between two looks
          // never records a change. Left alone, the ferret read `working` for ever and the Warden nudged it every few
          // minutes. One registry read per look; the registry is written only when it disagrees, and never on evidence
          // older than its own last move (a frame of the pane a launch replaced).
          agreed: (id: SessionId, turn: SessionTurnState, since: string) => {
            const record = ferretOf(id);
            if (record === undefined || (record.state !== 'working' && record.state !== 'idle')) return;
            if (record.state === (turn === 'working' ? 'working' : 'idle')) return;
            if (Date.parse(since) < Date.parse(record.stateAt)) return;
            void deps.turnObserved(id as unknown as FerretId, turn).catch((error: unknown) =>
              deps.log.warn("a ferret's state could not follow its recorded turn", {
                ferret: id,
                ...turnWatchFailureFields(error),
              }),
            );
          },
          // A damaged document is said ONCE, not on every look that meets it again (until its damage changes).
          failureKey: turnWatchFailureKey,
          failed: (id, error) =>
            deps.log.warn(turnWatchFailureSentence(id, error), {
              ferret: id,
              ...turnWatchFailureFields(error),
            }),
        })),
    },
    new SessionObserver(text => createHash('sha256').update(text, 'utf8').digest('hex'), QUESTIONS_NOT_MOUNTED),
  );
  return { host, wake: ferret => watcher?.wake(ferret as unknown as SessionId), startSweep };
}
