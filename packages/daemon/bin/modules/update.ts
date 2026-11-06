import { dirname, isAbsolute, join } from 'node:path';
import {
  asActivity,
  CliUpdateLauncher,
  FileUpdateDocuments,
  GitHubLatestRelease,
  HostHarnessFacts,
  HostHarnessProbe,
  HostInstallFacts,
  NpmHarnessLatest,
  type UpdateStateFiles,
} from '../../src/adapters/index.ts';
import { runPackageInstall } from '../../src/adapters/process/package-install.ts';
import {
  type ActivityLedger,
  DaemonUpdateService,
  type ExecutableResolverPort,
  type FoundationPaths,
  type HarnessDiscoveryPolicy,
  HarnessUpdateService,
  locateHarnessCommand,
  type MillisecondClockPort,
} from '../../src/lib/index.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import { updateContribution } from '../../src/lib/runtime/mounts/update.ts';
import { daemonVersion, productName } from '../../src/lib/version.ts';

/**
 * Updating this machine: the daemon's own update (its install facts, the latest release, the check loop and
 * `fy daemon update` started detached beside this daemon) and the update of the `claude` and `codex` it launches
 * (docs/updating.md).
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter
 * that `DaemonWorld` carries) and no releases: everything it builds is inert until a request or the arming below.
 *
 * ONE JOB, armed by `start()`: the daemon update check, whose `arm()` returns its disarm synchronously. It is armed
 * after the bind, on the line `start()` always had; the harness update has no loop at all.
 */

/** What the update module is built from. */
export interface UpdateNeeds {
  /** The state home's directories: the update's own documents live under `state`, its client beside `home`. */
  readonly paths: FoundationPaths;
  /** The state home's confined filesystem, counted into the performance probe. */
  readonly stateFiles: UpdateStateFiles;
  /** The machine user's home directory, which an install's facts are read against. */
  readonly userHome: string;
  /** The binary name a person drives, which the daemon's update plan is typed with. */
  readonly clientName: string;
  /** The binary name of this daemon, which names it to GitHub and to npm. */
  readonly daemonName: string;
  readonly clock: MillisecondClockPort;
  /** The housekeeping ledger the update check runs inside, or none. */
  readonly activities: ActivityLedger | undefined;
  /** How many ferrets are mid-turn right now: an update waits for idle on it. */
  readonly midTurn: () => Promise<number>;
  /** Where this operator has said the harnesses are. */
  readonly harnessDiscovery: HarnessDiscoveryPolicy;
  /** The daemon's one executable resolver. */
  readonly executables: ExecutableResolverPort;
}

/** What other code uses of the update module. */
export interface UpdateProvides {
  /** The daemon's own update: its check loop, and the view, the start and the setting its routes serve. */
  readonly daemon: DaemonUpdateService;
  readonly harnesses: HarnessUpdateService;
}

/** What `start()` arms. `arm` keeps the update service's own signature: synchronous, returning the disarm. */
export interface UpdateJobs {
  readonly arm: () => () => void;
}

export const updateModule: DaemonModule<void, UpdateNeeds, UpdateProvides, UpdateJobs> = {
  id: 'update',
  build: needs => {
    const { paths, stateFiles, userHome, clientName, daemonName, clock, activities } = needs;
    // Updating this daemon (docs/updating.md): its install facts, the latest release from GitHub at
    // boot and at most every six hours, and `fy daemon update` started detached beside this daemon.
    const daemonUpdate = (() => {
      const directory = join(paths.state, 'update');
      const launched = isAbsolute(process.argv0) ? process.argv0 : process.execPath;
      return new DaemonUpdateService(
        {
          current: daemonVersion,
          product: productName,
          clientName,
          install: new HostInstallFacts({
            product: productName,
            argv0: process.argv0,
            execPath: process.execPath,
            main: Bun.main,
            homeDirectory: userHome,
            platform: process.platform,
            workingDirectory: process.cwd(),
            which: name => Bun.which(name) ?? undefined,
          }),
          releases: new GitHubLatestRelease(productName, { userAgent: `${daemonName}/${daemonVersion}` }),
          documents: new FileUpdateDocuments(stateFiles, directory),
          launcher: new CliUpdateLauncher({
            client: join(dirname(launched), clientName),
            stateHome: paths.home,
            files: stateFiles,
            directory,
            environment: process.env,
          }),
          activity: {
            midTurn: needs.midTurn,
          },
          clock,
          // A source run has no release to compare with, and an operator or a suite can switch it off.
          checks: Bun.main.startsWith('/$bunfs/') && process.env.FY_UPDATE_CHECK !== 'off',
        },
        {
          every: (intervalMs, tick) => {
            const handle = setInterval(asActivity(activities, 'update check', tick), intervalMs);
            return () => clearInterval(handle);
          },
        },
      );
    })();
    // Updating this machine's `claude` and `codex` (docs/updating.md › "Updating Claude Code and Codex"):
    // the file a runtime launches comes from the ONE harness resolution rule, its install facts are read
    // exactly as this daemon's own are, and npm is asked for the newest only when somebody looks.
    const harnessUpdate = new HarnessUpdateService({
      product: productName,
      homeDirectory: userHome,
      locate: kind => locateHarnessCommand(kind, needs.harnessDiscovery, needs.executables),
      facts: new HostHarnessFacts({ homeDirectory: userHome, platform: process.platform }),
      probe: new HostHarnessProbe(runPackageInstall, process.env),
      latest: new NpmHarnessLatest({ userAgent: `${daemonName}/${daemonVersion}` }),
      executables: needs.executables,
      run: runPackageInstall,
      environment: process.env,
      clock,
      checks: process.env.FY_UPDATE_CHECK !== 'off',
    });
    return {
      id: 'update',
      provides: { daemon: daemonUpdate, harnesses: harnessUpdate },
      // A lambda, not `daemonUpdate.arm.bind(...)`: the service is looked up at the moment `start()` arms it.
      jobs: { arm: () => daemonUpdate.arm() },
      contributes: updateContribution(daemonUpdate, harnessUpdate),
    };
  },
};
