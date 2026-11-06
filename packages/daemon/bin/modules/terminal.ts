import { stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { SessionConfigSchema, TERMINAL_MAX_GLOBAL, TERMINAL_MAX_PER_SESSION } from '@ferretry/protocol';
import type { DaemonStorage } from '../../src/adapters/storage/session-storage.ts';
import {
  ManagedTerminalService,
  RedactingTerminalStreamService,
  StorageTerminalOwnerDirectory,
  TerminalRuntimeError,
  TerminalServiceError,
  TerminalStreamBridge,
  type TerminalStreamScheduler,
} from '../../src/adapters/terminal/index.ts';
import {
  type AuditSink,
  type MillisecondClockPort,
  type QuarantineRegistry,
  SessionConsoleService,
  type SessionDirectorySubsystem,
  type TextRedactor,
  type TmuxCommandPort,
  TerminalMountError,
  type TerminalRuntimePort,
  type TerminalSessionResolver,
  type TerminalSubsystem,
  tryParseSessionId,
} from '../../src/lib/index.ts';
import type { InputRequestService } from '../../src/lib/input-requests/service.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import { terminalsContribution } from '../../src/lib/runtime/mounts/terminals.ts';
import type { SessionPaneProof } from '../../src/lib/session/console/index.ts';

/**
 * Independent shell terminals over a session's working directory, and the Console's typing into a session's own pane.
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter that
 * `DaemonWorld` carries beyond the terminal runtime, which `start()` passes into `createSubsystems` as `terminals` and
 * which is therefore a need) and no releases: the lifecycle service holds no timer and no handle, and a terminal
 * nobody watches is closed by the idle policy when the next request or the reaper's `closeFinished` looks at it.
 *
 * ONE JOB, armed by `start()`: `closeFinished`, which frees the web terminals a finished ferret left behind. It is
 * submitted to the housekeeping lane beside the pane reaper (`TerminalReapService`, a `DaemonWorld` factory `start()`
 * calls with the opened storage), on the line `start()` always had.
 *
 * ONE CONSTRUCTION POINT: `createSubsystems` builds the module on the line the terminal subsystem was always made on.
 * The Console service is made here too; it sat in the final mounted object, after the attach service it reads, which
 * exists by this line, and it is a constructor over two ports with no work of its own, so building it a little early
 * is inert.
 */

/**
 * Real one-shot timers for the terminal redraw poll.
 *
 * The bridge asks for a cancellable timer rather than accepting a runtime handle, so the only place
 * in the daemon that ever touches `setTimeout` for a stream is here. A handle typed `unknown` and
 * cast back at the cancel site would be the same thing with a cast in it.
 */
const terminalScheduler: TerminalStreamScheduler = {
  schedule: (callback, milliseconds) => {
    const handle = setTimeout(callback, milliseconds);
    return { cancel: () => clearTimeout(handle) };
  },
};

/**
 * Independent shell terminals, over the session's own working directory.
 *
 * THE ERROR TRANSLATION IS THE POINT OF THIS FUNCTION. `ManagedTerminalService` and the tmux runtime
 * behind it raise adapter-owned error classes, and a route in `src/lib` may not import them. Naming
 * them here — in the one place allowed to see both sides — is what lets a full terminal list answer
 * 409 and a tmux failure answer 502, instead of both surfacing as a 500 about a class nobody outside
 * `src/adapters` can name.
 *
 * The limits come from the PROTOCOL constants rather than the service's own defaults, so the ceiling
 * the API advertises in `limits` and the ceiling the service enforces cannot drift apart.
 *
 * The session resolver reads the authoritative configuration: a terminal opens in the session's own
 * `cwd`, and a session the index does not hold resolves to nothing rather than to the daemon's own
 * working directory.
 */
function createTerminalSubsystem(
  storage: DaemonStorage,
  runtime: TerminalRuntimePort,
  clock: MillisecondClockPort,
  redactor: TextRedactor,
  quarantine: QuarantineRegistry,
  audit: AuditSink,
): TerminalSubsystem {
  const sessions: TerminalSessionResolver = {
    resolve: async reference => {
      const id = tryParseSessionId(reference);
      if (id === undefined || storage.findSession(id) === undefined) return undefined;
      const config = SessionConfigSchema.safeParse(await storage.readConfig(id));
      return config.success ? { id, cwd: config.data.cwd } : undefined;
    },
  };
  const service = new ManagedTerminalService(
    runtime,
    sessions,
    clock,
    // A terminal id is twelve hex characters by protocol. Minting it from a UUID's own randomness
    // beats a counter the next process would restart at one and collide on.
    { next: () => crypto.randomUUID().replaceAll('-', '').slice(0, 12) },
    {
      maximumPerSession: TERMINAL_MAX_PER_SESSION,
      maximumGlobal: TERMINAL_MAX_GLOBAL,
      idleTimeoutMs: TERMINAL_IDLE_TIMEOUT_MS,
      isDirectory: async path => {
        try {
          // Absolute before it leaves the loop: a relative name on an I/O thread could resolve inside a macOS
          // descriptor bracket's folder (packages/fleet/src/adapters/descriptor-calls.ts).
          return (await stat(resolvePath(path))).isDirectory();
        } catch {
          return false;
        }
      },
      owners: new StorageTerminalOwnerDirectory(storage),
      onClosed: async (holder, trigger) =>
        await audit.record({
          event: 'terminal.closed',
          actor: { kind: 'host' },
          cause: 'daemon',
          subject: holder.sessionId,
          outcome: 'succeeded',
          detail: { count: holder.count, status: holder.status, trigger },
        }),
    },
  );
  /** Adapter refusals, restated in the protocol's vocabulary so the mount can answer them. */
  const translate = (error: unknown): never => {
    if (error instanceof TerminalServiceError) throw new TerminalMountError(error.code, error.message);
    if (error instanceof TerminalRuntimeError) throw new TerminalMountError('upstream_failed', error.message);
    throw error;
  };
  return {
    holders: async () => await service.holders().catch(translate),
    closeFinished: async trigger => await service.closeFinished(trigger).catch(translate),
    list: async sessionId => await service.list(sessionId).catch(translate),
    // The opener the mount DERIVED from the request's credential, forwarded unchanged. The service
    // is deliberately not given the request body's `agentSessionId`: ownership is decided where the
    // credential is, and a service that could read a claimed owner would eventually be asked to.
    create: async (sessionId, input, openedBy) =>
      await service
        .create(sessionId, {
          title: input.title,
          cols: input.cols,
          rows: input.rows,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.folder === undefined ? {} : { folder: input.folder }),
          ...(openedBy === undefined ? {} : { openedBy }),
        })
        .catch(translate),
    get: async (sessionId, terminalId) => await service.get(sessionId, terminalId).catch(translate),
    rename: async (sessionId, terminalId, title) => await service.rename(sessionId, terminalId, title).catch(translate),
    close: async (sessionId, terminalId) => await service.close(sessionId, terminalId).catch(translate),
    write: async (sessionId, terminalId, bytes) => await service.write(sessionId, terminalId, bytes).catch(translate),
    text: async (sessionId, terminalId, lines) => await service.text(sessionId, terminalId, lines).catch(translate),
    foreground: async (sessionId, terminalId) => await service.foreground(sessionId, terminalId).catch(translate),
    /**
     * One viewer socket, over the SAME lifecycle service the routes use.
     *
     * That sharing is the point: the bridge writes and captures through the service, so a keystroke
     * bumps the same activity instant the idle policy reads and a stream cannot keep a pane alive
     * that the lifecycle believes it closed. The bridge itself refuses an oversized or malformed
     * frame, bounds unwritten input, and drops output for a viewer that has stopped reading — the
     * mount hands it a socket and nothing more.
     */
    stream: async (sessionId, terminalId, downstream, options) =>
      new TerminalStreamBridge(
        new RedactingTerminalStreamService(
          service,
          redactor,
          options?.reveal === true ? undefined : (session, terminal) => quarantine.until(session, [terminal]),
        ),
        sessionId,
        terminalId,
        downstream,
        terminalScheduler,
      ),
  };
}

/** How long a terminal nobody is watching stays open. One hour, matching the service's own default;
 *  stated here so the number the API reports is the number the daemon enforces. */
const TERMINAL_IDLE_TIMEOUT_MS = 60 * 60_000;

/** What the terminal module is built from. */
export interface TerminalNeeds {
  /** The session index and configuration documents: a terminal opens in its session's own `cwd`. */
  readonly storage: DaemonStorage;
  /** Where a terminal actually runs: tmux panes on the daemon's own private socket (the world's `terminalRuntime`). */
  readonly runtime: TerminalRuntimePort;
  /** The wall clock in milliseconds, which the idle policy is measured on. */
  readonly clock: MillisecondClockPort;
  /** Scrubs a secret out of what a stream sends a viewer. */
  readonly redactor: TextRedactor;
  /** The terminals a secret was just typed into, kept from a viewer for a window. */
  readonly quarantine: QuarantineRegistry;
  /** The security log, which a terminal closed by the daemon is written to. */
  readonly audit: AuditSink;
  /** The session directory the Console's route checks the session against. */
  readonly sessions: SessionDirectorySubsystem;
  /** The attach proof, which names the pane the Console types into. */
  readonly sessionAttach: SessionPaneProof;
  /** The tmux commands the Console sends keys through, on the daemon's own private server. */
  readonly tmux: Pick<TmuxCommandPort, 'execute'>;
  /** The owner's answers to input requests, whose quarantine a stream's `reveal` is checked against. */
  readonly inputRequests: Pick<InputRequestService, 'revealed'>;
}

/** What other code may use from the terminal module: the lifecycle other modules and the agent tools open terminals through. */
export type TerminalProvides = TerminalSubsystem;

/** What `start()` arms. `closeFinished` keeps the subsystem's own signature, so a refusal is the translated one. */
export interface TerminalJobs {
  readonly closeFinished: TerminalSubsystem['closeFinished'];
}

export const terminalModule: DaemonModule<void, TerminalNeeds, TerminalProvides, TerminalJobs> = {
  id: 'terminal',
  build: needs => {
    const terminals = createTerminalSubsystem(
      needs.storage,
      needs.runtime,
      needs.clock,
      needs.redactor,
      needs.quarantine,
      needs.audit,
    );
    // The Console types into the pane the attach proof names, on the same private tmux server.
    const sessionConsole = new SessionConsoleService(needs.sessionAttach, needs.tmux);
    return {
      id: 'terminal',
      provides: terminals,
      // A lambda, not `terminals.closeFinished.bind(...)`: the subsystem is looked up at the moment `start()` arms it.
      jobs: { closeFinished: trigger => terminals.closeFinished(trigger) },
      contributes: terminalsContribution({
        terminals,
        sessionConsole,
        sessions: needs.sessions,
        inputRequests: needs.inputRequests,
      }),
    };
  },
};
