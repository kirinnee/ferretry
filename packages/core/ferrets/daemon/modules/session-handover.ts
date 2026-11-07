import { asActivity, KeyedSerialExecutor, type SystemClock } from '../../src/adapters/index.ts';
import { FileHandoverReceiptStore } from '../adapters/moves/handover/file-handover-receipt-store.ts';
import type { DaemonStorage } from '../adapters/storage/session-storage.ts';
import {
  type AccountInventoryPort,
  type ActivityLedger,
  DEFAULT_HANDOVER_SETTINGS,
  type ExecutableResolverPort,
  type FoundationPaths,
  HandoverError,
  type HandoverJournalAppend,
  type HandoverReceiptStore,
  HandoverReconcileLoop,
  RememberedHandoverReceipts,
  type SerialExecutor,
  type SessionDirectorySubsystem,
  SessionHandoverService,
  type SessionPlanner,
  tryParseSessionId,
} from '../../src/lib/index.ts';
import { resolveStartAccount } from '../lib/fleet/start-resolution.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import { sessionHandoverContribution } from '../lib/runtime/mounts/session-handover.ts';

/**
 * The cross-harness handover: the three routes under `/v1/ferrets/:ferretId/handover`, the durable receipt store, the
 * state machine behind them and the reconcile loop that finishes a handover nobody is watching.
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter that
 * `DaemonWorld` carries: the receipt store, the serial executor and the loop's scheduler are fixed production adapters;
 * the session directory, the account inventory, the executable resolver, the planner, the storage and the clock are needs),
 * no releases of its own and no protocol features. Building starts nothing: the service and the loop capture their inputs,
 * and the loop's interval is created by `jobs.arm()`, never by the build.
 *
 * ONE JOB, armed by `start()`: the reconcile loop, whose `arm()` returns its disarm synchronously (and runs one pass
 * immediately — a daemon that has just restarted is when a handover is most likely to be mid-ladder). It is armed
 * beside the warden sweep and after the bind, on the line `start()` always had.
 *
 * Session lifecycle, launch, resume and move stay in `fyd.ts`: the module reaches the session directory, the
 * planner and the account resolution only as typed {@link SessionHandoverNeeds}, the very locals the old call passed.
 * What it provides is the service itself, read by nothing but its own route, and the loop, which `MountedSubsystems`
 * still carries as `handoverReconcile` (the boot trace names that field).
 */

/**
 * How many events one page of the duplicate search reads.
 *
 * finite limit read once would answer about the OLDEST events in the journal — and the event this is
 * looking for is the newest. On a session with more than one page of history that search would find
 * nothing every time and append a duplicate on every replay, which is precisely the contract
 * `appendOnce` exists to keep. The search below therefore pages forward to the true end, and this
 * number only decides how many round trips that takes.
 */
const HANDOVER_JOURNAL_PAGE = 1_000;

/**
 * Appends one handover event to a session's journal, AT MOST ONCE.
 *
 * WHY THIS IS NOT A PLAIN APPEND. Completion writes to two journals in a fixed order — the
 * predecessor's, then the replacement's — and a crash between them replays the step. A plain append
 * would then write the predecessor's completion a second time, and the fleet's own history would claim
 * one session was handed over twice. The core states that contract in the port's name (`appendOnce`)
 * and derives an `operationId` from the receipt and the side precisely so the second attempt is
 * recognisable as the first.
 *
 * THE DEDUPLICATION IS DURABLE, and the durable record is the JOURNAL ITSELF rather than a set held in
 * this process: a process-local guard is empty again after exactly the event that makes the replay
 * happen — the restart — so it would answer "not yet written" for the one case it exists to catch. The
 * question is asked of the same document the answer is written to.
 *
 * THE SEARCH RUNS TO THE TRUE END OF THE JOURNAL, and that is the whole of the correctness argument.
 * `replay` answers with a forward PREFIX from a sequence, so reading one bounded page would ask about
 * the journal's OLDEST events while the event being looked for is its NEWEST. On any session with more
 * history than one page, that search finds nothing every time — so every replay appends again, and the
 * bound silently converts "at most once" into "once per restart". There is no session-journal operation
 * ledger in this repository to ask instead, so the pages are walked until `hasMore` is false.
 *
 * A session id the layout would not accept is dropped rather than journalled, for the reason every
 * other journal write in this root drops one: an id that is not a session is not a path.
 */
export async function appendHandoverEventOnce(
  storage: DaemonStorage,
  serial: SerialExecutor,
  input: HandoverJournalAppend,
): Promise<void> {
  const id = tryParseSessionId(input.sessionId);
  if (id === undefined) return;
  const carriesOperation = (event: { readonly type: string; readonly data: unknown }): boolean =>
    event.type === input.type &&
    typeof event.data === 'object' &&
    event.data !== null &&
    !Array.isArray(event.data) &&
    (event.data as Record<string, unknown>).operationId === input.operationId;
  // THE SEARCH AND THE APPEND ARE ONE CRITICAL SECTION, per session. The storage locks each `replay`
  // and each `append` individually, so without this two concurrent attempts at the SAME operation can
  // both finish scanning — each finding nothing, because neither has written yet — and then both
  // append. The durable journal answers the RESTART half of "at most once"; this lock answers the
  // CONCURRENT half, and the contract needs both. The key is the session id, so one session's
  // completion never waits behind another's.
  await serial.run(`handover-journal:${id}`, async () => {
    let after = 0;
    for (;;) {
      const page = await storage.replay(id, after, HANDOVER_JOURNAL_PAGE);
      if (page.events.some(carriesOperation)) return;
      // `nextSequence` is absent exactly when the page was empty, which is the end of the journal
      // however `hasMore` was computed — so the walk terminates on the weaker of the two signals rather
      // than trusting one of them alone.
      if (!page.hasMore || page.nextSequence === undefined) break;
      after = page.nextSequence;
    }
    await storage.append(id, input.type, { ...input.data, operationId: input.operationId });
  });
}

/** The collaborators a cross-harness handover needs from the rest of the root. */
interface SessionHandoverWiring {
  readonly paths: FoundationPaths;
  readonly storage: DaemonStorage;
  readonly sessions: SessionDirectorySubsystem;
  readonly accounts: AccountInventoryPort;
  readonly executables: ExecutableResolverPort;
  readonly planner: SessionPlanner;
  readonly clock: SystemClock;
  /** The binary name a person drives, which an account resolution is typed with (`CLIENT_NAME` in `fyd.ts`). */
  readonly clientName: string;
  /** Serializes the journal's read-then-write per session, which is what makes `appendOnce` hold
   *  against CONCURRENT callers as well as against a restart. Owned by the composition root, because a
   *  lock created per call would serialize nothing. */
  readonly journalSerial: SerialExecutor;
}

/**
 * The cross-harness handover, wired to the surfaces that already exist.
 *
 * WHAT THIS OPERATION IS, in one line, because the word next to it means something else: a move
 * keeps a session and moves it to another account of the SAME family, and a handover crosses families,
 * which the conversation cannot survive — so a NEW top-level session is started, every durable
 * coordination fact is carried into it, it proves it holds and can use the predecessor's board
 * membership, and only then is the predecessor retired.
 *
 * THE SHARED TRANSFER SEAM EXISTS, BUT THIS HANDOVER IS NOT WIRED TO IT YET. Its generic preparer,
 * importer and target plan store are now available to the fork; the handover still lacks the
 * handover-specific composition that would choose a replacement and bind the board and lifecycle legs.
 * A handover cannot be performed without those legs, so each raises `step_failed` naming the missing
 * capability.
 * What this deliberately does NOT do is invent a second preparation: a private copy here would be the
 * parallel domain the seam exists to prevent, and it would have to be deleted — with its receipts
 * already on disk — the moment the real one landed.
 *
 * The consequence is stated rather than hidden: `POST /v1/ferrets/:id/handover` refuses every request
 * until those land, and the refusal says which piece is missing. Everything else about the operation —
 * the receipt store, the phase ladder, the reconciler, the refusal taxonomy, the routes — is real,
 * wired and exercised, which is what makes landing the seam a small change rather than a second
 * integration.
 */
export function createSessionHandoverSubsystem(
  wiring: SessionHandoverWiring,
  receipts: HandoverReceiptStore,
): SessionHandoverService {
  /** The generic seam is present; this operation deliberately refuses until its remaining legs exist. */
  const seamAbsent = (piece: string): never => {
    throw new HandoverError(
      'step_failed',
      `this build carries the shared session-transfer seam, but a handover cannot ${piece}: its ` +
        'handover-specific replacement, board and lifecycle composition is not wired yet',
    );
  };
  return new SessionHandoverService(
    {
      receipts,
      sessions: {
        /**
         * MISSING IS NOT UNREADABLE, and after `source_lost` exists the difference is destructive.
         *
         * `null` from this port means the session is externally ABSENT — which the handover is entitled
         * to act on: it may settle `source_lost`, and it may clean up a replacement it decides has no
         * predecessor left. A catch-all that turned every failure into `null` would hand that same
         * authority to a corrupt document, a closed index or a transient read fault, and the handover
         * would terminalize — and stop a live replacement — on evidence it never actually had.
         *
         * `SessionDirectorySubsystem.get` already draws the line: it resolves to `undefined` for a
         * session that is not there and REJECTS for a session it could not read. So the rejection is
         * propagated untouched, and the service parks and retries on the next tick rather than writing a
         * settlement. The same adapter answers for the source and for the replacement, so this holds for
         * both observations.
         */
        read: async sessionId => {
          const view = await wiring.sessions.get(sessionId);
          if (view === undefined) return null;
          return {
            sessionId: view.config.id,
            incarnation: view.config.incarnation,
            runtimeGeneration: view.config.runtimeGeneration,
            parentSessionId: view.config.parent ?? null,
            mode: view.config.mode,
            status: view.state.status,
            // The family as the DOCUMENT records it, unnarrowed: a session written by a future daemon
            // may name one this build has never heard of, and `harness_unknown` is the refusal that
            // exists for exactly that rather than a guess.
            harness: view.config.harness,
            agent: view.config.agent,
            teammate: view.config.teammate ?? null,
            cwd: view.config.cwd,
            label: view.config.label ?? null,
          };
        },
        create: async () => seamAbsent('create its replacement'),
        start: async () => seamAbsent('start its replacement'),
        stop: async () => seamAbsent('retire its predecessor'),
      },
      board: {
        requestInvitation: async () => seamAbsent('invite its replacement onto the board'),
        approveInvitation: async () => seamAbsent('approve its invitation'),
        acceptInvitation: async () => seamAbsent('accept its invitation'),
        requestChildGrant: async () => seamAbsent('request its coordinator grant'),
        approveChildGrant: async () => seamAbsent('approve its coordinator grant'),
        replaceCoordinator: async () => seamAbsent('seat its replacement coordinator'),
        relinquish: async () => seamAbsent('relinquish its predecessor membership'),
      },
      boardReader: {
        membership: async () => null,
        observe: async () => null,
      },
      accounts: {
        resolve: async (agent, model) => {
          const { account } = await resolveStartAccount(wiring.accounts, agent, wiring.executables, wiring.clientName);
          // The SAME planner the start and the move use, so the model a handover records and the
          // window it is measured against come from one decision rather than two that can disagree.
          const planned = wiring.planner.plan({
            id: 'handover-probe',
            account,
            mode: 'interactive',
            ...(model === null ? {} : { requestedModel: model }),
          });
          // A handover that named a model the replacement cannot serve is refused at RESOLUTION, which
          // is before a receipt exists: seating a replacement on the account's default instead would
          // retire the predecessor in favour of a session the requester never asked for.
          if (planned.kind === 'unservable-model') throw new HandoverError('step_failed', planned.reason);
          return {
            accountId: account.id,
            agent: account.agent,
            harness: account.kind,
            model: planned.plan.model,
            effort: null,
            contextWindow: planned.plan.contextWindow,
          };
        },
      },
      preparer: { prepare: async () => seamAbsent('prepare its transfer plan') },
      importer: { importPlan: async () => seamAbsent('import its transfer plan') },
      preflight: {
        // Advisory at `requested` and binding before the retirement. Absent a seam nothing reaches the
        // binding call, and answering "safe" here would be a claim about a pane this build never read.
        evaluate: async () => ({
          proceed: false,
          reason: 'no in-flight inventory was taken: this build cannot perform a handover',
          reportPath: null,
        }),
      },
      attention: { raise: async () => seamAbsent('raise its agenda item') },
      journal: {
        appendOnce: async input => await appendHandoverEventOnce(wiring.storage, wiring.journalSerial, input),
      },
      identity: { sessionId: () => crypto.randomUUID() },
      clock: { now: () => wiring.clock.now() },
    },
    DEFAULT_HANDOVER_SETTINGS,
  );
}

/** What the session-handover module is built from. */
export interface SessionHandoverNeeds {
  /** The state home's directories: the receipts live beside each session, under `sessions`. */
  readonly paths: FoundationPaths;
  readonly storage: DaemonStorage;
  /** The session directory the handover reads a source and its replacement through. */
  readonly sessions: SessionDirectorySubsystem;
  readonly accounts: AccountInventoryPort;
  readonly executables: ExecutableResolverPort;
  /** The process's one planner: the model a handover records comes from the same decision a start makes. */
  readonly planner: SessionPlanner;
  readonly clock: SystemClock;
  /** The binary name a person drives, which an account resolution is typed with. */
  readonly clientName: string;
  /** The housekeeping ledger the reconcile loop's passes run inside, or none. */
  readonly activities: ActivityLedger | undefined;
  /**
   * The repeating timer the reconcile loop runs on: the kernel clock's `every` (5.0 has no `setInterval` in a
   * subsystem). Called only when the loop is armed; returns its disarm.
   */
  readonly every: (intervalMs: number, tick: () => void) => () => void;
}

/** What other code uses of the session-handover module. */
export interface SessionHandoverProvides {
  /** The service the three routes drive; the loop drives this SAME service. */
  readonly handover: SessionHandoverService;
  /** The loop that finishes handovers nobody is watching. */
  readonly reconcile: HandoverReconcileLoop;
}

/** What `start()` arms. `arm` keeps the loop's own signature: synchronous, returning the disarm. */
export interface SessionHandoverJobs {
  readonly arm: () => () => void;
}

export const sessionHandoverModule: DaemonModule<
  void,
  SessionHandoverNeeds,
  SessionHandoverProvides,
  SessionHandoverJobs
> = {
  id: 'sessionHandover',
  build: (needs, _seams, _lifecycle) => {
    const { paths, storage, sessions, accounts, executables, planner, clock, clientName, activities, every } = needs;
    // ONE receipt store for both readers of it: the service that writes a receipt and the loop that
    // rosters the ones which are not yet terminal. Two handles over one directory would be two
    // answers to "what is still in flight".
    // Remembering which receipts are open, so the reconciler reads them all only at boot and on its
    // backstop, rather than every session directory every fifteen seconds.
    const handoverReceipts = new RememberedHandoverReceipts(new FileHandoverReceiptStore(paths.sessions));
    // Hoisted for the reason the move is: the reconcile loop drives THIS service rather
    // than a second one of its own. Two would each hold their own per-session serialization chain
    // over one receipt document, and the whole point of that chain is that a begin and a reconciler
    // tick for one predecessor cannot interleave.
    const handover = createSessionHandoverSubsystem(
      // Its own queue, constructed here so it lives as long as the daemon does: a serializer created
      // per call would serialize nothing, which is the whole failure this guards against.
      {
        paths,
        storage,
        sessions,
        accounts,
        executables,
        planner,
        clock,
        clientName,
        journalSerial: new KeyedSerialExecutor(),
      },
      handoverReceipts,
    );
    // The loop drives the SAME service the route serves, so a receipt advanced by a tick and one
    // begun by a request are the same document under the same lock. Its cadence is the domain's
    // own default; the scheduler is the composition root's, because a timer is not a `src/lib`
    // fact. Errors inside a pass are swallowed by the loop itself and surface as a receipt that
    // has not advanced, which is the honest reading of a supervision failure.
    const reconcile = new HandoverReconcileLoop(handover, handoverReceipts, {
      every: (intervalMs, tick) => every(intervalMs, asActivity(activities, 'handover reconcile', tick)),
    });
    return {
      id: 'sessionHandover',
      provides: { handover, reconcile },
      // A lambda, not `reconcile.arm.bind(...)`: the loop is looked up at the moment `start()` arms it.
      jobs: { arm: () => reconcile.arm() },
      contributes: sessionHandoverContribution(handover),
    };
  },
};
