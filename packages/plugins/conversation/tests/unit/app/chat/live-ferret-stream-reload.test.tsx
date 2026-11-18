import { describe, expect, it } from 'bun:test';
import { Component, type ReactNode } from 'react';
import { DaemonClient, interact, mount } from '@ferretry/app/testing';
import { useLiveFerretStream } from '../../../../app/chat/live-ferret-stream.ts';

/**
 * A CHAT RELOAD on a remembered plugin list (r7 fix round): the chat opens its live socket in an effect, and on a reload
 * the device holds only the REMEMBERED list until the live one answers. The socket used to be refused right there
 * (`plugin_paused`), which threw into the screen's error boundary. Now it waits for the live list; a live "no" closes it
 * as a refusal instead. This runs the REAL hook against the REAL client.
 */
type Options = ConstructorParameters<typeof DaemonClient>[0];
type Surface = Options['surfaces'][number];
type Transport = Options['transport'];

const surfaceOf = (id: string, sockets: readonly string[] = []): Surface =>
  ({
    id,
    title: id,
    core: true,
    contract: `h-${id}`,
    consumes: [],
    manifest: {
      id,
      title: id,
      version: '5.0.0',
      api: 5,
      core: true,
      kinds: [],
      actions: {
        routes: [],
        sockets: sockets.map(key => ({ key, minimum: 'authenticated', caller: 'any', audit: 'skip' })),
      },
    },
  }) as unknown as Surface;

const surfaces = ['kernel', 'gate', 'vault', 'asks']
  .map(id => surfaceOf(id))
  .concat(surfaceOf('ferrets', ['GET /v1/events']));
const listed = (on: boolean) => ({
  protocol: 1,
  plugins: surfaces.map(s => ({ id: s.id, on: s.id === 'ferrets' ? on : true, contract: s.contract })),
});
const remembered = {
  kind: 'read' as const,
  entries: new Map(surfaces.map(s => [s.id, { on: true, contract: s.contract }] as const)),
};

class Boundary extends Component<{ readonly children: ReactNode; readonly caught: unknown[] }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    this.props.caught.push(error);
  }
  override render() {
    return this.state.failed ? <p data-testid="boundary">error</p> : this.props.children;
  }
}

function Chat({ client }: { readonly client: Parameters<typeof useLiveFerretStream>[0] }) {
  useLiveFerretStream(client, 'F1', () => {});
  return <p data-testid="chat">chat</p>;
}

async function reload(ferretsOn: boolean) {
  let answer: () => void = () => {};
  const gate = new Promise<void>(resolve => {
    answer = resolve;
  });
  const sockets: { path: string }[] = [];
  const transport: Transport = {
    request: async request =>
      request.path === '/v1/plugins'
        ? gate.then(() => ({ status: 200, headers: {}, body: listed(ferretsOn) }))
        : { status: 200, headers: {}, body: { protocol: 1, version: '5.0.0' } },
    events: () => () => {},
    socket: path => {
      sockets.push({ path });
      return { send: () => {}, close: () => {} };
    },
    onReconnect: () => () => {},
  };
  const client = new DaemonClient({ transport, surfaces, remembered });
  const caught: unknown[] = [];
  const view = await mount(
    <Boundary caught={caught}>
      <Chat client={client.forPackage('ferrets')} />
    </Boundary>,
  );
  return { sockets, client, caught, view, answer };
}

const pause = (ms: number) => interact(() => new Promise(resolve => setTimeout(resolve, ms)));

describe('the chat reloads on a remembered plugin list', () => {
  it('opens no socket and raises no error until the live list answers, then opens its stream', async () => {
    const { sockets, client, caught, view, answer } = await reload(true);
    try {
      await pause(10);
      expect(caught).toEqual([]);
      expect(view.container.querySelector('[data-testid="chat"]')).not.toBeNull();
      expect(sockets).toHaveLength(0);
      const started = client.start();
      answer();
      await started;
      await pause(10);
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.path).toContain('/v1/events');
      expect(caught).toEqual([]);
    } finally {
      await view.unmount();
    }
  });

  it('a live list that has the plugin off leaves no socket and no error boundary', async () => {
    const { sockets, client, caught, view, answer } = await reload(false);
    try {
      const started = client.start();
      answer();
      await started;
      await pause(10);
      expect(sockets).toHaveLength(0);
      expect(caught).toEqual([]);
      expect(view.container.querySelector('[data-testid="boundary"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
