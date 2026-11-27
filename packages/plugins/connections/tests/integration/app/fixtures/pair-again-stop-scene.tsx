/**
 * A relay-only machine that is down when the app opens, ten minutes in: the real App and ShellRuntime over a fake machine
 * whose plugin list is refused the way a relay reports an absent daemon, so the shell draws its stop page and this plugin's
 * device view draws the Pair again offer above it. Fake data only (a made-up machine, no daemon, no code).
 * `?theme=<family>-<mode>&style=<look>`.
 */
import { implementApp } from '@ferretry/kernel/manifest';
import { provideToShell, RELAY_CLOSE_CODES, RelaySessionError } from '@ferretry/app';
import { applySceneTheme, CORE, renderSettingsShellOf, settingsSurface } from '@ferretry/app/testing/settings-shell';
import { pairAgainView } from '../../../../app/features/carrier/pair-again-offer.tsx';
import { PAIR_AGAIN_AFTER_MS } from '../../../../app/features/connection/connection-copy.ts';
import { browserConnectionHealthEnvironment, DaemonConnectionHealth } from '../../../../app/lib/connection-health.ts';
import manifest from '../../../../manifest.ts';

const params = applySceneTheme();
const MACHINE = 'ws';
const health = new DaemonConnectionHealth(
  browserConnectionHealthEnvironment({ now: () => 0, schedule: () => () => undefined }),
  async () => undefined,
);
health.outage(MACHINE, { failures: [], daemonAbsent: true, relaysNeverOpened: false });
const paired = {
  daemon: MACHINE,
  machine: 'workshop-host',
  deviceId: 'dev',
  address: 'http://127.0.0.1:40245',
  carriers: [{ kind: 'relay', url: 'https://relay.example' }],
  pairedAt: 1,
  lastSelectedAt: 1,
};
const snapshot = { daemons: [paired], selected: MACHINE };
const daemons = { snapshot: () => snapshot, subscribe: () => () => undefined };
const connections = {
  ...settingsSurface(manifest, {}),
  app: provideToShell(implementApp(manifest, { build: () => ({}) as never }), {
    device: {
      'pair-again': pairAgainView(() => ({ health, now: () => PAIR_AGAIN_AFTER_MS, daemons: daemons as never })),
    },
  }),
};
window.history.replaceState({}, '', `/d/${MACHINE}`);
renderSettingsShellOf([...CORE, connections], {
  answer: request => {
    if (request.path === '/v1/plugins')
      throw new RelaySessionError('Relay only — no daemon holds this rendezvous.', RELAY_CLOSE_CODES.daemonAbsent);
    return undefined;
  },
  carriers: paired.carriers,
  style: params.get('style') ?? 'studio',
});
