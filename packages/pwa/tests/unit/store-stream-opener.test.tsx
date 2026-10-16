import { describe, expect, it } from 'bun:test';
import type { DaemonStreamOpener } from '../../src/lib/event-transport.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { RelayClientSession } from '../../src/lib/relay-session.ts';
import { type AppStore, StoreProvider, useDaemonStreamOpener } from '../../src/lib/store.tsx';
import { mount } from '../support/dom.ts';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'alpha-device' });
const request = { path: '/v1/sessions/s/browser/stream', onData: () => undefined };

function Probe({ onOpener }: { readonly onOpener: (opener: DaemonStreamOpener) => void }) {
  onOpener(useDaemonStreamOpener());
  return null;
}

describe('useDaemonStreamOpener', () => {
  it('opens a stream through the store carrier, so every stream rides the router', async () => {
    const session = {} as RelayClientSession;
    const asked: string[] = [];
    const store = {
      carrier: {
        openStream: async (_daemon: unknown, opened: { readonly path: string }) => {
          asked.push(opened.path);
          return session;
        },
      },
    } as unknown as AppStore;
    let opener: DaemonStreamOpener | undefined;
    const view = await mount(
      <StoreProvider store={store}>
        <Probe onOpener={value => (opener = value)} />
      </StoreProvider>,
    );
    expect(await opener?.(alpha, request)).toBe(session);
    expect(asked).toEqual([request.path]);
    await view.unmount();
  });

  it('refuses outside a store rather than reaching for the network', async () => {
    let opener: DaemonStreamOpener | undefined;
    const view = await mount(<Probe onOpener={value => (opener = value)} />);
    await expect(opener?.(alpha, request) ?? Promise.resolve()).rejects.toThrow('no paired carrier');
    await view.unmount();
  });
});
