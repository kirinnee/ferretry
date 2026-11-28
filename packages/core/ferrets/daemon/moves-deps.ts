import { ApiError } from '@ferretry/kernel/contract';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import { milliseconds } from '@ferretry/std';
import type manifest from '../manifest.ts';
import type { HarnessFacts } from '../contract/index.ts';
import type { DaemonStorage } from './adapters/storage/session-storage.ts';
import { KernelProcessProbe, PaneProcessInventory, type ProcessHostFacts } from './adapters/moves/process-inventory.ts';
import { MovePreflight } from './lib/moves/preflight-service.ts';
import type { MovesDeps } from './moves.ts';
import type { SessionMoveNeeds } from './modules/session-move.ts';

/**
 * What the moves are built from on this base (ferrets-c).
 *
 * The kernel-backed pieces are real: the state port, the storage over it, the clock, the redactor, the roots, spawn and
 * the host facts. Every other piece belongs to a service that is not built on this base (Ferrets' session lifecycle,
 * launch, resume, directory and planner — `notBuilt` in `index.ts` too) or to another plugin (Conversation's
 * transcript reader and attachment store, the harness plugins' quirks and catalogues, Runtimes' accounts, Terminals'
 * pane identity). Core imports no plugin (§2.1), so each is a FAIL-CLOSED SKELETON: building it touches nothing, and
 * calling it answers the spine's 503 `plugin_unavailable` instead of a route that is missing — the same answer
 * `index.ts` gives signal, restart and the archive list. A move or handover that reaches one refuses before it
 * writes anything: every skeleton is read before the first side effect of the flow that uses it, or is itself the
 * first thing the flow calls.
 *
 * GAPS, each to be bound by its owner (name — owner):
 *   handover: sessions, startAccount, planner — Ferrets' session services / Runtimes.
 *   move:     askAgent — Ferrets' queue; transcripts — Conversation; signals — the kernel has no signal capability for a pid
 *             (the Terminals runner's `signalDescendant`); host.procWorkingDirectory — no cwd read.
 *             Nothing binds `signals` yet. Whoever does must reach a pid only through
 *             `runner.signalDescendant(handle, pid, start, signal, record.id)` (the ferret named, so a stale handle can never
 *             signal another ferret's tree), never through a raw pid signal.
 *             A Restart and a move onto another login are bound (`restart`, `login`, `pane`, `paneIdentity`, `sessions`).
 *             Converting onto another harness is not built: it waits for the harnesses' `exportConversation`/`adoptConversation`.
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
/** What Ferrets binds of the MOVE's own needs (the rest stay fail-closed skeletons; see the GAP list above). */
type MoveOwn = Partial<
  Pick<SessionMoveNeeds, 'sessions' | 'preflight' | 'pane' | 'restart' | 'login' | 'paneIdentity' | 'transcripts'>
>;

export interface MovesOwn {
  readonly storage: DaemonStorage;
  /** The binary name a person drives, which the gate recognises a ferret's own `fy` calls by. */
  readonly clientName: string;
  /** The facts of the harness a session records (a family word or a key), or `undefined` for one no harness answers for. */
  readonly harnessFacts: (harness: string) => HarnessFacts | undefined;
  /**
   * The job keeper (Terminals' `jobs.keeper` hook), read at the moment of a move; unbound, no attachment is known, none is
   * detached and the hand-over has no jobs section (the gate classifies as it always did).
   */
  readonly jobs?: SessionMoveNeeds['jobs'];
  /** The relaunch-settings read, over the ferret's own harness (W2-c); unbound, the read answers 503. */
  readonly launch?: SessionMoveNeeds['launch'];
  /** What a Restart and a move onto another login are built from; unbound, they answer 503 before they write. */
  readonly move?: MoveOwn;
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
  return {
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
      spawn: kernel.spawn,
      host,
      clock: kernel.clock,
      log: kernel.log.child('ferrets'),
      storage,
      sessions: unbound('The session directory'),
      launch: own.launch ?? unbound('Launching a ferret'),
      // The gate: the pane's process tree below the root its runner names, over the kernel's own host facts. The project's
      // configured servers are not read (no cwd read yet), so a server it cannot explain stays unclassified, never assumed.
      preflight: new MovePreflight(
        new PaneProcessInventory(new KernelProcessProbe(kernel.spawn, host, kernel.clock), {
          binaryName: own.clientName,
          toolsServerArguments: ['mcp', 'serve'],
          statuslineSubcommand: 'statusline',
          servers: { read: async () => [] },
          // The keeper's proven attachments of the ferret; no keeper installed, none is ever known. A keeper that does not
          // answer in time proves none (fail closed).
          attachments: async ferret => (await own.jobs?.()?.attachments(ferret)) ?? [],
          sleep: async ms => await kernel.clock.sleep(milliseconds(ms)),
        }),
        own.harnessFacts,
      ),
      askAgent: unboundFn('Queueing a message'),
      ...(own.jobs === undefined ? {} : { jobs: own.jobs }),
      transcripts: unbound('The transcript reader'),
      paneIdentity: unboundFn('The pane identity'),
      signals: unbound('Signalling a process'),
      pane: unboundFn('The ferret pane'),
      restart: unbound('Restarting a ferret'),
      login: unbound('Moving a ferret onto another login'),
      // Last, so what Ferrets binds replaces the fail-closed skeleton above it.
      ...own.move,
    },
  };
}
