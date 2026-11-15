import { describe, expect, it } from 'bun:test';
import { interact, mount } from '@ferretry/app/testing';
import { useBrowserLogin } from '../../../../app/hooks/use-browser-login.ts';
import { DaemonBrowserLoginStore, browserLoginPort } from '../../../../app/lib/browser-login.ts';
import { daemonConnection, recordingClient } from '../../../support/app/client.ts';
import { withDocument } from '../../../support/app/dom.ts';

await withDocument();

const Probe = ({
  daemon,
  store,
  into,
}: {
  readonly daemon: ReturnType<typeof daemonConnection>;
  readonly store: DaemonBrowserLoginStore | undefined;
  readonly into: { current: ReturnType<typeof useBrowserLogin> | null };
}) => {
  into.current = useBrowserLogin(daemon, store);
  return null;
};

describe('useBrowserLogin', () => {
  it('without a store knows nothing and offers neither action', async () => {
    const into: { current: ReturnType<typeof useBrowserLogin> | null } = { current: null };
    const view = await mount(<Probe daemon={daemonConnection()} store={undefined} into={into} />);
    expect(into.current).toEqual({ status: null, open: undefined, close: undefined });
    await view.unmount();
  });

  it('with a store watches its daemon, opens with start and closes with the reader’s primed word', async () => {
    const { calls, client } = recordingClient(() => ({ state: 'closed', profilePrimed: false }));
    const daemon = daemonConnection({ client });
    const store = new DaemonBrowserLoginStore(bound => browserLoginPort(bound.client), { schedule: () => () => {} });
    const into: { current: ReturnType<typeof useBrowserLogin> | null } = { current: null };
    const view = await mount(<Probe daemon={daemon} store={store} into={into} />);
    await interact(async () => {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    });
    expect(into.current?.status).toEqual({ state: 'closed', profilePrimed: false });

    await interact(async () => {
      await into.current?.open?.();
      await into.current?.close?.(false);
    });
    expect(calls.filter(call => call.route.startsWith('POST')).map(call => call.init?.body)).toEqual([
      { action: 'start' },
      { action: 'stop', primed: false },
    ]);
    await view.unmount();
  });
});
