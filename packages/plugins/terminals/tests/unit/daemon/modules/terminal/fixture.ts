import {
  type TerminalJobs,
  terminalModule,
  type TerminalNeeds,
  type TerminalProvides,
} from '../../../../../daemon/modules/terminal.ts';
import type { DaemonStorage } from '../../../../src/adapters/storage/session-storage.ts';
import {
  QuarantineRegistry,
  SessionConsoleService,
  type AuditSink,
  type SessionDirectorySubsystem,
  type TerminalRuntimePort,
  type TerminalSubsystem,
  type TextRedactor,
} from '../../../../src/lib/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import { terminalsContribution } from '../../../../../daemon/lib/runtime/mounts/terminals.ts';

/**
 * THE `terminal` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `terminalModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: a storage that holds no session, a terminal
 * runtime that lists nothing and starts nothing, and a tmux that is never asked to send a key. REAL TMUX NEVER RUNS
 * HERE: no double below spawns a process.
 *
 * Building starts nothing — the lifecycle service holds no timer and the stream bridge only schedules when a viewer
 * attaches — so there is no timer or async work to leave behind in the shared unit process (CI runs every non-PWA
 * unit test in ONE process, and a leftover timer breaks `unit-determinism.test.ts`).
 */

const NOT_EXERCISED = (what: string) => () => {
  throw new Error(`${what} is not exercised by the mounted-surface fixture`);
};

/** The inputs `fyd.ts` hands the module, over doubles. */
function terminalNeedsForTest(): TerminalNeeds {
  return {
    storage: {
      findSession: () => undefined,
      readConfig: NOT_EXERCISED('a config read'),
    } as unknown as DaemonStorage,
    runtime: {
      list: async () => [],
      start: NOT_EXERCISED('a terminal start'),
    } as unknown as TerminalRuntimePort,
    clock: { now: () => 0 },
    redactor: { redact: async (text: string) => text } as unknown as TextRedactor,
    quarantine: new QuarantineRegistry({ now: () => 0 }),
    audit: { record: NOT_EXERCISED('an audit record') } as unknown as AuditSink,
    sessions: { get: async () => undefined, list: async () => [] } as unknown as SessionDirectorySubsystem,
    sessionAttach: { resolve: NOT_EXERCISED('an attach proof') },
    tmux: { execute: NOT_EXERCISED('a tmux command') },
    inputRequests: { revealed: NOT_EXERCISED('a reveal') },
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtTerminal(): BuiltModule<TerminalProvides, TerminalJobs> {
  return terminalModule.build(terminalNeedsForTest(), undefined, LIFECYCLE);
}

/**
 * The module's contribution over a terminal subsystem a test supplies (the surface tests' `FakeTerminals`, which knows
 * the sessions the fixture holds): the routes, sockets and audit rules are the production ones, only the lifecycle
 * behind them is the test's.
 */
export function builtTerminalOver(terminals: TerminalSubsystem): BuiltModule<TerminalProvides, TerminalJobs> {
  const needs = terminalNeedsForTest();
  return {
    id: 'terminal',
    provides: terminals,
    jobs: { closeFinished: trigger => terminals.closeFinished(trigger) },
    contributes: terminalsContribution({
      terminals,
      sessionConsole: new SessionConsoleService(needs.sessionAttach, needs.tmux),
      sessions: needs.sessions,
      inputRequests: needs.inputRequests,
    }),
  };
}
