import { describe, expect, it } from 'bun:test';
import type { BrowserStatus } from '@ferretry/protocol';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { RemoteBrowserViewer, type RemoteBrowserSocket } from '../../../src/features/browser/remote-browser-viewer.tsx';
import { render, run, runAsync } from '../../support/react.ts';

class FakeSocket implements RemoteBrowserSocket {
  readyState = 0;
  binaryType: BinaryType = 'blob';
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  readonly closes: { code?: number; reason?: string }[] = [];

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }

  emit(type: 'open' | 'message' | 'close' | 'error', event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'b' });
const running = (sessionId: string, pageId = 'page-a') =>
  ({
    sessionId,
    state: 'running',
    pages: [{ id: pageId, url: 'https://example.test', title: 'Example' }],
    activePageId: pageId,
    url: 'https://example.test',
    title: 'Example',
    canGoBack: false,
    canGoForward: false,
    pageState: 'ready',
    viewport: { width: 640, height: 480 },
    viewers: 1,
    persistentProfile: true,
    idleTimeoutSeconds: 60,
    capacity: { running: 1, maximum: 3 },
  }) satisfies BrowserStatus;

const frame = (pageId: string): ArrayBuffer => {
  const id = new TextEncoder().encode(pageId);
  const bytes = new Uint8Array(7 + id.length + 2);
  bytes.set([0x4b, 0x42, 0x52, 0x46, 1, 0, id.length]);
  bytes.set(id, 7);
  bytes.set([1, 2], 7 + id.length);
  return bytes.buffer;
};

describe('RemoteBrowserViewer', () => {
  it('stays idle while its retained surface is inactive', () => {
    const sockets: FakeSocket[] = [];
    const renderer = render(
      <RemoteBrowserViewer
        daemon={daemonA}
        scope={daemonSessionScope(daemonA, 'session-a')}
        streamTicket="ticket"
        status={running('session-a')}
        isActive={false}
        socketFactory={() => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        }}
      />,
    );
    expect(sockets).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('Display idle');
  });

  it('tears down the old daemon stream when an identical session is re-scoped', () => {
    const sockets: FakeSocket[] = [];
    const socketFactory = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    const scopeA = daemonSessionScope(daemonA, 'same-session');
    const renderer = render(
      <RemoteBrowserViewer
        daemon={daemonA}
        scope={scopeA}
        streamTicket="ticket-a"
        status={running('same-session')}
        socketFactory={socketFactory}
        createObjectUrl={() => 'blob:daemon-a'}
        revokeObjectUrl={() => undefined}
      />,
    );
    run(() => sockets[0]?.emit('message', new MessageEvent('message', { data: frame('page-a') })));
    expect(JSON.stringify(renderer.toJSON())).toContain('blob:daemon-a');
    run(() =>
      renderer.update(
        <RemoteBrowserViewer
          daemon={daemonB}
          scope={daemonSessionScope(daemonB, 'same-session')}
          streamTicket="ticket-b"
          status={running('same-session')}
          socketFactory={socketFactory}
          createObjectUrl={() => 'blob:daemon-b'}
          revokeObjectUrl={() => undefined}
        />,
      ),
    );
    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.closes).toEqual([{ code: 1000, reason: 'viewer detached' }]);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('blob:daemon-a');
  });

  it('renders only the active page frame and exposes a stalled stream instead of freezing silently', async () => {
    const socket = new FakeSocket();
    const renderer = render(
      <RemoteBrowserViewer
        daemon={daemonA}
        scope={daemonSessionScope(daemonA, 'session-a')}
        streamTicket="ticket"
        status={running('session-a')}
        socketFactory={() => socket}
        createObjectUrl={() => 'blob:latest-frame'}
        revokeObjectUrl={() => undefined}
        stallAfterMs={1}
      />,
    );
    run(() => socket.emit('open', new Event('open')));
    run(() => socket.emit('message', new MessageEvent('message', { data: frame('page-b') })));
    expect(JSON.stringify(renderer.toJSON())).not.toContain('blob:latest-frame');
    run(() => socket.emit('message', new MessageEvent('message', { data: frame('page-a') })));
    expect(JSON.stringify(renderer.toJSON())).toContain('blob:latest-frame');
    await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 5)));
    expect(JSON.stringify(renderer.toJSON())).toContain('Display stalled');
  });

  it('shows an actionable transport failure and reconnects after an unexpected close', async () => {
    const sockets: FakeSocket[] = [];
    const renderer = render(
      <RemoteBrowserViewer
        daemon={daemonA}
        scope={daemonSessionScope(daemonA, 'session-a')}
        streamTicket="ticket"
        status={running('session-a')}
        reconnectAfterMs={1}
        socketFactory={() => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        }}
      />,
    );
    run(() => sockets[0]?.emit('error', new Event('error')));
    expect(JSON.stringify(renderer.toJSON())).toContain('authenticated remote display connection failed');
    run(() => sockets[0]?.emit('close', new CloseEvent('close', { code: 1006 })));
    expect(JSON.stringify(renderer.toJSON())).toContain('Remote display disconnected; reconnecting');
    await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 5)));
    expect(sockets).toHaveLength(2);
  });
});
