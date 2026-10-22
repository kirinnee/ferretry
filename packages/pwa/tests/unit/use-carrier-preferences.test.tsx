/** This device's connection preferences and the tunnel service's answer, as React subscriptions. */

import { describe, it } from 'bun:test';
import should from 'should';
import type { TunnelStatusView } from '@ferretry/protocol';
import { useCarrierPreferences, useTunnelService, useTunnelSwitches } from '../../src/hooks/use-carrier-preferences.ts';
import { CarrierPreferenceStore, type CarrierPreferences } from '../../src/lib/carrier-preference.ts';
import { type DaemonConnection, type DaemonId, daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { TunnelServiceState } from '../../src/lib/tunnel-service.ts';
import { type TunnelSwitchState, TunnelSwitchStore } from '../../src/lib/tunnel-switch.ts';
import { render, run, runAsync } from '../support/react.ts';

const STUDIO = 'fy_daemon_studio' as DaemonId;

describe('useCarrierPreferences', () => {
  it('should re-render with every change this device makes', () => {
    const store = new CarrierPreferenceStore(undefined);
    let seen: CarrierPreferences | undefined;
    const Probe = (): null => {
      seen = useCarrierPreferences(store);
      return null;
    };
    const view = render(<Probe />);
    should(seen).eql({});
    run(() => store.set(STUDIO, 'tunnel'));
    should(seen).eql({ [STUDIO]: 'tunnel' });
    run(() => view.unmount());
  });
});

describe('useTunnelService', () => {
  it('should say nothing until the service answers, then its answer', async () => {
    let answer: (state: TunnelServiceState) => void = () => undefined;
    const pending = new Promise<TunnelServiceState>(resolve => {
      answer = resolve;
    });
    let seen: TunnelServiceState | undefined | 'unset' = 'unset';
    const read = async () => await pending;
    const Probe = (): null => {
      seen = useTunnelService(read);
      return null;
    };
    const view = render(<Probe />);
    should(seen).be.undefined();
    await runAsync(async () => {
      answer('available');
      await pending;
    });
    should(seen).equal('available');
    run(() => view.unmount());
  });

  it('should drop an answer that arrives after the reader went away', async () => {
    let answer: (state: TunnelServiceState) => void = () => undefined;
    const pending = new Promise<TunnelServiceState>(resolve => {
      answer = resolve;
    });
    let renders = 0;
    const read = async () => await pending;
    const Probe = (): null => {
      renders += 1;
      useTunnelService(read);
      return null;
    };
    const view = render(<Probe />);
    run(() => view.unmount());
    const before = renders;
    await runAsync(async () => {
      answer('unavailable');
      await pending;
    });
    should(renders).equal(before);
  });
});

describe('useTunnelSwitches', () => {
  const view = (state: TunnelStatusView['state'], enabled = true): TunnelStatusView => ({
    enabled,
    explicit: true,
    state,
    tunnelUrl: null,
    sentence: `Tunnel: ${state}`,
  });

  it('should ask every listed machine once, then keep asking only while a tunnel is being set up', async () => {
    const studio = daemonConnection({ daemonId: STUDIO, baseUrl: 'https://studio.example', deviceId: 'device-1' });
    const lab = daemonConnection({ daemonId: 'fy_daemon_lab', baseUrl: 'https://lab.example', deviceId: 'device-2' });
    const answers: Record<string, TunnelStatusView[]> = {
      [studio.daemonId]: [view('provisioning'), view('connecting'), view('up')],
      [lab.daemonId]: [view('off', false)],
    };
    const asked: string[] = [];
    const store = new TunnelSwitchStore({
      control: async daemon => {
        asked.push(daemon.daemonId);
        const queue = answers[daemon.daemonId] ?? [];
        return Response.json(queue.length > 1 ? queue.shift() : queue[0]);
      },
    });
    let seen: Readonly<Record<string, TunnelSwitchState>> = {};
    const Probe = ({ daemons }: { readonly daemons: readonly DaemonConnection[] }): null => {
      seen = useTunnelSwitches(store, daemons, 5);
      return null;
    };

    const rendered = render(<Probe daemons={[studio, lab]} />);
    await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 60)));

    should(seen[studio.daemonId]).eql({ kind: 'known', view: view('up') });
    should(seen[lab.daemonId]).eql({ kind: 'known', view: view('off', false) });
    should(asked.filter(id => id === lab.daemonId)).have.length(1);
    const settled = asked.length;
    await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 30)));
    should(asked).have.length(settled);

    // The same machines again ask nothing; unmounting stops everything.
    run(() => rendered.update(<Probe daemons={[studio, lab]} />));
    should(asked).have.length(settled);
    run(() => rendered.unmount());
  });
});
