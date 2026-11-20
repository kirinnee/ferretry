/**
 * THE ESCAPE IN THE SHELL'S REAL PLACE: a device view is drawn under `WithoutShell`, where the shell's own list of
 * paired machines answers nothing. The view must read the list Connections holds, or no machine ever gets its button.
 */
import { afterEach, expect, test } from 'bun:test';
import { deviceViewHarness, type Mounted, mount } from '@ferretry/app/testing';
import { carrierEscapeView } from '../../../app/features/carrier/carrier-escape.tsx';
import { CarrierPreferenceStore } from '../../../app/lib/carrier-preference.ts';
import type { ConnectionHealthState } from '../../../app/lib/connection-health.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const DAEMON = 'fy_daemon_a';
const reconnecting: ConnectionHealthState = {
  kind: 'reconnecting',
  since: 0,
  attempt: 0,
  nextAttemptAt: null,
  failures: [],
  cause: 'unknown',
  stalled: false,
};

test('a device view under WithoutShell offers the escape for a machine in an outage, and the button clears the choice', async () => {
  const harness = deviceViewHarness({ plugin: 'connections', fragments: [] });
  harness.setPaired([DAEMON]);
  const preferences = new CarrierPreferenceStore({
    getItem: () => JSON.stringify({ [DAEMON]: 'tunnel' }),
    setItem: () => undefined,
  });
  // The document-local list Connections holds (`connect.daemons`): one stable snapshot with the machine paired.
  const held = {
    daemons: [
      {
        daemon: DAEMON,
        machine: 'a-host',
        deviceId: 'd',
        address: 'https://daemon.test',
        carriers: [],
        pairedAt: 1,
        lastSelectedAt: 1,
      },
    ],
    selected: DAEMON,
  };
  const daemons = { snapshot: () => held, subscribe: () => () => undefined };
  const { Harness } = harness;
  const Escape = carrierEscapeView(() => ({
    preferences,
    health: { state: () => reconnecting, subscribe: () => () => undefined },
    daemons: daemons as never,
  }));
  view = await mount(
    <Harness>
      <Escape />
    </Harness>,
  );
  const button = view.container.querySelector('[data-carrier-escape-action]');
  expect(button?.textContent).toBe('Use the default (Relay)');
  expect(view.container.textContent).toContain('over “Tunnel only”');
});
