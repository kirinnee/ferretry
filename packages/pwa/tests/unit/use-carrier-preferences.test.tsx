/** This device's connection preferences and the tunnel service's answer, as React subscriptions. */

import { describe, it } from 'bun:test';
import should from 'should';
import { useCarrierPreferences, useTunnelService } from '../../src/hooks/use-carrier-preferences.ts';
import { CarrierPreferenceStore, type CarrierPreferences } from '../../src/lib/carrier-preference.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import type { TunnelServiceState } from '../../src/lib/tunnel-service.ts';
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
