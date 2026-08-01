import { describe, expect, it } from 'bun:test';
import type { BrowserInputEvent, BrowserStatus } from '@ferretry/protocol';
import type { ReactNode } from 'react';
import { useLayoutEffect } from 'react';
import { type RemoteBrowserSocket, RemoteBrowserViewer } from '../../../src/features/browser/remote-browser-viewer.tsx';
import { type DaemonConnection, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { interact, mount } from '../../support/dom.ts';
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
  bytes.set([0x46, 0x59, 0x42, 0x46, 1, 0, id.length]);
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

  it('can defer its standalone header to an embedding pane', () => {
    const renderer = render(
      <RemoteBrowserViewer
        daemon={daemonA}
        scope={daemonSessionScope(daemonA, 'session-a')}
        streamTicket={null}
        status={null}
        showHeader={false}
      />,
    );
    expect(renderer.root.findAllByType('header')).toHaveLength(0);
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

  it('drops the previous grant’s pixels and its socket work when the same id is re-paired', () => {
    const sockets: FakeSocket[] = [];
    const socketFactory = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    // Same durable id, same session, rotated device grant. `(daemonId,
    // sessionId)` is byte-identical across this render, so only comparing the
    // connection can see it.
    const daemonARepaired = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://a.example.test',
      deviceToken: 'a2',
    });
    const viewerFor = (daemon: DaemonConnection, blob: string) => (
      <RemoteBrowserViewer
        daemon={daemon}
        scope={daemonSessionScope(daemon, 'same-session')}
        streamTicket="ticket"
        status={running('same-session')}
        socketFactory={socketFactory}
        createObjectUrl={() => blob}
        revokeObjectUrl={() => undefined}
      />
    );
    const renderer = render(viewerFor(daemonA, 'blob:old-grant'));
    run(() => sockets[0]?.emit('message', new MessageEvent('message', { data: frame('page-a') })));
    expect(JSON.stringify(renderer.toJSON())).toContain('blob:old-grant');

    run(() => renderer.update(viewerFor(daemonARepaired, 'blob:new-grant')));
    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.closes).toEqual([{ code: 1000, reason: 'viewer detached' }]);
    // Cleared during the rotating render itself, so the old grant's pixels are
    // never painted once under the new grant's identity.
    expect(JSON.stringify(renderer.toJSON())).not.toContain('blob:old-grant');

    // React tears an effect down AFTER the render that superseded it, so the old
    // socket can still deliver here. It must not be able to repaint.
    run(() => sockets[0]?.emit('message', new MessageEvent('message', { data: frame('page-a') })));
    expect(JSON.stringify(renderer.toJSON())).not.toContain('blob:old-grant');
    run(() => sockets[1]?.emit('message', new MessageEvent('message', { data: frame('page-a') })));
    expect(JSON.stringify(renderer.toJSON())).toContain('blob:new-grant');
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

  it('reconnects after every unexpected close and every manual retry', async () => {
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

    run(() => sockets[1]?.emit('close', new CloseEvent('close', { code: 1006 })));
    await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 5)));
    expect(sockets).toHaveLength(3);

    // The counter is an effect identity, not a one-way boolean: every click,
    // including clicks after earlier automatic reconnects, opens a fresh stream.
    run(() => renderer.root.findByType('button').props.onClick());
    expect(sockets).toHaveLength(4);
    run(() => renderer.root.findByType('button').props.onClick());
    expect(sockets).toHaveLength(5);
  });
});

/**
 * A layout effect runs once its own commit is in the DOM and before any passive
 * effect, so it sees exactly what a reader could have seen on screen — and it is
 * the only place a test can act while a superseded socket is still attached.
 */
function CommitProbe({ children, onCommit }: { readonly children: ReactNode; readonly onCommit: () => void }) {
  useLayoutEffect(onCommit);
  return <>{children}</>;
}

describe('RemoteBrowserViewer re-scoping', () => {
  it('never commits the previous daemon frame, and rejects its socket in the effect window', async () => {
    const sockets: FakeSocket[] = [];
    const socketFactory = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    const painted: string[] = [];
    const box: { container?: HTMLElement } = {};
    let duringCommit: (() => void) | null = null;
    const onCommit = () => {
      duringCommit?.();
      painted.push(box.container?.innerHTML ?? '');
    };
    const tree = (daemon: typeof daemonA, ticket: string, blob: string) => (
      <CommitProbe onCommit={onCommit}>
        <RemoteBrowserViewer
          daemon={daemon}
          scope={daemonSessionScope(daemon, 'same-session')}
          streamTicket={ticket}
          status={running('same-session')}
          socketFactory={socketFactory}
          createObjectUrl={() => blob}
          revokeObjectUrl={() => undefined}
        />
      </CommitProbe>
    );

    const mounted = await mount(tree(daemonA, 'ticket-a', 'blob:daemon-a'));
    box.container = mounted.container;
    const first = sockets[0];
    if (first === undefined) throw new Error('the viewer opened no stream');
    await interact(() => first.emit('message', new MessageEvent('message', { data: frame('page-a') })));
    expect(mounted.container.innerHTML).toContain('blob:daemon-a');

    painted.length = 0;
    // Daemon A's socket is not torn down until the passive effects of this same
    // commit run, so this is a late frame from a transport that no longer speaks
    // for the viewer — exactly the delivery that must not repopulate it.
    duringCommit = () => first.emit('message', new MessageEvent('message', { data: frame('page-a') }));
    await mounted.render(tree(daemonB, 'ticket-b', 'blob:daemon-b'));
    duringCommit = null;

    // Not one committed frame — not merely the settled tree — showed daemon A's
    // pixels once the viewer belonged to daemon B.
    expect(painted.length).toBeGreaterThan(0);
    expect(painted.some(html => html.includes('blob:daemon-a'))).toBe(false);
    expect(mounted.container.innerHTML).not.toContain('blob:daemon-a');
    expect(first.closes).toEqual([{ code: 1000, reason: 'viewer detached' }]);
    expect(sockets).toHaveLength(2);
    await mounted.unmount();
  });

  it('commits no page A frame after page B becomes active without reconnecting', async () => {
    const sockets: FakeSocket[] = [];
    const socketFactory = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    const objectUrls = ['blob:page-a', 'blob:page-b'];
    const createObjectUrl = () => objectUrls.shift() ?? 'blob:unexpected';
    const revoked: string[] = [];
    const revokeObjectUrl = (url: string) => revoked.push(url);
    const painted: string[] = [];
    const box: { container?: HTMLElement } = {};
    let duringCommit: (() => void) | null = null;
    const onCommit = () => {
      duringCommit?.();
      painted.push(box.container?.innerHTML ?? '');
    };
    const tree = (pageId: string) => (
      <CommitProbe onCommit={onCommit}>
        <RemoteBrowserViewer
          daemon={daemonA}
          scope={daemonSessionScope(daemonA, 'session-a')}
          streamTicket="ticket"
          status={running('session-a', pageId)}
          socketFactory={socketFactory}
          createObjectUrl={createObjectUrl}
          revokeObjectUrl={revokeObjectUrl}
        />
      </CommitProbe>
    );

    const mounted = await mount(tree('page-a'));
    box.container = mounted.container;
    const socket = sockets[0];
    if (socket === undefined) throw new Error('the viewer opened no stream');
    await interact(() => socket.emit('message', new MessageEvent('message', { data: frame('page-a') })));
    expect(mounted.container.innerHTML).toContain('blob:page-a');

    painted.length = 0;
    // Deliver another A frame during B's commit, before passive effects could
    // possibly clean anything up. Render-current filtering must reject it.
    duringCommit = () => socket.emit('message', new MessageEvent('message', { data: frame('page-a') }));
    await mounted.render(tree('page-b'));
    duringCommit = null;

    expect(painted.length).toBeGreaterThan(0);
    expect(painted.every(html => !html.includes('blob:page-a'))).toBe(true);
    expect(mounted.container.innerHTML).not.toContain('blob:page-a');
    expect(mounted.container.textContent).toContain('Waiting for the first frame');
    expect(sockets).toHaveLength(1);
    expect(socket.closes).toEqual([]);
    expect(revoked).toContain('blob:page-a');

    await interact(() => socket.emit('message', new MessageEvent('message', { data: frame('page-b') })));
    expect(mounted.container.innerHTML).toContain('blob:page-b');
    expect(sockets).toHaveLength(1);
    await mounted.unmount();
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
    socket.emit('message', new MessageEvent('message', { data: frame('page-a') }));
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
  pointerId: 1,
  pointerType: 'mouse',
  currentTarget: {
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  },
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

  it('captures each pointer through release/cancel and requests mobile text focus on touch', () => {
    const focusRequests: string[] = [];
    const { canvas, socket } = interactive({ onTouchInputFocus: () => focusRequests.push('focus') });
    const captured = new Set<number>();
    const released: number[] = [];
    const target = {
      setPointerCapture: (pointerId: number) => captured.add(pointerId),
      hasPointerCapture: (pointerId: number) => captured.has(pointerId),
      releasePointerCapture: (pointerId: number) => {
        captured.delete(pointerId);
        released.push(pointerId);
      },
    };
    let touchPrevented = false;

    run(() =>
      canvas.props.onPointerDown(
        pointerEvent({
          currentTarget: target,
          pointerId: 7,
          pointerType: 'touch',
          preventDefault: () => {
            touchPrevented = true;
          },
        }),
      ),
    );
    expect(captured.has(7)).toBe(true);
    expect(focusRequests).toEqual(['focus']);
    expect(touchPrevented).toBe(true);
    run(() => canvas.props.onPointerUp(pointerEvent({ currentTarget: target, pointerId: 7, buttons: 0 })));
    expect(captured.has(7)).toBe(false);

    run(() => canvas.props.onPointerDown(pointerEvent({ button: 2, buttons: 2, currentTarget: target, pointerId: 8 })));
    run(() =>
      canvas.props.onPointerCancel(pointerEvent({ button: -1, buttons: 0, currentTarget: target, pointerId: 8 })),
    );
    expect(released).toEqual([7, 8]);
    expect(focusRequests).toEqual(['focus']);
    expect(socket.inputs().at(-1)).toMatchObject({ type: 'mouseReleased', button: 'right' });
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

  it('releases held keys on window blur and document visibility loss', () => {
    const { socket, canvas } = interactive();
    run(() => canvas.props.onKeyDown(keyEvent()));
    run(() => window.dispatchEvent(new Event('blur')));
    expect(socket.inputs().at(-1)).toMatchObject({ type: 'keyUp', code: 'KeyA' });

    run(() => canvas.props.onKeyDown(keyEvent({ key: 'b', code: 'KeyB', keyCode: 66 })));
    const ownVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    try {
      run(() => document.dispatchEvent(new Event('visibilitychange')));
    } finally {
      if (ownVisibility === undefined) Reflect.deleteProperty(document, 'visibilityState');
      else Object.defineProperty(document, 'visibilityState', ownVisibility);
    }
    expect(socket.inputs().at(-1)).toMatchObject({ type: 'keyUp', code: 'KeyB' });
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
    // No DOM node is mounted here, so neither the image nor surface can report a
    // box; the point degrades to the origin rather than inventing a stale rect.
    expect(socket.inputs()[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('keeps 1:1 image and input pixels at the scroll box top-left', () => {
    const { renderer, canvas } = interactive({ fit: false });
    const container = renderer.root.find(node => node.props.className === 'fy-remote-browser-canvas');
    const image = renderer.root.findByType('img');

    expect(container.props.style).toMatchObject({
      alignItems: 'flex-start',
      justifyContent: 'flex-start',
      overflow: 'auto',
    });
    expect(image.props.style).toMatchObject({ flex: '0 0 auto', maxHeight: 'none', maxWidth: 'none' });
    expect(canvas.props).toMatchObject({ width: 640, height: 480 });
    expect(canvas.props.style).toMatchObject({ height: 480, maxHeight: 'none', maxWidth: 'none', width: 640 });
  });

  it('maps Fit clicks from the displayed image rectangle, never the letterboxed container', async () => {
    const globals = globalThis as typeof globalThis & { ResizeObserver?: unknown };
    const previousResizeObserver = globals.ResizeObserver;
    let observeResize: ResizeObserverCallback | undefined;
    class StubResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observeResize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globals.ResizeObserver = StubResizeObserver;
    const socket = new FakeSocket();
    const mounted = await mount(
      <RemoteBrowserViewer
        daemon={daemonA}
        scope={daemonSessionScope(daemonA, 'session-a')}
        streamTicket="ticket"
        status={running('session-a')}
        interactive
        fit
        socketFactory={() => socket}
        createObjectUrl={() => 'blob:fit-frame'}
        revokeObjectUrl={() => undefined}
      />,
    );
    await interact(() => {
      socket.readyState = 1;
      socket.emit('open', new Event('open'));
      socket.emit('message', new MessageEvent('message', { data: frame('page-a') }));
    });

    const container = mounted.container.querySelector<HTMLElement>('.fy-remote-browser-canvas');
    const image = mounted.container.querySelector<HTMLImageElement>('img[alt="Live remote browser frame"]');
    const surface = mounted.container.querySelector<HTMLCanvasElement>('.fy-remote-browser-input');
    if (container === null || image === null || surface === null) throw new Error('the fitted frame was not mounted');

    // A real layout reports a 320x240 image centered inside an 800x400 box.
    // Drive the image's load seam after installing those DOM facts so the
    // transparent surface is positioned from the actual letterboxed rectangle.
    expect(container.style.display).toBe('flex');
    expect(surface.width).toBe(640);
    expect(surface.height).toBe(480);

    const rect = (left: number, top: number, width: number, height: number): DOMRect =>
      ({
        bottom: top + height,
        height,
        left,
        right: left + width,
        top,
        width,
        x: left,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    container.getBoundingClientRect = () => rect(0, 0, 800, 400);
    image.getBoundingClientRect = () => rect(240, 80, 320, 240);
    await interact(() => image.dispatchEvent(new Event('load')));
    expect(surface.style.inset).toBe('auto');
    expect(surface.style.left).toBe('240px');
    expect(surface.style.top).toBe('80px');
    expect(surface.style.width).toBe('320px');
    expect(surface.style.height).toBe('240px');
    // Container/image resizes use the same measured rectangle seam; exercise
    // the observer callback rather than trusting the one-time image load.
    await interact(() => observeResize?.([], {} as ResizeObserver));

    // Keep coordinate conversion independently defensive: if a host stylesheet
    // regressed the canvas to the container, this off-centre point would map to
    // (256, 168), not the image-relative (160, 120).
    surface.getBoundingClientRect = () => rect(0, 0, 800, 400);
    surface.setPointerCapture = () => undefined;
    surface.hasPointerCapture = () => false;
    surface.releasePointerCapture = () => undefined;

    await interact(() =>
      surface.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          buttons: 1,
          clientX: 320,
          clientY: 140,
          pointerId: 9,
          pointerType: 'mouse',
        }),
      ),
    );
    expect(socket.inputs().at(-1)).toMatchObject({ type: 'mousePressed', x: 160, y: 120 });
    await mounted.unmount();
    if (previousResizeObserver === undefined) Reflect.deleteProperty(globals, 'ResizeObserver');
    else globals.ResizeObserver = previousResizeObserver;
  });
});
