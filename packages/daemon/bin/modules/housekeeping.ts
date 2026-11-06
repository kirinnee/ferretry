import { join } from 'node:path';
import { FileScratchCollector } from '../../src/adapters/scratch/index.ts';
import { FileSpeedupTestLedger, type SpeedupLedgerFiles } from '../../src/adapters/speedups/index.ts';
import type { DaemonStorage } from '../../src/adapters/storage/session-storage.ts';
import {
  createSessionPaths,
  type FoundationPaths,
  type OutboundAuthorizerPort,
  parseSessionId,
  type ResumeLauncher,
  type SecretNameSource,
  type SpeedupClockPort,
} from '../../src/lib/index.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import type { ScratchReclamation } from '../../src/lib/runtime/mounts/health.ts';
import { housekeepingContribution } from '../../src/lib/runtime/mounts/housekeeping.ts';
import { JevTriageGuard, SpeedupsService, type TriageStopwatch } from '../../src/lib/speedups/index.ts';
import { type TidyPorts, TidyService } from '../../src/lib/tidy/index.ts';

/**
 * The daemon's housekeeping surfaces: the explicit scratch collector, one ferret's tidy plan and the speed-ups
 * status and Test (`/v1/gc`, `/v1/tidy/plan`, `/v1/speedups`).
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter that
 * `DaemonWorld` carries: the scratch collector, the speed-up ledger and the Jev guard are fixed production adapters;
 * the session storage, the outbound holder, the secret directory, the clock and the stopwatch are needs), no jobs and
 * no releases of its own: nothing here starts a timer — a scratch sweep runs only when an operator asks for one, a
 * tidy plan is a read, and a speed-up Test spends a key only on a request.
 *
 * The one thing other modules and the kernel read is {@link HousekeepingProvides.scratch}: the lifetime counters
 * the health report states beside `scratchGcEnabled`.
 *
 * Every constructor here is pure (they capture their inputs and read nothing), so the single build sits where the
 * last input it takes — the agenda's reader, built after the scratch collector used to be — exists.
 */

/** What the housekeeping module is built from. */
export interface HousekeepingNeeds {
  /** The slice of session storage the scratch collector lists and reads: the sessions, and each one's config and state. */
  readonly storage: Pick<DaemonStorage, 'listSessions' | 'readConfig' | 'readState'>;
  /** The state home's directories: a session's directory (its scratch lives there) and the speed-up ledger's folder. */
  readonly paths: FoundationPaths;
  /** The pane observer a sweep consults, so it cannot mistake another tmux server for ours. */
  readonly reviver: Pick<ResumeLauncher, 'observe'>;
  /** What one ferret's tidy plan reads: the board, its switches, the roster, the agenda, the sub-ferrets and this machine's id. */
  readonly tidy: TidyPorts;
  /** The speed-ups: the outbound holder a Test spends a key through, the names the vault holds and the ledger's files. */
  readonly speedups: {
    readonly authorizer: OutboundAuthorizerPort;
    readonly secrets: SecretNameSource;
    readonly stateFiles: SpeedupLedgerFiles;
    /** Stamps a Test's result. */
    readonly clock: Pick<SpeedupClockPort, 'now'>;
    /** Times a Test; the Jev guard times itself with the same one. */
    readonly stopwatch: TriageStopwatch;
  };
}

/** What other code reads off the housekeeping module. */
export interface HousekeepingProvides {
  /** What the scratch collector has reclaimed so far, as the health report states it. */
  readonly scratch: ScratchReclamation;
}

export const housekeepingModule: DaemonModule<void, HousekeepingNeeds, HousekeepingProvides> = {
  id: 'housekeeping',
  build: needs => {
    const { storage, paths, reviver, tidy, speedups } = needs;
    // One collector owns the lifetime counters health reports and the explicit `/v1/gc` surface.
    // It reads through opened storage and observes through the same revive adapter that would
    // replace a pane, so a scratch sweep cannot mistake another tmux server for ours.
    const scratchGc = new FileScratchCollector(
      {
        list: () => storage.listSessions(),
        config: async id => await storage.readConfig(parseSessionId(id)),
        state: async id => await storage.readState(parseSessionId(id)),
        directory: id => createSessionPaths(paths, parseSessionId(id)).directory,
      },
      { alive: async id => (await reviver.observe(parseSessionId(id))).alive },
    );
    const scratch: ScratchReclamation = {
      get enabled() {
        return scratchGc.totals().enabled;
      },
      get reclaimedSessions() {
        return scratchGc.totals().reclaimedSessions;
      },
      get reclaimedBytes() {
        return scratchGc.totals().reclaimedBytes;
      },
    };
    return {
      id: 'housekeeping',
      provides: { scratch },
      jobs: {},
      contributes: housekeepingContribution({
        scratchGc,
        tidy: new TidyService(tidy),
        speedups: new SpeedupsService({
          authorizer: speedups.authorizer,
          secrets: speedups.secrets,
          ledger: new FileSpeedupTestLedger(speedups.stateFiles, join(paths.state, 'speedups.json')),
          clock: { monotonicMs: () => speedups.stopwatch.monotonicMs(), now: () => speedups.clock.now() },
          guard: new JevTriageGuard(speedups.authorizer, speedups.stopwatch),
        }),
      }),
    };
  },
};
