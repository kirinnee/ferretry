import { randomUUID } from 'node:crypto';
import { ApiError } from '@ferretry/kernel/contract';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import { FERRET_SESSIONS_ROOT } from '../contract/index.ts';
import type manifest from '../manifest.ts';
import type { DaemonStorage } from './adapters/storage/session-storage.ts';
import type { ProcessHostFacts } from './adapters/moves/process-inventory.ts';
import type { MovesDeps } from './moves.ts';
import type { SessionMoveNeeds } from './modules/session-move.ts';
import type { SessionForkNeeds } from './modules/session-fork.ts';
import type { SessionId } from './lib/session-id.ts';

/**
 * What the moves are built from on this base (ferrets-c).
 *
 * The kernel-backed pieces are real: the state port, the storage over it, the clock, the redactor, the roots, spawn and
 * the host facts. Every other piece belongs to a service that is not built on this base (Ferrets' session lifecycle,
 * launch, resume, directory and planner — `notBuilt` in `index.ts` too) or to another plugin (Conversation's
 * transcript reader and attachment store, the harness plugins' quirks and catalogues, Runtimes' accounts, Terminals'
 * pane identity). Core imports no plugin (§2.1), so each is a FAIL-CLOSED SKELETON: building it touches nothing, and
 * calling it answers the spine's 503 `plugin_unavailable` instead of a route that is missing — the same answer
 * `index.ts` gives signal, restart and the archive list. A move, fork or handover that reaches one refuses before it
 * writes anything: every skeleton is read before the first side effect of the flow that uses it, or is itself the
 * first thing the flow calls.
 *
 * GAPS, each to be bound by its owner (name — owner):
 *   fork:     attachmentStore, attachments, conversation, selection, harnessFacts, transcripts, catalog, catalogs,
 *             harness — Conversation / the harness plugins; gateway — the managed worktree host (unbound in `index.ts`);
 *             accounts, planner, runtime, view, readableHandoffs — Ferrets' session services (`environment` and `createLifecycle` are bound by `index.ts` on the `sessions` root; the lifecycle's pane launcher is Terminals' and still unbound).
 *   handover: sessions, startAccount, planner — Ferrets' session services / Runtimes.
 *   move:     preflight, askAgent, sessions, planner (resume and launch are bound by `index.ts`) — Ferrets' session services; accounts,
 *             accountResolver, transcripts, transcriptProvenance, codexRollouts, toolkit, conversionCheck,
 *             harnessVersion, rolloutFormat, locateHarness, persistedReasoningEffort,
 *             contextWindowForSession — Runtimes / Conversation / the harness plugins; paneIdentity — Terminals;
 *             signals — the kernel has no signal capability for a pid; host.procWorkingDirectory — no cwd read.
 */

const unavailable = (what: string): ApiError =>
  new ApiError(503, `${what} is not built yet in this version of Ferretry.`, 'plugin_unavailable');

/** An object whose every member is a function that refuses with 503 when CALLED; reading one touches nothing. */
function unbound<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get: (_target, member) =>
      typeof member === 'symbol'
        ? undefined
        : () => {
            throw unavailable(`${what} (${member})`);
          },
  });
}

/** A function that refuses with 503 when called. */
function unboundFn<T extends (...args: never[]) => unknown>(what: string): T {
  return ((): never => {
    throw unavailable(what);
  }) as unknown as T;
}

/** What `index.ts` hands over: the one storage the moves share, opened over the kernel's state port. */
export interface MovesOwn {
  readonly storage: DaemonStorage;
  /** The binary name a person drives, which an account resolution is typed with. */
  readonly clientName: string;
  /** The move's relaunch, bound by Ferrets to its own resume; unbound, a move refuses before it writes anything. */
  readonly resume?: SessionMoveNeeds['resume'];
  /** The relaunch-settings read, over the ferret's own harness (W2-c); unbound, the read answers 503. */
  readonly launch?: SessionMoveNeeds['launch'];
  /** The session environment on each ferret's own folder of the `sessions` root; unbound, a fork refuses before it writes. */
  readonly environment?: SessionForkNeeds['environment'];
  /** One lifecycle for one session on its own folder; unbound, a fork refuses before it writes. */
  readonly createLifecycle?: SessionForkNeeds['createLifecycle'];
}

export function movesDeps(ctx: DaemonContext<typeof manifest>, own: MovesOwn): MovesDeps {
  const { kernel } = ctx;
  const { storage } = own;
  const clock = { now: () => kernel.clock.now() as string };
  const hostFacts = kernel.hostFacts;
  const host: ProcessHostFacts = {
    platform: hostFacts.platform,
    procFile: async (pid, file) => await hostFacts.procFile(pid, file),
    procSystemFile: async file => await hostFacts.procSystemFile(file),
    procTasks: async pid => await hostFacts.procTasks(pid),
    procTaskChildren: async (pid, task) => await hostFacts.procTaskChildren(pid, task),
    procFds: async pid => await hostFacts.procFds(pid),
    procFdLink: async (pid, fd) => await hostFacts.procFdLink(pid, fd),
    // The kernel offers no read of where a process is working, so a pane's cwd is not answered.
    procWorkingDirectory: async () => {
      throw unavailable('Reading where a process is working');
    },
  };
  // A target's own private folder on the internal `sessions` root (`state/ferrets/sessions/<ferret>`, today's session
  // directory): its first-turn brief is written there as its `turns/turn-001.md`, and the folder's path is the string its
  // rollout is later correlated by.
  const sessionRoot = (id: SessionId) => kernel.roots.root(FERRET_SESSIONS_ROOT, { subfolder: id });
  const sessionDirectory = (id: SessionId): string => {
    const folder = sessionRoot(id).resolve('.');
    if (!folder.ok) throw new Error(`ferret ${id} has no private session folder (${folder.error})`);
    return folder.value;
  };
  return {
    fork: {
      state: kernel.state,
      storage,
      sessionDirectory,
      briefs: sessionRoot,
      attachmentStore: unbound('The attachment store'),
      attachments: unbound('The attachment inventory'),
      conversation: unbound('The conversation reader'),
      redactor: kernel.redaction,
      selection: unbound('The message selection check'),
      gateway: unbound('The managed worktree host'),
      accounts: unbound('The account inventory'),
      planner: unbound('The session planner'),
      harness: unbound('The harness switch planner'),
      catalog: unbound('The runtime catalogue cache'),
      catalogs: unbound('The runtime catalogues'),
      harnessFacts: unbound('The harness facts'),
      createLifecycle: own.createLifecycle ?? unboundFn('The ferret lifecycle'),
      transcripts: unbound('The transcript capture'),
      environment: own.environment ?? unbound('The session environment'),
      runtime: unbound('The runtime startup record'),
      view: unboundFn('The ferret view'),
      readableHandoffs: unboundFn('The readable hand-off folders'),
      ids: { next: () => randomUUID() },
      clock,
    },
    handover: {
      state: kernel.state,
      storage,
      sessions: unbound('The session directory'),
      startAccount: unboundFn('The start account resolution'),
      planner: unbound('The session planner'),
      clock,
    },
    move: {
      state: kernel.state,
      roots: kernel.roots,
      spawn: kernel.spawn,
      host,
      clock: kernel.clock,
      storage,
      sessions: unbound('The session directory'),
      resume: own.resume ?? unbound('Resuming a ferret'),
      launch: own.launch ?? unbound('Launching a ferret'),
      preflight: unbound('The move preflight'),
      askAgent: unboundFn('Queueing a message'),
      planner: unbound('The session planner'),
      sessionDirectory,
      conversationId: () => randomUUID(),
      accounts: unbound('The account inventory'),
      accountResolver: unbound('The account resolution'),
      transcripts: unbound('The transcript reader'),
      transcriptProvenance: unbound('The transcript evidence'),
      codexRollouts: unbound('The Codex rollout index'),
      toolkit: unbound('The transcript converter'),
      conversionCheck: unbound('The conversion check'),
      harnessVersion: unbound('The harness version probe'),
      rolloutFormat: unbound('The rollout format probe'),
      locateHarness: unboundFn('Locating the harness'),
      readableHandoffs: unboundFn('The readable hand-off folders'),
      paneIdentity: unboundFn('The pane identity'),
      persistedReasoningEffort: unboundFn('The persisted reasoning effort'),
      contextWindowForSession: unboundFn('The context window'),
      signals: unbound('Signalling a process'),
      clientName: own.clientName,
    },
  };
}
