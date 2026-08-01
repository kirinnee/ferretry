import { describe, expect, it } from 'bun:test';
import type { BrowserAction, BrowserActionResult, BrowserInputEvent, BrowserStatus } from '@ferretry/protocol';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import {
  type RemoteBrowserDelay,
  RemoteBrowserPane,
  type RemoteBrowserPaneState,
  type RemoteBrowserSizeObserver,
  type RemoteContainerSize,
} from '../../../src/features/browser/remote-browser-pane.tsx';
import type { RemoteBrowserSocket } from '../../../src/features/browser/remote-browser-viewer.tsx';
import type { RemoteBrowserScheduler, RemoteBrowserTransport } from '../../../src/hooks/use-remote-browser.ts';
import type { DaemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { render, run, runAsync } from '../../support/react.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'b' });
const scopeA = daemonSessionScope(daemonA, 'same-session');
const scopeB = daemonSessionScope(daemonB, 'same-session');

const runningStatus = (viewportWidth = 640) =>
  ({
    sessionId: 'same-session',
    state: 'running',
    pages: [
      { id: 'page-a', url: 'https://example.test/', title: 'Example' },
      { id: 'page-b', url: 'https://other.test/', title: 'Other' },
    ],
    activePageId: 'page-a',
    url: 'https://example.test/',
    title: 'Example',
    canGoBack: true,
    canGoForward: false,
    pageState: 'ready',
    viewport: { width: viewportWidth, height: 480 },
    viewers: 1,
    persistentProfile: true,
    idleTimeoutSeconds: 600,
    capacity: { running: 1, maximum: 3 },
  }) satisfies BrowserStatus;

const stoppedStatus = () =>
  ({
    sessionId: 'same-session',
    state: 'stopped',
    pages: [],
    viewport: { width: 640, height: 480 },
    viewers: 0,
    persistentProfile: true,
    idleTimeoutSeconds: 600,
    capacity: { running: 0, maximum: 3 },
  }) satisfies BrowserStatus;

const pageErrorStatus = () =>
  ({
    ...runningStatus(),
    pageState: 'error',
    pageError: 'The page could not be loaded.',
  }) satisfies BrowserStatus;

const loadingStatus = () =>
  ({
    ...runningStatus(),
    pageState: 'loading',
  }) satisfies BrowserStatus;

const unavailableStatus = () =>
  ({
    ...stoppedStatus(),
    state: 'error',
    error: 'Chromium is unavailable on this daemon.',
  }) satisfies BrowserStatus;

/** A daemon transport that records every request against its own scope. */
class FakeTransport implements RemoteBrowserTransport {
  readonly reads: DaemonSessionScope[] = [];
  readonly actions: { readonly scope: DaemonSessionScope; readonly action: BrowserAction }[] = [];
  failure: Error | null = null;

  constructor(private status: BrowserStatus) {}

  readStatus = async (_daemon: DaemonConnection, scope: DaemonSessionScope): Promise<BrowserStatus> => {
    this.reads.push(scope);
    if (this.failure !== null) throw this.failure;
    return this.status;
  };

  runAction = async (
    _daemon: DaemonConnection,
    scope: DaemonSessionScope,
    action: BrowserAction,
  ): Promise<BrowserActionResult> => {
    this.actions.push({ scope, action });
    if (this.failure !== null) throw this.failure;
    return { status: this.status };
  };

  /** The actions dispatched so far, in order. */
  dispatched(): BrowserAction[] {
    return this.actions.map(entry => entry.action);
  }
}

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

/** A container observation seam that hands the callback back to the test. */
const sizeObserver = () => {
  const observed: ((size: RemoteContainerSize) => void)[] = [];
  let stopped = 0;
  const observeSize: RemoteBrowserSizeObserver = (_element, onResize) => {
    observed.push(onResize);
    return () => {
      stopped += 1;
    };
  };
  return {
    observeSize,
    attached: () => observed.length,
    stopped: () => stopped,
    resize: (size: RemoteContainerSize) => {
      const notify = observed.at(-1);
      if (notify === undefined) throw new Error('nothing is observing the container');
      notify(size);
    },
  };
};

/** A debounce seam, so the test decides when the delayed action actually runs. */
const delaySeam = () => {
  const pending: { callback: () => void; delayMs: number; cancelled: boolean; fired: boolean }[] = [];
  const delay: RemoteBrowserDelay = (callback, delayMs) => {
    const entry = { callback, delayMs, cancelled: false, fired: false };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const live = () => pending.filter(entry => !entry.cancelled && !entry.fired);
  return {
    delay,
    pending,
    live,
    fire: () => {
      const entry = live().at(-1);
      if (entry === undefined) throw new Error('no delayed work is pending');
      entry.fired = true;
      entry.callback();
    },
  };
};

/** A poll seam, so no test depends on a real 2.5s interval. */
const pollSeam = () => {
  const ticks: (() => void)[] = [];
  let cancelled = 0;
  const schedule: RemoteBrowserScheduler = callback => {
    ticks.push(callback);
    return () => {
      cancelled += 1;
    };
  };
  return { schedule, tick: () => ticks.at(-1)?.(), armed: () => ticks.length, cancelled: () => cancelled };
};

const sockets = () => {
  const opened: FakeSocket[] = [];
  return {
    opened,
    factory: () => {
      const socket = new FakeSocket();
      opened.push(socket);
      return socket;
    },
  };
};

/** A live remote screen box, so the pane's ref is a real element to observe. */
const screenNode = { nodeName: 'DIV' };
const textFocusRequests: (FocusOptions | undefined)[] = [];
const inputSurfaceNode = {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
};
const nodeMock = {
  createNodeMock: (element: { type: unknown }) =>
    element.type === 'div'
      ? screenNode
      : element.type === 'textarea'
        ? { focus: (options?: FocusOptions) => textFocusRequests.push(options) }
        : element.type === 'canvas'
          ? inputSurfaceNode
          : null,
};

const text = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : text(child))).join('');

const control = (renderer: ReactTestRenderer, label: string): ReactTestInstance => {
  const found = renderer.root
    .findAll(node => node.type === 'button')
    .find(node => node.props['aria-label'] === label || text(node).includes(label));
  if (found === undefined) throw new Error(`no control labelled “${label}” is rendered`);
  return found;
};

const json = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

const frame = (pageId: string): ArrayBuffer => {
  const id = new TextEncoder().encode(pageId);
  const bytes = new Uint8Array(7 + id.length + 2);
  bytes.set([0x46, 0x59, 0x42, 0x46, 1, 0, id.length]);
  bytes.set(id, 7);
  bytes.set([1, 2], 7 + id.length);
  return bytes.buffer;
};

/** Mounts the pane and lets the first status read settle. */
const mountPane = async (
  element: Parameters<typeof render>[0],
  options?: Parameters<typeof render>[1],
): Promise<ReactTestRenderer> => {
  const renderer = render(element, options);
  await runAsync(async () => undefined);
  return renderer;
};

describe('RemoteBrowserPane composition', () => {
  it('renders the daemon chrome, the display and the governor in source order', async () => {
    const transport = new FakeTransport(runningStatus());
    const poll = pollSeam();
    const renderer = await mountPane(
      <RemoteBrowserPane
        daemon={daemonA}
        scope={scopeA}
        streamTicket={null}
        transport={transport}
        schedule={poll.schedule}
      />,
    );
    const markup = json(renderer);
    const order = [
      'No input yet', // status bar
      'Chrome pages', // real page tabs
      'Navigate remote browser', // navigation
      'Responsive', // lifecycle/fit/viewport/paste controls
      'Type into remote browser', // mobile text entry
      'Remote browser display', // viewer
      '10m idle stop', // governor
    ].map(marker => markup.indexOf(marker));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    // The pane holds no transport of its own: everything it knows arrived
    // through the hook, for exactly this daemon and session.
    expect(transport.reads).toEqual([scopeA]);
  });

  it('dispatches every chrome action through the scoped hook', async () => {
    const transport = new FakeTransport(runningStatus());
    const poll = pollSeam();
    const renderer = await mountPane(
      <RemoteBrowserPane
        daemon={daemonA}
        scope={scopeA}
        streamTicket={null}
        transport={transport}
        schedule={poll.schedule}
      />,
    );
    const tabs = renderer.root.findAll(node => node.props.role === 'tab');
    await runAsync(async () => tabs[1]?.props.onClick());
    await runAsync(async () => control(renderer, 'Close Other').props.onClick());
    await runAsync(async () => control(renderer, 'New Chrome tab').props.onClick());
    await runAsync(async () => control(renderer, 'Back').props.onClick());
    await runAsync(async () => control(renderer, 'Reload').props.onClick());
    await runAsync(async () => control(renderer, 'Stop').props.onClick());
    await runAsync(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => undefined }));
    expect(transport.dispatched()).toEqual([
      { action: 'activate-page', pageId: 'page-b' },
      { action: 'close-page', pageId: 'page-b' },
      { action: 'new-page' },
      { action: 'back' },
      { action: 'reload' },
      { action: 'stop' },
      { action: 'navigate', url: 'https://example.test/' },
    ]);
    expect(transport.actions.every(entry => entry.scope === scopeA)).toBe(true);
  });

  it('starts a stopped browser and offers no live-only affordance', async () => {
    const transport = new FakeTransport(stoppedStatus());
    const poll = pollSeam();
    const renderer = await mountPane(
      <RemoteBrowserPane
        daemon={daemonA}
        scope={scopeA}
        streamTicket="ticket"
        transport={transport}
        schedule={poll.schedule}
      />,
    );
    // A stopped daemon reports no pages, so there is no invented client tab.
    expect(renderer.root.findAll(node => node.props.role === 'tab')).toHaveLength(0);
    expect(json(renderer)).toContain('Browser is stopped');
    expect(json(renderer)).toContain('kteam browser open');
    // The pane already owns the source status chrome; the viewer must not add a
    // second generic header inside the display.
    expect(renderer.root.findAllByType('header')).toHaveLength(0);
    await runAsync(async () => control(renderer, 'Start browser').props.onClick());
    expect(transport.dispatched()).toEqual([{ action: 'start' }]);
  });

  it('preserves the source loading and unavailable display treatments', async () => {
    const loading = await mountPane(
      <RemoteBrowserPane
        daemon={daemonA}
        scope={scopeA}
        streamTicket={null}
        transport={new FakeTransport(loadingStatus())}
        schedule={pollSeam().schedule}
      />,
    );
    const progress = loading.root.find(node => node.props.role === 'status');
    expect(text(progress)).toContain('Loading page…');

    const unavailable = await mountPane(
      <RemoteBrowserPane
        daemon={daemonA}
        scope={scopeA}
        streamTicket={null}
        transport={new FakeTransport(unavailableStatus())}
        schedule={pollSeam().schedule}
      />,
    );
    expect(json(unavailable)).toContain('Browser unavailable');
    expect(json(unavailable)).toContain('Chromium is unavailable on this daemon.');
  });

  it('refuses a scope that belongs to another daemon', () => {
    const transport = new FakeTransport(runningStatus());
    expect(() =>
      render(<RemoteBrowserPane daemon={daemonA} scope={scopeB} streamTicket={null} transport={transport} />),
    ).toThrow('remote browser scope must belong to the paired daemon');
  });
});

describe('RemoteBrowserPane scoping', () => {
  it('clears the previous daemon and rejects its late work when the session is re-scoped', async () => {
    const first = runningStatus(640);
    const second = runningStatus(800);
    const late = runningStatus(1024);
    const stream = sockets();
    const poll = pollSeam();
    let releaseLate: ((status: BrowserStatus) => void) | undefined;
    let reads = 0;
    const transport: RemoteBrowserTransport = {
      readStatus: async (daemon: DaemonConnection) => {
        if (daemon.daemonId !== daemonA.daemonId) return second;
        reads += 1;
        if (reads === 1) return first;
        // Daemon A's second poll never answers before the switch.
        return await new Promise<BrowserStatus>(resolve => {
          releaseLate = resolve;
        });
      },
      runAction: async () => ({ status: first }),
    };
    const paneFor = (daemon: DaemonConnection, scope: DaemonSessionScope) => (
      <RemoteBrowserPane
        daemon={daemon}
        scope={scope}
        streamTicket="ticket"
        transport={transport}
        schedule={poll.schedule}
        socketFactory={stream.factory}
        createObjectUrl={() => `blob:${daemon.daemonId}`}
        revokeObjectUrl={() => undefined}
      />
    );
    const renderer = await mountPane(paneFor(daemonA, scopeA));
    run(() => stream.opened[0]?.emit('message', new MessageEvent('message', { data: frame('page-a') })));
    expect(json(renderer)).toContain('blob:daemon-a');
    expect(json(renderer)).toContain('640×480');

    // Daemon A's in-flight poll is still outstanding at the moment of the switch.
    poll.tick();
    await runAsync(async () => renderer.update(paneFor(daemonB, scopeB)));

    expect(stream.opened[0]?.closes).toEqual([{ code: 1000, reason: 'viewer detached' }]);
    expect(json(renderer)).not.toContain('blob:daemon-a');
    expect(json(renderer)).toContain('800×480');

    await runAsync(async () => {
      releaseLate?.(late);
    });
    // The late daemon-A snapshot is dropped rather than painted over daemon B.
    expect(json(renderer)).not.toContain('1024×480');
    expect(json(renderer)).toContain('800×480');
  });

  it('detaches polling, the stream and the observer while retained but inactive', async () => {
    const transport = new FakeTransport(runningStatus());
    const stream = sockets();
    const poll = pollSeam();
    const observer = sizeObserver();
    const props = {
      daemon: daemonA,
      scope: scopeA,
      streamTicket: 'ticket',
      transport,
      schedule: poll.schedule,
      observeSize: observer.observeSize,
      socketFactory: stream.factory,
    };
    const renderer = await mountPane(<RemoteBrowserPane {...props} isActive={false} />, nodeMock);
    expect(transport.reads).toEqual([]);
    expect(poll.armed()).toBe(0);
    expect(stream.opened).toHaveLength(0);
    expect(observer.attached()).toBe(0);

    await runAsync(async () => renderer.update(<RemoteBrowserPane {...props} isActive />));
    expect(transport.reads).toHaveLength(1);
    expect(poll.armed()).toBe(1);
    expect(stream.opened).toHaveLength(1);
    expect(observer.attached()).toBe(1);

    await runAsync(async () => renderer.update(<RemoteBrowserPane {...props} isActive={false} />));
    expect(poll.cancelled()).toBe(1);
    expect(observer.stopped()).toBe(1);
    expect(stream.opened[0]?.closes).toHaveLength(1);
  });
});

describe('RemoteBrowserPane viewport', () => {
  const mountResizable = async (extra: Record<string, unknown> = {}) => {
    const transport = new FakeTransport(runningStatus());
    const poll = pollSeam();
    const observer = sizeObserver();
    const debounce = delaySeam();
    const renderer = await mountPane(
      <RemoteBrowserPane
        daemon={daemonA}
        scope={scopeA}
        streamTicket={null}
        transport={transport}
        schedule={poll.schedule}
        observeSize={observer.observeSize}
        delay={debounce.delay}
        {...extra}
      />,
      nodeMock,
    );
    return { renderer, transport, observer, debounce };
  };

  it('debounces a stream of container boxes into one validated resize action', async () => {
    const { transport, observer, debounce } = await mountResizable();
    run(() => observer.resize({ width: 400.4, height: 300.6 }));
    run(() => observer.resize({ width: 900, height: 700 }));
    // Only the newest box survives the debounce; the first was cancelled.
    expect(debounce.pending).toHaveLength(2);
    expect(debounce.live()).toHaveLength(1);
    expect(debounce.pending[0]?.delayMs).toBe(250);
    await runAsync(async () => debounce.fire());
    expect(transport.dispatched()).toEqual([{ action: 'resize', width: 900, height: 700 }]);

    // The daemon already holds that viewport, so an identical box is not work.
    run(() => observer.resize({ width: 900, height: 700 }));
    expect(debounce.live()).toHaveLength(0);
    expect(transport.dispatched()).toHaveLength(1);
  });

  it('never asks the daemon for a viewport it would reject', async () => {
    const { transport, observer, debounce } = await mountResizable();
    run(() => observer.resize({ width: 0, height: 0 }));
    expect(debounce.pending).toHaveLength(0);
    expect(transport.dispatched()).toEqual([]);
  });

  it('cancels a pending resize when the pane is torn down mid-debounce', async () => {
    const { renderer, transport, observer, debounce } = await mountResizable();
    run(() => observer.resize({ width: 900, height: 700 }));
    expect(debounce.live()).toHaveLength(1);
    await runAsync(async () => renderer.unmount());
    expect(debounce.live()).toHaveLength(0);
    expect(observer.stopped()).toBe(1);
    expect(transport.dispatched()).toEqual([]);
  });

  it('switches the frame between fit and true pixels', async () => {
    const stream = sockets();
    const { renderer } = await mountResizable({
      streamTicket: 'ticket',
      socketFactory: stream.factory,
      createObjectUrl: () => 'blob:frame',
      revokeObjectUrl: () => undefined,
    });
    run(() => stream.opened[0]?.emit('message', new MessageEvent('message', { data: frame('page-a') })));
    const box = () => renderer.root.findByProps({ className: 'fy-remote-browser-canvas' });
    const image = () => renderer.root.findByType('img');
    const hitbox = () => renderer.root.findByProps({ className: 'fy-remote-browser-input' });
    expect(box().props['data-fit']).toBe(true);
    expect(box().props.style).toMatchObject({
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    });
    // The viewer waits for the image's measured letterbox before exposing a
    // pointer surface; until then, an invisible zero-sized canvas cannot send
    // a click against the surrounding container. Its DOM-level viewer test
    // asserts the measured overlay after image load.
    expect(image().props.style).toMatchObject({ flex: '0 1 auto', minHeight: 0, minWidth: 0 });
    expect(hitbox().props.style).toMatchObject({ height: 0, visibility: 'hidden', width: 0 });

    await runAsync(async () => control(renderer, 'Fit').props.onClick());
    expect(box().props['data-fit']).toBeUndefined();
    expect(box().props.style).toMatchObject({
      alignItems: 'flex-start',
      justifyContent: 'flex-start',
      overflow: 'auto',
    });
    // 1:1 must LIFT that cap, or the toggle would rename itself and change
    // nothing on screen, and the hitbox follows the frame's true pixels so a
    // click past the first screenful is still mapped from the right rectangle.
    expect(image().props.style).toMatchObject({ flex: '0 0 auto', maxWidth: 'none', maxHeight: 'none' });
    expect(hitbox().props.style).toMatchObject({ width: 640, height: 480, maxWidth: 'none', maxHeight: 'none' });
    expect(text(control(renderer, '1:1'))).toContain('1:1');
  });

  it('re-negotiates the viewport when the desktop mode is chosen', async () => {
    const { renderer, transport, observer, debounce } = await mountResizable();
    run(() => observer.resize({ width: 900, height: 700 }));
    await runAsync(async () => debounce.fire());
    await runAsync(async () => control(renderer, 'Responsive').props.onClick());
    expect(text(control(renderer, 'Desktop fit'))).toContain('Desktop fit');
    // The same container box now means a different negotiated viewport, so the
    // suppression key must not swallow it.
    run(() => observer.resize({ width: 900, height: 700 }));
    await runAsync(async () => debounce.fire());
    expect(transport.dispatched()).toEqual([
      { action: 'resize', width: 900, height: 700 },
      { action: 'resize', width: 1280, height: 800 },
    ]);
  });

  it('observes nothing until the pane has a real screen element', async () => {
    const transport = new FakeTransport(runningStatus());
    const observer = sizeObserver();
    await mountPane(
      <RemoteBrowserPane
        daemon={daemonA}
        scope={scopeA}
        streamTicket={null}
        transport={transport}
        schedule={pollSeam().schedule}
        observeSize={observer.observeSize}
      />,
    );
    expect(observer.attached()).toBe(0);
  });

  it('drives the real ResizeObserver and timer when no seam is injected', async () => {
    const observers: { entries: (boxes: { contentRect: { width: number; height: number } }[]) => void }[] = [];
    class StubResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {
        observers.push({
          entries: boxes => this.callback(boxes as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver),
        });
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const globals = globalThis as typeof globalThis & { ResizeObserver?: unknown };
    const previous = globals.ResizeObserver;
    globals.ResizeObserver = StubResizeObserver;
    try {
      const transport = new FakeTransport(runningStatus());
      const renderer = await mountPane(
        <RemoteBrowserPane
          daemon={daemonA}
          scope={scopeA}
          streamTicket={null}
          transport={transport}
          schedule={pollSeam().schedule}
          resizeDebounceMs={1}
        />,
        nodeMock,
      );
      expect(observers).toHaveLength(1);
      // An entry-less callback is a box the observer cannot report on.
      run(() => observers[0]?.entries([]));
      run(() => observers[0]?.entries([{ contentRect: { width: 900, height: 700 } }]));
      await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 5)));
      expect(transport.dispatched()).toEqual([{ action: 'resize', width: 900, height: 700 }]);

      // A box observed on the way out leaves a real timer behind; tearing the
      // pane down has to clear it rather than resize a daemon nobody is watching.
      run(() => observers[0]?.entries([{ contentRect: { width: 1000, height: 800 } }]));
      await runAsync(async () => renderer.unmount());
      await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 5)));
      expect(transport.dispatched()).toHaveLength(1);
    } finally {
      globals.ResizeObserver = previous;
    }
  });

  it('simply reports no container changes when the runtime has no ResizeObserver', async () => {
    const globals = globalThis as typeof globalThis & { ResizeObserver?: unknown };
    const previous = globals.ResizeObserver;
    Reflect.deleteProperty(globals, 'ResizeObserver');
    try {
      const transport = new FakeTransport(runningStatus());
      const renderer = await mountPane(
        <RemoteBrowserPane
          daemon={daemonA}
          scope={scopeA}
          streamTicket={null}
          transport={transport}
          schedule={pollSeam().schedule}
        />,
        nodeMock,
      );
      // The daemon keeps its last negotiated viewport; the pane still works.
      expect(transport.dispatched()).toEqual([]);
      await runAsync(async () => renderer.unmount());
    } finally {
      if (previous !== undefined) globals.ResizeObserver = previous;
    }
  });
});

describe('RemoteBrowserPane text entry', () => {
  const mountLive = async (extra: Record<string, unknown> = {}) => {
    const transport = new FakeTransport(runningStatus());
    const stream = sockets();
    const renderer = await mountPane(
      <RemoteBrowserPane
        daemon={daemonA}
        scope={scopeA}
        streamTicket="ticket"
        transport={transport}
        schedule={pollSeam().schedule}
        socketFactory={stream.factory}
        createObjectUrl={() => 'blob:frame'}
        revokeObjectUrl={() => undefined}
        {...extra}
      />,
      nodeMock,
    );
    const socket = stream.opened[0];
    if (socket === undefined) throw new Error('the viewer opened no stream');
    run(() => {
      socket.readyState = 1;
      socket.emit('open', new Event('open'));
    });
    const field = renderer.root.findByType('textarea');
    return { renderer, transport, socket, field };
  };

  const field = (value: string) => ({ currentTarget: { value } });

  it('commits typed text as insertText without duplicating the printable key', async () => {
    const { socket, field: textarea } = await mountLive();
    run(() =>
      textarea.props.onKeyDown({
        key: 'é',
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: () => undefined,
      }),
    );
    run(() => textarea.props.onInput({ ...field('é'), nativeEvent: { isComposing: false } }));
    expect(socket.inputs()).toEqual([{ kind: 'insertText', text: 'é' }]);
  });

  it('still forwards the editing and navigation keys a text field cannot express', async () => {
    const { socket, field: textarea } = await mountLive();
    let prevented = false;
    run(() =>
      textarea.props.onKeyDown({
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        location: 0,
        repeat: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: () => {
          prevented = true;
        },
      }),
    );
    expect(prevented).toBe(true);
    expect(socket.inputs()).toEqual([
      {
        kind: 'key',
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        modifiers: 0,
        autoRepeat: false,
        isKeypad: false,
      },
    ]);
    // Blur releases what the field still holds down, so Chrome is never stuck.
    run(() => textarea.props.onBlur());
    expect(socket.inputs()[1]).toMatchObject({ type: 'keyUp', code: 'Enter', modifiers: 0 });
  });

  it('waits for an IME to finish composing before sending anything', async () => {
    const { socket, field: textarea } = await mountLive();
    run(() => textarea.props.onCompositionStart());
    run(() => textarea.props.onInput({ ...field('か'), nativeEvent: { isComposing: false } }));
    run(() => textarea.props.onKeyDown({ key: 'Process', nativeEvent: { isComposing: true } }));
    expect(socket.inputs()).toEqual([]);
    run(() => textarea.props.onCompositionEnd({ ...field('かな'), data: '漢字' }));
    expect(socket.inputs()).toEqual([{ kind: 'insertText', text: '漢字' }]);
    // A composition that ends with nothing committed is not an input event.
    run(() => textarea.props.onCompositionEnd({ ...field(''), data: '' }));
    // An `input` event the platform still marks as composing is not one either.
    run(() => textarea.props.onInput({ ...field('x'), nativeEvent: { isComposing: true } }));
    // Neither is an empty field.
    run(() => textarea.props.onInput({ ...field(''), nativeEvent: { isComposing: false } }));
    expect(socket.inputs()).toHaveLength(1);
  });

  it('sends a paste into the field exactly once and lets nothing else see it', async () => {
    const { socket, field: textarea } = await mountLive();
    let prevented = false;
    let stopped = false;
    const pasted = {
      clipboardData: { getData: () => 'pasted text' },
      currentTarget: { value: 'pasted text' },
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    };
    run(() => textarea.props.onPaste(pasted));
    expect(socket.inputs()).toEqual([{ kind: 'insertText', text: 'pasted text' }]);
    // The default action is consumed, so the field never keeps the text and the
    // `input` path cannot commit the same clipboard a second time.
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(pasted.currentTarget.value).toBe('');
    run(() => textarea.props.onInput({ ...field(''), nativeEvent: { isComposing: false } }));
    expect(socket.inputs()).toHaveLength(1);
    // An empty clipboard is not an input event at all.
    run(() =>
      textarea.props.onPaste({
        clipboardData: { getData: () => '' },
        currentTarget: { value: '' },
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      }),
    );
    expect(socket.inputs()).toHaveLength(1);
  });

  it('lets the local paste chord reach the native paste handler instead of forwarding it', async () => {
    const { socket, field: textarea } = await mountLive();
    const pressPasteChord = (key: string, ctrlKey: boolean, metaKey: boolean) => {
      let prevented = 0;
      const event = {
        key,
        code: 'KeyV',
        keyCode: 86,
        location: 0,
        repeat: false,
        altKey: false,
        ctrlKey,
        metaKey,
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: () => {
          prevented += 1;
        },
      };
      run(() => textarea.props.onKeyDown(event));
      run(() => textarea.props.onKeyUp(event));
      return prevented;
    };
    const paste = (text: string) =>
      run(() =>
        textarea.props.onPaste({
          clipboardData: { getData: () => text },
          currentTarget: { value: text },
          preventDefault: () => undefined,
          stopPropagation: () => undefined,
        }),
      );

    // Neither Ctrl-V nor Meta-V is cancelled or sent to remote Chrome; each
    // reaches the native paste handler and inserts the LOCAL clipboard once.
    expect(pressPasteChord('v', true, false)).toBe(0);
    expect(socket.inputs()).toEqual([]);
    paste('local clipboard');
    expect(pressPasteChord('V', false, true)).toBe(0);
    expect(socket.inputs()).toEqual([{ kind: 'insertText', text: 'local clipboard' }]);
    paste('meta clipboard');
    expect(socket.inputs()).toEqual([
      { kind: 'insertText', text: 'local clipboard' },
      { kind: 'insertText', text: 'meta clipboard' },
    ]);
  });

  it('falls back to the field value when the composition event carries no data', async () => {
    const { socket, field: textarea } = await mountLive();
    run(() => textarea.props.onCompositionEnd({ ...field('かな'), data: '' }));
    expect(socket.inputs()).toEqual([{ kind: 'insertText', text: 'かな' }]);
  });

  it('focuses the mobile text seam without scrolling when a touch begins on the frame', async () => {
    textFocusRequests.length = 0;
    const { renderer, socket } = await mountLive();
    run(() => socket.emit('message', new MessageEvent('message', { data: frame('page-a') })));
    const surface = renderer.root.findByProps({ className: 'fy-remote-browser-input' });
    let prevented = false;
    const captured: number[] = [];
    run(() =>
      surface.props.onPointerDown({
        pointerId: 7,
        pointerType: 'touch',
        clientX: 24,
        clientY: 32,
        button: 0,
        buttons: 1,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        preventDefault: () => {
          prevented = true;
        },
        currentTarget: {
          setPointerCapture: (pointerId: number) => captured.push(pointerId),
        },
      }),
    );
    expect(textFocusRequests).toEqual([{ preventScroll: true }]);
    expect(captured).toEqual([7]);
    expect(prevented).toBe(true);
  });
});

describe('RemoteBrowserPane clipboard', () => {
  const mountLive = async (extra: Record<string, unknown> = {}, connect = true) => {
    const transport = new FakeTransport(runningStatus());
    const stream = sockets();
    const renderer = await mountPane(
      <RemoteBrowserPane
        daemon={daemonA}
        scope={scopeA}
        streamTicket="ticket"
        transport={transport}
        schedule={pollSeam().schedule}
        socketFactory={stream.factory}
        {...extra}
      />,
      nodeMock,
    );
    const socket = stream.opened[0];
    if (socket === undefined) throw new Error('the viewer opened no stream');
    if (connect)
      run(() => {
        socket.readyState = 1;
        socket.emit('open', new Event('open'));
      });
    return { renderer, socket };
  };

  it('does not deliver a clipboard read that finishes after the pane changes daemon', async () => {
    let resolveClipboard: ((text: string) => void) | undefined;
    const readClipboardText = () =>
      new Promise<string>(resolve => {
        resolveClipboard = resolve;
      });
    const transport = new FakeTransport(runningStatus());
    const stream = sockets();
    const poll = pollSeam();
    const pane = (daemon: typeof daemonA, scope: typeof scopeA) => (
      <RemoteBrowserPane
        daemon={daemon}
        scope={scope}
        streamTicket="ticket"
        transport={transport}
        schedule={poll.schedule}
        socketFactory={stream.factory}
        readClipboardText={readClipboardText}
      />
    );
    const renderer = await mountPane(pane(daemonA, scopeA), nodeMock);
    const first = stream.opened[0];
    if (first === undefined) throw new Error('daemon A opened no display');
    run(() => {
      first.readyState = 1;
      first.emit('open', new Event('open'));
      control(renderer, 'Paste').props.onClick();
    });

    await runAsync(async () => renderer.update(pane(daemonB, scopeB)));
    const second = stream.opened[1];
    if (second === undefined) throw new Error('daemon B opened no display');
    run(() => {
      second.readyState = 1;
      second.emit('open', new Event('open'));
    });
    await runAsync(async () => {
      resolveClipboard?.('daemon-a clipboard');
      await Promise.resolve();
    });

    expect(first.inputs()).toEqual([]);
    expect(second.inputs()).toEqual([]);
    expect(json(renderer)).not.toContain('daemon-a clipboard');
  });

  it('inserts the system clipboard into the live page', async () => {
    const { renderer, socket } = await mountLive({ readClipboardText: async () => 'pasted text' });
    await runAsync(async () => control(renderer, 'Paste').props.onClick());
    expect(socket.inputs()).toEqual([{ kind: 'insertText', text: 'pasted text' }]);
    expect(json(renderer)).not.toContain('Clipboard access was blocked');
  });

  it('says so when the browser withholds the clipboard', async () => {
    const { renderer, socket } = await mountLive({
      readClipboardText: async () => {
        throw new Error('denied');
      },
    });
    await runAsync(async () => control(renderer, 'Paste').props.onClick());
    expect(socket.inputs()).toEqual([]);
    expect(json(renderer)).toContain('Clipboard access was blocked');
  });

  it('says so when the paste could not reach a disconnected page', async () => {
    const { renderer, socket } = await mountLive({ readClipboardText: async () => 'pasted text' }, false);
    await runAsync(async () => control(renderer, 'Paste').props.onClick());
    expect(socket.inputs()).toEqual([]);
    expect(json(renderer)).toContain('nothing was pasted into the page');
  });

  it('treats an empty clipboard as nothing to do', async () => {
    const { renderer, socket } = await mountLive({ readClipboardText: async () => '' });
    await runAsync(async () => control(renderer, 'Paste').props.onClick());
    expect(socket.inputs()).toEqual([]);
    expect(json(renderer)).not.toContain('nothing was pasted');
  });

  it('reads the real clipboard when no seam is injected', async () => {
    const clipboard = { readText: async () => 'from the system' };
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
    try {
      const { renderer, socket } = await mountLive();
      await runAsync(async () => control(renderer, 'Paste').props.onClick());
      expect(socket.inputs()).toEqual([{ kind: 'insertText', text: 'from the system' }]);
    } finally {
      if (original === undefined) Reflect.deleteProperty(navigator, 'clipboard');
      else Object.defineProperty(navigator, 'clipboard', original);
    }
  });
});

describe('RemoteBrowserPane errors', () => {
  it('surfaces a failed daemon read and lets the reader dismiss it', async () => {
    const transport = new FakeTransport(runningStatus());
    transport.failure = new Error('the daemon is unreachable');
    const renderer = await mountPane(
      <RemoteBrowserPane
        daemon={daemonA}
        scope={scopeA}
        streamTicket={null}
        transport={transport}
        schedule={pollSeam().schedule}
      />,
    );
    expect(json(renderer)).toContain('the daemon is unreachable');
    await runAsync(async () => control(renderer, 'Dismiss').props.onClick());
    expect(json(renderer)).not.toContain('the daemon is unreachable');
  });

  it('rejects an address the daemon would never accept, without dispatching it', async () => {
    const transport = new FakeTransport(runningStatus());
    const renderer = await mountPane(
      <RemoteBrowserPane
        daemon={daemonA}
        scope={scopeA}
        streamTicket={null}
        transport={transport}
        schedule={pollSeam().schedule}
      />,
    );
    const address = renderer.root.findByType('input');
    run(() => address.props.onFocus());
    run(() => address.props.onChange({ target: { value: 'file:///etc/passwd' } }));
    await runAsync(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => undefined }));
    expect(transport.dispatched()).toEqual([]);
    expect(json(renderer)).toContain('is not an http or https address');
  });

  it('shows the page failure the daemon reports', async () => {
    const transport = new FakeTransport(pageErrorStatus());
    const renderer = await mountPane(
      <RemoteBrowserPane
        daemon={daemonA}
        scope={scopeA}
        streamTicket={null}
        transport={transport}
        schedule={pollSeam().schedule}
      />,
    );
    expect(json(renderer)).toContain('The page could not be loaded.');
    expect(json(renderer)).toContain('Page failed');
  });

  it('keeps the last frame visible while the stream stalls and reconnects', async () => {
    const transport = new FakeTransport(runningStatus());
    const stream = sockets();
    const renderer = await mountPane(
      <RemoteBrowserPane
        daemon={daemonA}
        scope={scopeA}
        streamTicket="ticket"
        transport={transport}
        schedule={pollSeam().schedule}
        socketFactory={stream.factory}
        createObjectUrl={() => 'blob:last-frame'}
        revokeObjectUrl={() => undefined}
      />,
    );
    const socket = stream.opened[0];
    if (socket === undefined) throw new Error('the viewer opened no stream');
    run(() => socket.emit('open', new Event('open')));
    run(() => socket.emit('message', new MessageEvent('message', { data: frame('page-a') })));
    expect(json(renderer)).toContain('Live');
    run(() => socket.emit('close', new CloseEvent('close', { code: 1006 })));
    // The last frame is still on screen; only the chrome admits the loss.
    expect(json(renderer)).toContain('blob:last-frame');
    expect(json(renderer)).toContain('Display disconnected — reconnecting…');
    expect(json(renderer)).toContain('Remote display disconnected');
  });
});

describe('RemoteBrowserPane as a hosted engine', () => {
  it('publishes its own engine and drops its address row for a host that owns one', async () => {
    const transport = new FakeTransport(runningStatus());
    const states: RemoteBrowserPaneState[] = [];
    const renderer = await mountPane(
      <RemoteBrowserPane
        daemon={daemonA}
        scope={scopeA}
        streamTicket={null}
        showNavigation={false}
        onStateChange={state => states.push(state)}
        transport={transport}
        schedule={pollSeam().schedule}
      />,
    );
    const markup = json(renderer);

    // The host's toolbar owns the address, so this pane must not draw a second.
    expect(markup).not.toContain('Navigate remote browser');
    // Everything the DAEMON owns stays here: its pages, lifecycle and governor.
    expect(markup).toContain('Chrome pages');
    expect(markup).toContain('Stop');
    expect(markup).toContain('10m idle stop');

    // Published in order: the pre-answer null, then the daemon's own snapshot.
    expect(states[0]?.status).toBeNull();
    expect(states.at(-1)?.status).toEqual(runningStatus());
    expect(states.at(-1)?.error).toBeNull();

    // The host drives THIS engine: one dispatcher, one scope, one Chrome.
    await runAsync(async () => states.at(-1)?.runAction({ action: 'reload' }));
    expect(transport.dispatched()).toEqual([{ action: 'reload' }]);
    expect(transport.actions.every(entry => entry.scope === scopeA)).toBe(true);
    expect(states.some(state => state.busy)).toBe(true);
    expect(states.at(-1)?.busy).toBe(false);
  });

  it('publishes the failure a host has to show instead of a page', async () => {
    const transport = new FakeTransport(runningStatus());
    transport.failure = new Error('the daemon refused the browser request');
    const states: RemoteBrowserPaneState[] = [];
    await mountPane(
      <RemoteBrowserPane
        daemon={daemonA}
        scope={scopeA}
        streamTicket={null}
        showNavigation={false}
        onStateChange={state => states.push(state)}
        transport={transport}
        schedule={pollSeam().schedule}
      />,
    );

    expect(states.at(-1)?.error).toBe('the daemon refused the browser request');
    expect(states.at(-1)?.status).toBeNull();
  });
});
