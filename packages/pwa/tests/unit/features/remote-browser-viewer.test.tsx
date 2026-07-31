import { describe, expect, it } from 'bun:test';
import type { BrowserInputEvent, BrowserStatus } from '@ferretry/protocol';
import { type RemoteBrowserSocket, RemoteBrowserViewer } from '../../../src/features/browser/remote-browser-viewer.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { render, run, runAsync } from '../../support/react.ts';

class FakeSocket implements RemoteBrowserSocket {
  readyState = 0;
  binaryType: BinaryType = 'blob';
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  readonly closes: { code?: number; reason?: string }[] = [];
  readonly sent: string[] = [];

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** The protocol input events this socket received, in order. */
  inputs(): BrowserInputEvent[] {
    return this.sent.map(entry => JSON.parse(entry) as BrowserInputEvent);
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

/** The frame's on-screen box, fixed so pointer maths is arithmetic, not layout. */
const frameRect = { left: 100, top: 50, width: 320, height: 240 };

const interactive = (overrides: Record<string, unknown> = {}) => {
  const sockets: FakeSocket[] = [];
  const activity: string[] = [];
  const renderer = render(
    <RemoteBrowserViewer
      daemon={daemonA}
      scope={daemonSessionScope(daemonA, 'session-a')}
      streamTicket="ticket"
      status={running('session-a')}
      interactive
      measureFrame={() => frameRect}
      onHumanActivity={kind => activity.push(kind)}
      now={() => 1_000}
      socketFactory={() => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }}
      createObjectUrl={() => 'blob:frame'}
      revokeObjectUrl={() => undefined}
      {...overrides}
    />,
  );
  const socket = sockets[0];
  if (socket === undefined) throw new Error('no socket was opened');
  run(() => {
    socket.readyState = 1;
    socket.emit('open', new Event('open'));
  });
  const canvas = renderer.root.find(node => node.props.className === 'fy-remote-browser-input');
  return { renderer, socket, canvas, activity };
};

const pointerEvent = (overrides: Record<string, unknown> = {}) => ({
  clientX: 260,
  clientY: 170,
  button: 0,
  buttons: 1,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  preventDefault: () => {},
  ...overrides,
});

const keyEvent = (overrides: Record<string, unknown> = {}) => ({
  key: 'a',
  code: 'KeyA',
  keyCode: 65,
  location: 0,
  repeat: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  nativeEvent: { isComposing: false },
  preventDefault: () => {},
  ...overrides,
});

describe('RemoteBrowserViewer input', () => {
  it('maps a click into the daemon-negotiated viewport, not the on-screen box', () => {
    const { socket, canvas, activity } = interactive();
    run(() => canvas.props.onPointerDown(pointerEvent()));
    run(() => canvas.props.onPointerUp(pointerEvent({ buttons: 0 })));
    // The frame is 320×240 on screen but the remote viewport is 640×480, so the
    // point is scaled: (260-100)/320 * 640 = 320, (170-50)/240 * 480 = 240.
    expect(socket.inputs()).toEqual([
      { kind: 'mouse', type: 'mousePressed', x: 320, y: 240, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 },
      { kind: 'mouse', type: 'mouseReleased', x: 320, y: 240, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 },
    ]);
    expect(activity).toEqual(['pointer']);
  });

  it('sends the same click count on press and release for a double-click', () => {
    const { socket, canvas } = interactive();
    run(() => canvas.props.onPointerDown(pointerEvent()));
    run(() => canvas.props.onPointerUp(pointerEvent()));
    run(() => canvas.props.onPointerDown(pointerEvent()));
    run(() => canvas.props.onPointerUp(pointerEvent()));
    expect(socket.inputs().map(input => (input.kind === 'mouse' ? input.clickCount : null))).toEqual([1, 1, 2, 2]);
  });

  it('forwards moves, wheels and a cancelled pointer', () => {
    const { socket, canvas } = interactive();
    run(() => canvas.props.onPointerMove(pointerEvent({ buttons: 0 })));
    run(() => canvas.props.onWheel(pointerEvent({ deltaX: 0, deltaY: 120, buttons: 0 })));
    run(() => canvas.props.onPointerCancel(pointerEvent({ buttons: 0 })));
    const inputs = socket.inputs();
    expect(inputs[0]).toMatchObject({ type: 'mouseMoved', button: 'none', clickCount: 0 });
    expect(inputs[1]).toMatchObject({ type: 'mouseWheel', deltaY: 120, button: 'none' });
    expect(inputs[2]).toMatchObject({ type: 'mouseReleased' });
  });

  it('releases every held key when the frame loses focus', () => {
    const { socket, canvas } = interactive();
    run(() => canvas.props.onKeyDown(keyEvent({ shiftKey: true })));
    run(() => canvas.props.onKeyDown(keyEvent({ key: 'b', code: 'KeyB', keyCode: 66 })));
    run(() => canvas.props.onBlur());
    const inputs = socket.inputs();
    expect(inputs).toHaveLength(4);
    // Released newest-first, with no text and no stale modifier state.
    expect(inputs[2]).toMatchObject({ type: 'keyUp', code: 'KeyB', modifiers: 0 });
    expect(inputs[3]).toMatchObject({ type: 'keyUp', code: 'KeyA', modifiers: 0 });
    // A second blur has nothing left to release.
    run(() => canvas.props.onBlur());
    expect(socket.inputs()).toHaveLength(4);
  });

  it('stops tracking a key once its own key-up has been sent', () => {
    const { socket, canvas } = interactive();
    run(() => canvas.props.onKeyDown(keyEvent()));
    run(() => canvas.props.onKeyUp(keyEvent()));
    run(() => canvas.props.onBlur());
    expect(socket.inputs()).toHaveLength(2);
  });

  it('lets the local paste chord through so the page paste handler can run', () => {
    const { socket, canvas, activity } = interactive();
    run(() => canvas.props.onKeyDown(keyEvent({ key: 'v', code: 'KeyV', ctrlKey: true })));
    expect(socket.inputs()).toEqual([]);
    run(() => canvas.props.onPaste({ clipboardData: { getData: () => 'pasted' }, preventDefault: () => {} }));
    expect(socket.inputs()).toEqual([{ kind: 'insertText', text: 'pasted' }]);
    expect(activity).toEqual(['paste']);
    // An empty clipboard is not an input event.
    run(() => canvas.props.onPaste({ clipboardData: { getData: () => '' }, preventDefault: () => {} }));
    expect(socket.inputs()).toHaveLength(1);
  });

  it('ignores keystrokes that are still being composed by an IME', () => {
    const { socket, canvas } = interactive();
    run(() => canvas.props.onKeyDown(keyEvent({ nativeEvent: { isComposing: true } })));
    expect(socket.inputs()).toEqual([]);
  });

  it('suppresses the local context menu over the live page', () => {
    const { canvas } = interactive();
    let prevented = false;
    run(() => canvas.props.onContextMenu({ preventDefault: () => (prevented = true) }));
    expect(prevented).toBe(true);
  });

  it('drops input while the socket is not open', () => {
    const { socket, canvas } = interactive();
    run(() => {
      socket.readyState = 3;
    });
    run(() => canvas.props.onPointerDown(pointerEvent()));
    expect(socket.inputs()).toEqual([]);
  });

  it('attaches no input handlers at all when the viewer is read-only', () => {
    const sockets: FakeSocket[] = [];
    const renderer = render(
      <RemoteBrowserViewer
        daemon={daemonA}
        scope={daemonSessionScope(daemonA, 'session-a')}
        streamTicket="ticket"
        status={running('session-a')}
        socketFactory={() => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        }}
      />,
    );
    // No input layer is rendered at all, so there is no focus stop to reach
    // and no handler to fire on a viewer that must stay read-only.
    expect(renderer.root.findAll(node => node.props.className === 'fy-remote-browser-input')).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  });

  it('falls back to the frame element when no measurement is injected', () => {
    const { socket, canvas } = interactive({ measureFrame: undefined });
    run(() => canvas.props.onPointerDown(pointerEvent()));
    // No DOM node is mounted here, so the point degrades to the origin rather
    // than being invented from a stale rect.
    expect(socket.inputs()[0]).toMatchObject({ x: 0, y: 0 });
  });
});
