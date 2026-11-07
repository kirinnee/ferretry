import { configFilePath, type LimitsConfig, resolveLimits, SessionConfigSchema } from '@ferretry/protocol';
import {
  asActivity,
  CgroupFleetMemory,
  CgroupServiceWeights,
  deviceOfPath,
  FileLegacyCgroupDocuments,
  FileSessionSpawnFacts,
  PaneSessionMemory,
  ProcCgroupPlacements,
  RegisteredCgroupPaneLedger,
  SpawnCgroupCommands,
  type StateFileSystem,
  SysfsDiskScheduler,
} from '../../src/adapters/index.ts';
import { DurableTerminalPaneStore, ExactTmuxPaneReaper } from '../../src/adapters/session/lifecycle/index.ts';
import { processTreeFor } from '../../src/adapters/session/processes/index.ts';
import type { DaemonStorage } from '../../src/adapters/storage/session-storage.ts';
import {
  type BootNoticePort,
  type CgroupHostFacts,
  CgroupLaunchPlanner,
  EnforcementRuntime,
  FleetMemoryWatcher,
  type FoundationPaths,
  LegacyLimitsMigration,
  LIMITS_TICK_MS,
  LimitsService,
  parseSessionId,
  probeEnforcement,
  type ActivityLedger,
  type TmuxController,
} from '../../src/lib/index.ts';
import type { ConfigFilesService } from '../../src/lib/config-files/index.ts';
import { type DaemonModule, type LateBound, lateBound } from '../../src/lib/runtime/modules.ts';
import { cgroupsContribution } from '../../src/lib/runtime/mounts/cgroups.ts';

/**
 * Ferret resource limits (docs/ferret-limits.md), in two halves that `fyd.ts` constructs at two points.
 *
 * THE LAUNCH HALF is built while the world is: the planner every pane launch asks (terminals, browsers, revives,
 * the fork) is handed to world adapters that exist long before the subsystems do, so
 * {@link createCgroupLaunchLimits} keeps its place in `buildWorld`, statement for statement. THE SETTINGS HALF —
 * the memory watcher and its timer, the one-time migration of the retired `cgroups/config.json`, and the service
 * behind `GET /v1/cgroups/config` — is the `DaemonModule` below, built in `createSubsystems` where it was.
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter
 * that `DaemonWorld` carries: the measured host arrives as a `buildWorld` seam and is a need), no jobs `start()`
 * arms and no releases: its timer and migration start while it is built, as they did, and were never released.
 */

/** The collaborators the launch half is built from. */
export interface CgroupLaunchLimitsParts {
  /** The machine, measured ONCE (docs/ferret-limits.md). */
  readonly host: CgroupHostFacts;
  readonly configFiles: ConfigFilesService;
  readonly stateFiles: StateFileSystem;
  readonly paths: FoundationPaths;
  /** A ferret that had to start unconfined says so in the daemon log, not only in the status. */
  readonly warn: (message: string) => void;
}

/** What both halves share, and what the rest of `buildWorld` reads. */
export interface CgroupLaunchLimits {
  /** What this machine can enforce, asked once at boot (by the settings half) and again after a launch that failed. */
  readonly enforcement: EnforcementRuntime;
  /** The memory watcher, once it exists (its timer starts with the state home): the exit pass asks it about kills. */
  readonly kills: LateBound<FleetMemoryWatcher>;
  /** The `limits.yaml` in effect: the last good version, or its defaults. */
  readonly limitsInEffect: () => Promise<LimitsConfig>;
  readonly planner: CgroupLaunchPlanner;
}

/**
 * Fleet resource limits: the three collaborators both halves of the feature share.
 *
 * ONE DOCUMENT, ONE HOST, ONE COMMAND RUNNER, and two callers — the launch below, which decides
 * the argv a pane execs, and the settings subsystem further down, which reports and applies. They
 * are separate objects because they need different things (only the settings side reads live
 * placements), and they cannot disagree because every number either one uses is derived by
 * `src/lib/cgroups` from these same three.
 *
 * THE HOST IS MEASURED ONCE. A machine does not grow CPUs while a daemon runs, and reading it per
 * request would let the effective limit the panel displays differ from the property the next
 * launch writes.
 */
export function createCgroupLaunchLimits(parts: CgroupLaunchLimitsParts): CgroupLaunchLimits {
  const { host: cgroupHost, configFiles, stateFiles, paths } = parts;
  // Bounded. Both callers hold the session lifecycle's barrier while this runs, so a user manager
  // that accepts a connection and never answers would otherwise stall every session start, stop and
  // resume in the daemon for as long as it stayed silent.
  const cgroupCommands = new SpawnCgroupCommands();
  const sessionSpawnFacts = new FileSessionSpawnFacts(stateFiles, paths);
  /** What this machine can enforce, asked once at boot (below) and again after a launch that failed. */
  const limitsEnforcement = new EnforcementRuntime(
    async () => await probeEnforcement(cgroupHost, cgroupCommands),
    () => Date.now(),
  );
  /**
   * The memory watcher, once it exists (its timer starts with the state home): the exit pass asks it about kills.
   * Early-read answer: nothing yet, so the reader's `?.` yields `undefined`.
   */
  const memoryKills = lateBound<FleetMemoryWatcher>();
  /** The `limits.yaml` in effect: the last good version, or its defaults. */
  const limitsInEffect = async (): Promise<LimitsConfig> => (await configFiles.inEffect()).evaluation.effective.limits;
  const cgroupLaunchPlanner = new CgroupLaunchPlanner({
    limits: limitsInEffect,
    host: cgroupHost,
    commands: cgroupCommands,
    sessions: sessionSpawnFacts,
    enforcement: limitsEnforcement,
    // A nonce per launch, from the same source as every other unguessable value here, so a relaunch
    // cannot collide with a scope that is still deactivating.
    nonce: () => crypto.randomUUID().slice(0, 8),
    // A ferret that had to start unconfined says so in the daemon log, not only in the status.
    warn: parts.warn,
  });
  return { enforcement: limitsEnforcement, kills: memoryKills, limitsInEffect, planner: cgroupLaunchPlanner };
}

/** What the settings half is built from. */
export interface CgroupsNeeds {
  readonly paths: FoundationPaths;
  readonly stateFiles: StateFileSystem;
  /** The storage this boot opened. */
  readonly storage: DaemonStorage;
  readonly configFiles: ConfigFilesService;
  readonly activities: ActivityLedger;
  readonly launchTmux: TmuxController;
  /** The machine, measured ONCE: the same facts the launch half was built from. */
  readonly host: CgroupHostFacts;
  /** The launch half's shared collaborators (see {@link createCgroupLaunchLimits}); `kills` is bound here. */
  readonly enforcement: EnforcementRuntime;
  readonly kills: LateBound<FleetMemoryWatcher>;
  readonly limitsInEffect: () => Promise<LimitsConfig>;
  /** The boot's journal: a limit that is not enforced is said here once. */
  readonly notices: Pick<BootNoticePort, 'state'>;
}

/**
 * The settings half: a watch on the memory the fleet is using, the one-time migration of the retired
 * `cgroups/config.json` into `limits.yaml`, and the read-only service behind `GET /v1/cgroups/config`.
 */
function createLimitsSubsystem(needs: CgroupsNeeds): LimitsService {
  const { paths, stateFiles, storage, configFiles, activities, launchTmux, notices } = needs;
  const { host: cgroupHost, enforcement: limitsEnforcement, kills: memoryKills, limitsInEffect } = needs;
  // The SAME durable registration ledger the reap sweep reads, over the storage this boot
  // opened. Resource limits and the reap both need "which panes does this daemon own, and which
  // of their sessions are provably over" — two readers of one ledger, never two ledgers.
  const cgroupPanes = new DurableTerminalPaneStore(storage, stateFiles, paths);
  /**
   * Ferret limits (docs/ferret-limits.md): what the machine can enforce, and a watch on the memory the
   * fleet is using. The kernel's own counters are read on THIS timer only — never per request — and a
   * ferret hears about being slowed or killed in its own journal. On macOS there are no counters, so the
   * same timer sums each ferret's process tree and reports one over its share.
   */
  const limitsWatcher = new FleetMemoryWatcher({
    fleet: new CgroupFleetMemory(cgroupHost),
    memory: new PaneSessionMemory(
      new RegisteredCgroupPaneLedger(
        paths.home,
        { list: daemonId => cgroupPanes.scan(daemonId) },
        { list: daemonId => cgroupPanes.sessions(daemonId) },
        new ExactTmuxPaneReaper(launchTmux),
      ),
      processTreeFor(),
    ),
    notes: {
      note: async (sessionId, kind, data) => {
        await storage.append(parseSessionId(sessionId), `session.${kind}`, data);
      },
      callsign: async sessionId =>
        SessionConfigSchema.safeParse(await storage.readConfig(parseSessionId(sessionId))).data?.teammate,
    },
    now: () => Date.now(),
    iso: milliseconds => new Date(milliseconds).toISOString(),
  });
  memoryKills.bind(limitsWatcher);
  const limitsTick = asActivity(activities, 'ferret limits', async () => {
    const resolved = resolveLimits(await limitsInEffect(), { memoryCeilingBytes: cgroupHost.memoryCeilingBytes });
    if (!resolved.enabled) return;
    if (cgroupHost.platform === 'darwin') await limitsWatcher.tickWatch(resolved);
    else if (cgroupHost.platform === 'linux' && cgroupHost.unifiedHierarchy) await limitsWatcher.tickLinux();
  });
  setInterval(limitsTick, LIMITS_TICK_MS).unref();
  limitsTick();
  // Asked once at boot, so the first status already says why nothing is enforced; never blocks the start.
  void limitsEnforcement
    .refresh()
    .then(state => {
      if (state.kind === 'direct') notices.state(`ferret limits are not enforced: ${state.reason}`);
    })
    .catch(() => undefined);
  // ONCE: the retired `cgroups/config.json` becomes `limits.yaml`, keeping what the operator chose.
  const limitsFilePath = configFilePath({ kind: 'limits' });
  const legacyLimitsDocuments = new FileLegacyCgroupDocuments(stateFiles, paths);
  void new LegacyLimitsMigration({
    readOld: async () => await legacyLimitsDocuments.readOld(),
    retireOld: async () => await legacyLimitsDocuments.retireOld(),
    readLimits: async () => {
      const file = await configFiles.file(limitsFilePath);
      return { exists: file.exists, text: file.exists ? file.text : '', etag: file.etag };
    },
    writeLimits: async (text, etag) => {
      await configFiles.write(limitsFilePath, text, etag, false);
    },
  })
    .run()
    .then(outcome => {
      if (outcome.outcome === 'migrated')
        process.stderr.write(
          `limits: cgroups/config.json is now ${limitsFilePath}; the old file is kept as config.json.migrated\n`,
        );
      else if (outcome.outcome === 'kept') process.stderr.write(`limits: ${outcome.because}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `limits: the cgroups/config.json migration did not run: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  return new LimitsService({
    limits: limitsInEffect,
    host: cgroupHost,
    enforcement: limitsEnforcement,
    disk: new SysfsDiskScheduler(async () => await deviceOfPath(paths.home)),
    services: new CgroupServiceWeights(cgroupHost),
    watcher: limitsWatcher,
    placements: new ProcCgroupPlacements(),
    daemonPid: process.pid,
    file: limitsFilePath,
    uid: process.getuid?.() ?? 0,
    clock: iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
  });
}

export const cgroupsModule: DaemonModule<void, CgroupsNeeds, LimitsService> = {
  id: 'cgroups',
  build: needs => {
    const service = createLimitsSubsystem(needs);
    return { id: 'cgroups', provides: service, jobs: {}, contributes: cgroupsContribution(service) };
  },
};
