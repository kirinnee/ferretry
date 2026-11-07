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
import { type UpdateHost, updateHostOf } from './lib/host.ts';
import type { UpdateLauncher } from './lib/ports.ts';
import { updateRoutes } from './lib/routes.ts';
import { DaemonUpdateService, UPDATE_BACKSTOP_INTERVAL_MS } from './lib/service.ts';

/** `<client> update`, started detached by the host so it outlives the restart it performs. */
function hostLauncher(host: UpdateHost): UpdateLauncher {
  return {
    launch: async target => {
      try {
        await host.launchUpdate(target, host.files);
        return { kind: 'started' };
      } catch (error) {
        return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

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
 * idle; one asked for `now` goes ahead). 5.0.0 ships with automatic installs OFF (§9.3). Without the host's update seam
 * (the release number and the means to start the update beside the daemon) the routes say so instead of guessing.
 */
export default implementDaemon(manifest, {
  build: ({ needs, kernel }) => {
    const host = updateHostOf(kernel);
    const autoInstall = (): boolean => kernel.config.file(UPDATES_CONFIG)?.autoInstall ?? false;
    const service =
      host === undefined
        ? undefined
        : new DaemonUpdateService({
            current: host.version,
            product: host.product,
            clientName: host.clientName,
            install: new HostInstallFacts(host, factCommand(kernel.spawn)),
            releases: new GitHubLatestRelease(host.product, kernel.fetch, {
              userAgent: `${host.daemonName}/${host.version}`,
            }),
            documents: new StateUpdateDocuments(kernel.state, kernel.log),
            autoInstall: { current: autoInstall },
            launcher: hostLauncher(host),
            activity: { midTurn: async () => (await needs.ferrets.list({ state: 'working' })).length },
            clock: { now: () => kernel.clock.nowMs() },
            checks: host.checks,
            checkIntervalMs: UPDATE_CHECK_INTERVAL_MS,
            onAvailable: latest => kernel.events.publish(UpdateAvailable, { latest }),
            onFinished: (target, outcome) => kernel.events.publish(UpdateFinished, { target, outcome }),
          });

    if (service !== undefined) {
      // At boot, then as a backstop; the idle moment itself arrives as `ferret.changed`.
      kernel.jobs.add({ id: 'update-boot', schedule: { onceAfterStart: true }, run: async () => await service.tick() });
      kernel.jobs.add({
        id: 'update',
        schedule: { every: milliseconds(UPDATE_BACKSTOP_INTERVAL_MS) },
        run: async () => await service.tick(),
      });
      let was = autoInstall();
      kernel.config.watch(UPDATES_CONFIG, () => {
        const now = autoInstall();
        if (now && !was) service.autoInstallTurnedOn();
        was = now;
      });
    }

    return {
      routes: updateRoutes(service, configDoorOf(kernel.config)),
      provides: {
        updates: {
          status: async () => {
            if (service === undefined) throw new Error('this daemon cannot read its own build yet');
            return statusOf(await service.view());
          },
        },
      },
      hooks: { 'ferret.changed': () => service?.activityChanged() },
    };
  },
});
