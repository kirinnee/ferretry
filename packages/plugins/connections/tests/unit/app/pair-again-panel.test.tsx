/**
 * C-80b: A RELAY-ONLY MACHINE THAT HAS BEEN UNREACHABLE FOR ABOUT TEN MINUTES, ON THE CONNECTION PANEL.
 *
 * A relay-only browser cannot tell a reinstalled machine from a sleeping one, so after a long outage the card offers
 * "Pair again" and leaves the decision to the person. Time comes from the injected clock; no stored pairing is touched.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { PairedDaemon } from '@ferretry/app';
import { interact, type Mounted, mount, noteClientDaemon, RouterProvider } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { buildConnectionsApp } from '../../../app/index.ts';
import { PAIR_AGAIN_AFTER_MS } from '../../../app/features/connection/connection-copy.ts';
import { browserConnectionHealthEnvironment, DaemonConnectionHealth } from '../../../app/lib/connection-health.ts';
import manifest from '../../../manifest.ts';

const DAEMON = `fy_daemon_${'A'.repeat(43)}`;
const RELAY = { kind: 'relay', url: 'https://relay.example' } as const;
const DIRECT = { kind: 'direct', url: 'https://studio.example' } as const;
const TUNNEL = { kind: 'tunnel', url: 'https://k3x9.tunnels.example.com' } as const;
const OUTAGE = { failures: [], daemonAbsent: true, relaysNeverOpened: false } as const;
const NINE_MINUTES = 9 * 60_000;
const LINE = 'If Ferretry was reinstalled there, pair again.';

const record = (carriers: readonly unknown[], pairedOver?: 'direct'): PairedDaemon => ({
  daemon: DAEMON,
  machine: 'studio',
  deviceId: 'fy_device_x',
  address: 'https://studio.example',
  ...(pairedOver === undefined ? {} : { pairedOver }),
  carriers: [...carriers],
  pairedAt: 1,
  lastSelectedAt: 1,
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  if (typeof window !== 'undefined') window.history.replaceState(null, '', '/');
});

/** One Connection panel over a made-up machine, with the clock the test holds and a health model that never schedules. */
function panel(stored: PairedDaemon, at: number) {
  // The health model's own clock: the outage began at 0 on it, so the card's age is `at`.
  const health = new DaemonConnectionHealth(
    browserConnectionHealthEnvironment({ now: () => 0, schedule: () => () => undefined }),
    async () => undefined,
  );
  const client = { call: async () => ({ carriers: [] }), subscribe: () => () => undefined } as unknown as PluginClient;
  noteClientDaemon(client, DAEMON);
  const Panel = buildConnectionsApp({ manifest, client }, undefined, undefined, {
    webrtc: undefined,
    tunnelSwitch: {} as never,
    health,
    now: () => at,
    daemons: { get: () => stored },
  }).panels.carrier;
  return { health, Panel };
}

const drawn = async (stored: PairedDaemon, at: number) => {
  const { health, Panel } = panel(stored, at);
  view = await mount(<div />);
  await view.unmount();
  view = await mount(
    <RouterProvider>
      <Panel />
    </RouterProvider>,
  );
  await interact(() => health.outage(DAEMON, OUTAGE));
  return health;
};
const html = (): string => view?.container.innerHTML ?? '';

describe('C-80b Pair again after a long relay-only outage', () => {
  test('nothing is offered at 9 minutes', async () => {
    await drawn(record([RELAY]), NINE_MINUTES);
    expect(html()).toContain('data-connection-outage');
    expect(html()).not.toContain('data-pair-again');
  });

  test('at 10 minutes the card says the line and offers Pair again; backoff keeps running; a reconnect clears it', async () => {
    const health = await drawn(record([RELAY]), PAIR_AGAIN_AFTER_MS);
    expect(html()).toContain('data-pair-again-button');
    expect(view?.container.textContent).toContain(LINE);
    // No verdict: neither a replacement nor a refusal is claimed.
    expect(view?.container.textContent?.toLowerCase()).not.toContain('replaced');
    expect(view?.container.textContent?.toLowerCase()).not.toContain('removed');
    // The outage is still the one that began at 0, and still on the backoff.
    expect(health.state(DAEMON)).toMatchObject({ kind: 'reconnecting', since: 0 });

    await interact(() => health.answered(DAEMON));
    expect(html()).not.toContain('data-pair-again');
  });

  test('the button opens pairing for THAT machine and changes no stored pairing', async () => {
    const stored = record([RELAY]);
    const before = JSON.stringify(stored);
    await drawn(stored, PAIR_AGAIN_AFTER_MS);

    await interact(() => view?.container.querySelector<HTMLElement>('[data-pair-again-button]')?.click());
    expect(window.location.pathname).toBe('/pair');
    expect(window.location.search).toBe(`?unreachable=${encodeURIComponent(DAEMON)}`);
    expect(JSON.stringify(stored)).toBe(before);
  });

  test('a direct or tunnel pairing is unchanged: no offer, however old the outage', async () => {
    for (const stored of [record([RELAY], 'direct'), record([RELAY, DIRECT]), record([RELAY, TUNNEL])]) {
      await drawn(stored, 60 * PAIR_AGAIN_AFTER_MS);
      expect(html()).toContain('data-connection-outage');
      expect(html()).not.toContain('data-pair-again');
      await view?.unmount();
      view = null;
    }
  });
});
