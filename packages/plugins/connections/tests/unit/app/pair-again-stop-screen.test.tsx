/**
 * C-80b, THE MAIN CASE: A RELAY-ONLY MACHINE THAT IS DOWN WHEN THE APP IS OPENED OR RELOADED.
 *
 * Its plugin list cannot be read, so the shell replaces every screen of the machine with ONE stop page and draws none of
 * this plugin's panels. The ten-minute "Pair again" offer must still be there: it is a device view, drawn here by the real
 * App and ShellRuntime over a fake machine whose plugin list is refused the way a relay reports an absent daemon, a
 * health model on a fake clock, with and without a plugin list remembered from an earlier visit. No stored pairing is
 * touched by showing it or pressing it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp } from '@ferretry/kernel/manifest';
import { provideToShell, RELAY_CLOSE_CODES, RelaySessionError } from '@ferretry/app';
import { ensureDom, interact } from '@ferretry/app/testing';
import { CORE, renderSettingsShellOf, settingsSurface } from '@ferretry/app/testing/settings-shell';
import { pairAgainView } from '../../../app/features/carrier/pair-again-offer.tsx';
import { PAIR_AGAIN_AFTER_MS } from '../../../app/features/connection/connection-copy.ts';
import { browserConnectionHealthEnvironment, DaemonConnectionHealth } from '../../../app/lib/connection-health.ts';
import manifest from '../../../manifest.ts';

ensureDom();

const MACHINE = 'ws';
const RELAY = { kind: 'relay', url: 'https://relay.example' } as const;
const DIRECT = { kind: 'direct', url: 'https://studio.example' } as const;
const TUNNEL = { kind: 'tunnel', url: 'https://k3x9.tunnels.example.com' } as const;
const OUTAGE = { failures: [], daemonAbsent: true, relaysNeverOpened: false } as const;
const LINE = 'If Ferretry was reinstalled there, pair again.';
const NINE_MINUTES = 9 * 60_000;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

let shell: ReturnType<typeof renderSettingsShellOf> | undefined;
let root: HTMLElement | undefined;
afterEach(async () => {
  await interact(async () => shell?.unmount());
  shell?.forget();
  root?.remove();
  shell = undefined;
  root = undefined;
  window.history.replaceState({}, '', '/');
});

interface Options {
  /** What the clock reads, in ms after the outage began (at 0). */
  readonly at: number;
  readonly carriers?: readonly unknown[];
  /** A plugin list this device remembers from an earlier visit. */
  readonly remembered?: boolean;
  readonly path?: string;
}

async function open(options: Options) {
  const health = new DaemonConnectionHealth(
    browserConnectionHealthEnvironment({ now: () => 0, schedule: () => () => undefined }),
    async () => undefined,
  );
  health.outage(MACHINE, OUTAGE);
  const paired = {
    daemon: MACHINE,
    machine: 'workshop-host',
    deviceId: 'dev',
    address: 'http://127.0.0.1:40245',
    carriers: [...(options.carriers ?? [])],
    pairedAt: 1,
    lastSelectedAt: 1,
  };
  const snapshot = { daemons: [paired], selected: MACHINE };
  const daemons = { snapshot: () => snapshot, subscribe: () => () => undefined };
  const base = settingsSurface(manifest, {});
  const connections = {
    ...base,
    app: provideToShell(implementApp(manifest, { build: () => ({}) as never }), {
      device: { 'pair-again': pairAgainView(() => ({ health, now: () => options.at, daemons: daemons as never })) },
    }),
  };
  window.history.replaceState({}, '', options.path ?? `/d/${MACHINE}`);
  root = document.createElement('div');
  document.body.append(root);
  await interact(async () => {
    shell = renderSettingsShellOf(
      [...CORE, connections],
      {
        // The relay reports no daemon holding the rendezvous: the plugin list cannot be read.
        answer: request => {
          if (request.path === '/v1/plugins')
            throw new RelaySessionError(
              'Relay only — no daemon holds this rendezvous.',
              RELAY_CLOSE_CODES.daemonAbsent,
            );
          return undefined;
        },
        carriers: options.carriers ?? [],
        remembered: options.remembered ?? false,
      },
      root,
    );
  });
  await settle();
  return { health, paired };
}

const html = (): string => root?.innerHTML ?? '';
const text = (): string => root?.textContent ?? '';

describe.each([
  ['without a remembered plugin list', false],
  ['with a remembered plugin list', true],
])('a relay-only machine down at open, %s', (_name, remembered) => {
  test('at 9 minutes there is no offer', async () => {
    await open({ at: NINE_MINUTES, remembered });
    expect(html()).not.toContain('data-pair-again');
  });

  test('at 10 minutes the stop screen carries the line and Pair again; the button opens pairing for THAT machine and changes nothing stored', async () => {
    const { paired } = await open({ at: PAIR_AGAIN_AFTER_MS, remembered, carriers: [RELAY] });
    const before = JSON.stringify(paired);
    expect(root?.querySelector('[data-machine-stop]')).not.toBeNull();
    expect(html()).toContain('data-pair-again-button');
    expect(text()).toContain(LINE);
    expect(text().toLowerCase()).not.toContain('replaced');
    expect(text().toLowerCase()).not.toContain('removed');

    await interact(async () => root?.querySelector<HTMLElement>('[data-pair-again-button]')?.click());
    await settle();
    expect(window.location.pathname).toBe('/pair');
    expect(window.location.search).toBe(`?unreachable=${encodeURIComponent(MACHINE)}`);
    expect(JSON.stringify(paired)).toBe(before);
  });

  test('the first answer clears the offer', async () => {
    const { health } = await open({ at: PAIR_AGAIN_AFTER_MS, remembered });
    expect(html()).toContain('data-pair-again-button');
    await interact(async () => health.answered(MACHINE));
    expect(html()).not.toContain('data-pair-again');
  });
});

describe('who is offered it', () => {
  test('a direct or tunnel pairing is unchanged: no offer, however old the outage', async () => {
    for (const carriers of [
      [RELAY, DIRECT],
      [RELAY, TUNNEL],
    ]) {
      await open({ at: 60 * PAIR_AGAIN_AFTER_MS, carriers });
      expect(root?.querySelector('[data-machine-stop]')).not.toBeNull();
      expect(html()).not.toContain('data-pair-again');
      await interact(async () => shell?.unmount());
      shell?.forget();
      root?.remove();
    }
  });

  test('only the machine on screen is offered: This device’s settings page (Connection settings, from the stop page) stays clean', async () => {
    await open({ at: PAIR_AGAIN_AFTER_MS, path: '/settings?from=stop' });
    expect(root?.querySelector('[data-machine-stop]')).toBeNull();
    expect(html()).not.toContain('data-pair-again');
  });
});
