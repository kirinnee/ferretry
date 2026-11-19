import { afterEach, describe, expect, it } from 'bun:test';
import { type ComponentType } from 'react';
import { noteClientDaemon, ShellContext } from '@ferretry/app/testing';
import { machineSettingsView } from '../../../../app/views/machine-settings-host.tsx';
import type { LiveRuntimesClient } from '../../../../app/lib/client.ts';
import { machine } from '../features/fleet/account-support.ts';
import { interact, mount, type Mounted } from '../../support/dom.ts';

/**
 * The setup rail's "Name your runtimes" step draws the machine settings host: when the machine is renamed while the step
 * is open, the words follow the NEW name (the one the header reads from the paired list), not the host name read first.
 */

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const DAEMON = 'fy_daemon_rail';

describe('the machine settings host after a rename', () => {
  it('says the live paired name, not the name its own read returned', async () => {
    let paired = [{ daemon: DAEMON, machine: 'ip-172-27-76-90' }];
    const listeners = new Set<() => void>();
    // The same `snapshot` object until a rename: a new one each read would make the external store loop.
    let snapshot = { daemons: paired };
    const shell = {
      runtime: {
        daemons: {
          snapshot: () => snapshot,
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      },
    };
    const client: LiveRuntimesClient = {
      call: (async () => machine({ name: 'ip-172-27-76-90' })) as LiveRuntimesClient['call'],
    };
    noteClientDaemon(client, DAEMON);
    const Settings = machineSettingsView(client, ({ machineName }) => (
      <p data-shown="">{machineName}</p>
    )) as unknown as ComponentType;

    mounted = await mount(
      <ShellContext.Provider value={shell as never}>
        <Settings />
      </ShellContext.Provider>,
    );
    const shown = (): string | undefined => mounted?.container.querySelector('[data-shown]')?.textContent ?? undefined;
    expect(shown()).toBe('ip-172-27-76-90');

    paired = [{ daemon: DAEMON, machine: 'Studio box' }];
    snapshot = { daemons: paired };
    await interact(async () => {
      for (const listener of listeners) listener();
    });
    expect(shown()).toBe('Studio box');
  });
});
