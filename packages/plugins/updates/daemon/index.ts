import { implementDaemon } from '@ferretry/kernel/manifest';
import { milliseconds } from '@ferretry/std';
import {
  type DaemonUpdateView,
  knownLatestRelease,
  UPDATE_CHECK_INTERVAL_MS,
  UpdateAvailable,
  UpdateFinished,
  type UpdateStatus,
  UPDATES_CONFIG,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { StateUpdateDocuments } from './adapters/documents.ts';
import { GitHubLatestRelease } from './adapters/github-releases.ts';
import { factCommand, HostInstallFacts } from './adapters/install-facts.ts';
import { configDoorOf } from './lib/config-door.ts';
import { processSeams } from './adapters/process-seams.ts';
import { updateHostUsable } from './lib/host.ts';
import { updateNames } from './lib/names.ts';
import { updateRoutes } from './lib/routes.ts';
import { DaemonUpdateService, UPDATE_BACKSTOP_INTERVAL_MS } from './lib/service.ts';

function statusOf(view: DaemonUpdateView): UpdateStatus {
  const latest = knownLatestRelease(view.check);
  return {
    current: view.current,
    ...(latest === undefined ? {} : { latest: latest.version }),
    available: view.available,
    autoInstall: view.autoInstall,
    midTurn: view.midTurn,
    ...(view.check.state === 'never' ? {} : { checkedAt: view.check.checkedAt }),
  };
}

/**
 * Updates (daemon half, §2.3): works out how this daemon was installed, asks GitHub for the latest release at boot and
 * at most every six hours, and starts the update when nobody has a turn in flight (an automatic update always waits for
 * idle; one asked for `now` goes ahead). 5.0.0 ships with automatic installs OFF (§9.3). The release number, the
 * running executable and the means to start the update beside the daemon are the kernel's `updateHost` port; when the
 * host gives this plugin none (its facts refuse) the routes say so instead of guessing a version.
 */
export default implementDaemon(manifest, {
  build: ({ needs, kernel }) => {
    const port = kernel.updateHost;
    const names = updateNames(kernel.identity.binaries);
    const host = { port, product: names.product, ...processSeams(kernel.paths.home()) };
    const autoInstall = (): boolean => kernel.config.file(UPDATES_CONFIG)?.autoInstall ?? false;
    const service = new DaemonUpdateService({
      current: port.release,
      product: names.product,
      clientName: names.client,
      install: new HostInstallFacts(host, factCommand(kernel.spawn)),
      releases: new GitHubLatestRelease(names.product, kernel.fetch, {
        userAgent: `${names.daemon}/${port.release}`,
      }),
      documents: new StateUpdateDocuments(kernel.state, kernel.log),
      autoInstall: { current: autoInstall },
      launcher: { launch: async target => await port.launchUpdate(target) },
      activity: { midTurn: async () => (await needs.ferrets.list({ state: 'working' })).length },
      clock: { now: () => kernel.clock.nowMs() },
      // A source run has no release to compare with, and `FY_UPDATE_CHECK=off` keeps a compiled one off GitHub: the
      // kernel folds both into the port, so this plugin never reads the environment.
      checks: port.checks,
      checkIntervalMs: UPDATE_CHECK_INTERVAL_MS,
      onAvailable: latest => kernel.events.publish(UpdateAvailable, { latest }),
      onFinished: (target, outcome) => kernel.events.publish(UpdateFinished, { target, outcome }),
    });
    // The host's answer, asked when needed: a plugin the host gave no build to read (the kernel's refusing stub)
    // is "unavailable" and nothing below acts on it.
    const ready = async (): Promise<boolean> => await updateHostUsable(port);

    // At boot, then as a backstop; the idle moment itself arrives as `ferret.changed`.
    const tick = async (): Promise<void> => {
      if (await ready()) await service.tick();
    };
    kernel.jobs.add({ id: 'update-boot', schedule: { onceAfterStart: true }, run: tick });
    kernel.jobs.add({ id: 'update', schedule: { every: milliseconds(UPDATE_BACKSTOP_INTERVAL_MS) }, run: tick });
    let was = autoInstall();
    kernel.config.watch(UPDATES_CONFIG, () => {
      const now = autoInstall();
      if (now && !was) service.autoInstallTurnedOn();
      was = now;
    });

    return {
      routes: updateRoutes(service, configDoorOf(kernel.config), ready),
      provides: {
        updates: {
          status: async () => {
            if (!(await ready())) throw new Error('this daemon cannot read its own build yet');
            return statusOf(await service.view());
          },
        },
      },
      hooks: { 'ferret.changed': () => service.activityChanged() },
    };
  },
});
