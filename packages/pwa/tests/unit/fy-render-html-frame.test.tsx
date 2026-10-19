/**
 * The parent half of an executing `html` block.
 *
 * WHAT THIS TIER CAN AND CANNOT SAY. `happy-dom` does not implement browser
 * security policy, so nothing here proves the frame is CONFINED — that belongs
 * to `tests/integration/fy-render-html.security.test.ts`, which drives real
 * Chromium. What this file proves is what the parent DOES: the attributes it
 * renders, the order it does things in, whose messages it believes, how it
 * bounds what the page may say, and that the wall-clock watchdog fires even
 * when the page says everything is fine.
 */
import { afterEach, describe, test } from 'bun:test';
import type { ReactElement } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import should from 'should';
import { type FyRenderHtmlPaint, FyRenderHtmlFrame } from '../../src/components/fy-render-html-frame.tsx';
import type { FyRenderSandboxFailure } from '../../src/components/fy-render-sandbox.tsx';
import { FY_RENDER_SANDBOX_LIMITS, type FyRenderBlock as ParsedBlock, parseFyRender } from '../../src/lib/fy-render.ts';
// Registers happy-dom, which is what gives this file a `window` to dispatch on.
import '../support/dom.ts';
import { render as mountTree, run, runAsync } from '../support/react.ts';

const parsed = (...lines: readonly string[]): ParsedBlock => {
  const result = parseFyRender(lines.join('\n'));
  if (!result.ok) throw new Error(`fixture did not parse: ${result.reason}`);
  return result.block;
};

const PAGE = '<button id="b">count</button><script>b.onclick=()=>b.textContent++</script>';
const htmlBlock = (): ParsedBlock => parsed('type: html', 'alt: A counter widget', '---', PAGE);

/**
 * STABLE BY IDENTITY. The bridge effect depends on `deadlines`, so a fresh
 * object per render would tear the frame down and point it at the shell again
 * on every update — which is exactly the rerun the ref-held callbacks exist to
 * prevent, and would make every multi-render test below measure the wrong thing.
 */
const PATIENT = { hardMs: 60_000, readyMs: 60_000 } as const;

/**
 * `react-test-renderer` hands host refs `null`, so a ref effect never runs and
 * the whole bridge would be silently untested. The mock is the smallest thing
 * that behaves like the iframe: it records `src` assignments, exposes a
 * `contentWindow` identity for the source check, captures the port the parent
 * transfers, and holds the native `load` listeners so a test can fire loads.
 */
const frameMock = () => {
  const transferred: MessagePort[] = [];
  const loadListeners = new Set<() => void>();
  /** The `src` value at the moment each `load` listener was added — the ordering proof. */
  const srcWhenListening: number[] = [];
  const assigned: string[] = [];
  const contentWindow = {
    postMessage: (_message: unknown, _targetOrigin: string, transfer?: readonly MessagePort[]) => {
      if (transfer !== undefined) transferred.push(...transfer);
    },
  };
  return {
    addEventListener(type: string, listener: () => void) {
      if (type !== 'load') return;
      srcWhenListening.push(assigned.length);
      loadListeners.add(listener);
    },
    assigned,
    contentWindow,
    /** Fires one native `load`, as the browser would on each document arriving. */
    load(): void {
      run(() => {
        for (const listener of [...loadListeners]) listener();
      });
    },
    loadListeners: (): number => loadListeners.size,
    removeEventListener(type: string, listener: () => void) {
      if (type === 'load') loadListeners.delete(listener);
    },
    set src(value: string) {
      assigned.push(value);
    },
    /** The port the shell would hold, once the handshake has actually happened. */
    shellPort: (): MessagePort => {
      const port = transferred[0];
      if (port === undefined) throw new Error('the parent transferred no port');
      return port;
    },
    srcWhenListening,
    transferred,
  };
};

type FrameNode = ReturnType<typeof frameMock>;

/** Everything the frame told its parent, in order. */
const recorder = () => {
  const events = { escapes: 0, failures: [] as FyRenderSandboxFailure[], rendered: 0 };
  return {
    events,
    onEscape: (): void => {
      events.escapes += 1;
    },
    onFailed: (failure: FyRenderSandboxFailure): void => {
      events.failures.push(failure);
    },
    onRendered: (): void => {
      events.rendered += 1;
    },
  };
};

/** The column's paint, as `FyRenderBlock` reads it from the computed style. */
const DARK_PAINT: FyRenderHtmlPaint = {
  background: 'rgb(15, 17, 21)',
  color: 'rgb(230, 230, 235)',
  font: 'Inter, sans-serif',
  scheme: 'dark',
};
const LIGHT_PAINT: FyRenderHtmlPaint = {
  background: 'rgb(250, 250, 252)',
  color: 'rgb(20, 20, 24)',
  font: 'Inter, sans-serif',
  scheme: 'light',
};

const mounted: ReactTestRenderer[] = [];
afterEach(() => {
  while (mounted.length > 0) {
    const tree = mounted.pop();
    try {
      run(() => tree?.unmount());
    } catch {
      // Already unmounted by the test itself, which is the ordinary path.
    }
  }
});

const frameElement = (
  calls: ReturnType<typeof recorder>,
  options: {
    readonly block?: ParsedBlock;
    readonly deadlines?: { readonly readyMs: number; readonly hardMs: number };
    readonly fullscreen?: boolean;
    readonly paint?: FyRenderHtmlPaint;
    readonly ready?: boolean;
  } = {},
): ReactElement => (
  <FyRenderHtmlFrame
    block={options.block ?? htmlBlock()}
    deadlines={options.deadlines ?? PATIENT}
    fullscreen={options.fullscreen ?? false}
    onEscape={calls.onEscape}
    onFailed={calls.onFailed}
    onRendered={calls.onRendered}
    paint={options.paint ?? DARK_PAINT}
    ready={options.ready ?? false}
    title="A counter widget"
  />
);

const mountFrame = (element: ReactElement, node: FrameNode): ReactTestRenderer => {
  const tree = mountTree(element, { createNodeMock: () => node });
  mounted.push(tree);
  return tree;
};

/** A global message as the window would deliver it, from whichever source the test names. */
const announce = (data: unknown, source: unknown): void => {
  run(() => {
    window.dispatchEvent(Object.assign(new MessageEvent('message', { data }), { source }));
  });
};

/** Completes the handshake exactly as the shell does, and returns its port, collecting what arrives. */
const handshake = (node: FrameNode): { port: MessagePort; received: unknown[] } => {
  announce({ kind: 'shell-ready' }, node.contentWindow);
  const port = node.shellPort();
  const received: unknown[] = [];
  port.onmessage = (event: MessageEvent) => {
    received.push(event.data);
  };
  return { port, received };
};

const settle = async (ms: number): Promise<void> => {
  await runAsync(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
};

/** The inline height on the frame, as a string, or `none`. Never the instance itself. */
const inlineHeight = (tree: ReactTestRenderer): string => {
  const style = tree.root.findByType('iframe').props.style as { height?: string } | undefined;
  return style?.height ?? 'none';
};

describe('FyRenderHtmlFrame frame element', () => {
  test('should render an opaque-origin, focusable frame that is not yet pointed anywhere', () => {
    // Arrange
    const node = frameMock();

    // Act
    const tree = mountFrame(frameElement(recorder()), node);
    const frame = tree.root.findByType('iframe');

    // Assert — `allow-scripts` and NOTHING else. `allow-same-origin` would hand
    // author code this origin's storage and a reachable parent document, and any
    // other token re-enables forms, popups, modals or top navigation.
    should(frame.props.sandbox).equal('allow-scripts');
    should(String(frame.props.sandbox)).not.match(/allow-same-origin/);
    should(frame.props.referrerPolicy).equal('no-referrer');
    // A tab stop, unlike the library frame: the page IS the interaction.
    should(frame.props.tabIndex).equal(0);
    // Named by the block's own description, since there is no caption any more.
    should(frame.props.title).equal('A counter widget');
    // Invisible until the page has drawn, so no unpainted plane flashes in the prose.
    should(frame.props['data-fy-render-ready']).equal('false');
    // No `src` in markup: the effect assigns it, after the listeners exist.
    should(frame.props.src).be.undefined();
    should(node.assigned).eql(['/fy-render-html.html']);
    // No height until the page says one.
    should(inlineHeight(tree)).equal('none');
  });

  test('should attach its load listener before it assigns the src', () => {
    // Arrange
    const node = frameMock();

    // Act
    mountFrame(frameElement(recorder()), node);

    // Assert — at the moment the `load` listener was added, nothing had been
    // assigned yet; the first document's `load` cannot be missed.
    should(node.srcWhenListening).eql([0]);
    should(node.loadListeners()).equal(1);
  });

  test('should do nothing at all without a host frame', async () => {
    // Arrange — no `createNodeMock`, so the ref is null, as on a server render.
    const calls = recorder();

    // Act
    const tree = mountTree(frameElement(calls, { deadlines: { hardMs: 10, readyMs: 10 } }));
    mounted.push(tree);
    await settle(30);

    // Assert — no watchdog was armed, because there was nothing to bound.
    should(calls.events.failures.length).equal(0);
  });
});

describe('FyRenderHtmlFrame handshake trust', () => {
  test('should ignore a shell-ready from a foreign or absent source', () => {
    // Arrange
    const node = frameMock();
    mountFrame(frameElement(recorder()), node);

    // Act — another window, and a message with no source at all.
    announce({ kind: 'shell-ready' }, { postMessage: () => {} });
    announce({ kind: 'shell-ready' }, null);

    // Assert — trust is `event.source`, so neither buys a channel.
    should(node.transferred.length).equal(0);
  });

  test('should ignore anything from its own frame that is not shell-ready', () => {
    // Arrange
    const node = frameMock();
    mountFrame(frameElement(recorder()), node);

    // Act
    announce({ height: 10, kind: 'rendered', width: 10 }, node.contentWindow);
    announce('not even an object', node.contentWindow);

    // Assert
    should(node.transferred.length).equal(0);
  });

  test('should open exactly one channel, and ignore a second shell-ready', () => {
    // Arrange
    const node = frameMock();
    mountFrame(frameElement(recorder()), node);
    handshake(node);

    // Act — author code shares the shell's realm and could repeat the greeting.
    announce({ kind: 'shell-ready' }, node.contentWindow);

    // Assert
    should(node.transferred.length).equal(1);
  });

  test('should send the page as data over the port, with the paint in force', async () => {
    // Arrange
    const node = frameMock();
    mountFrame(frameElement(recorder(), { paint: LIGHT_PAINT }), node);

    // Act
    const { received } = handshake(node);
    await settle(20);

    // Assert — the authored bytes travel as DATA, never as a URL or markup, and
    // the column's paint travels with them as the page's default.
    should(received).eql([{ kind: 'render-html', paint: LIGHT_PAINT, source: PAGE, theme: 'light' }]);
  });

  test('should repaint a running page over the port rather than remount it', async () => {
    // Arrange
    const node = frameMock();
    const calls = recorder();
    const tree = mountFrame(frameElement(calls, { paint: DARK_PAINT }), node);
    const { received } = handshake(node);
    await settle(20);

    // Act — the reader switches theme while the page runs.
    run(() => tree.update(frameElement(calls, { paint: LIGHT_PAINT, ready: true })));
    await settle(20);

    // Assert — one paint message on the same port, and no second shell load.
    should(received.at(-1)).eql({ kind: 'paint', paint: LIGHT_PAINT });
    should(node.assigned).eql(['/fy-render-html.html']);
    should(tree.root.findByType('iframe').props['data-fy-render-ready']).equal('true');
  });
});

describe('FyRenderHtmlFrame port messages', () => {
  test('should clamp a reported height and apply it inline', async () => {
    // Arrange
    const node = frameMock();
    const tree = mountFrame(frameElement(recorder()), node);
    const { port } = handshake(node);

    // Act — a modest height, then one far past the inline cap.
    run(() => port.postMessage({ height: 200, kind: 'height' }));
    await settle(20);
    const modest = inlineHeight(tree);
    run(() => port.postMessage({ height: 5000, kind: 'height' }));
    await settle(20);

    // Assert
    should(modest).equal('200px');
    should(inlineHeight(tree)).equal(`${FY_RENDER_SANDBOX_LIMITS.htmlInlineMaxHeightPx}px`);
  });

  test('should leave the height to the stylesheet while fullscreen', async () => {
    // Arrange
    const calls = recorder();
    const node = frameMock();
    const tree = mountFrame(frameElement(calls), node);
    const { port } = handshake(node);
    run(() => port.postMessage({ height: 300, kind: 'height' }));
    await settle(20);
    should(inlineHeight(tree)).equal('300px');

    // Act — same block, same deadlines, so the bridge survives the update.
    run(() => tree.update(frameElement(calls, { fullscreen: true })));

    // Assert
    should(inlineHeight(tree)).equal('none');
    should(node.assigned.length).equal(1);
  });

  test('should pass on rendered and escape, and classify an error with its detail', async () => {
    // Arrange
    const calls = recorder();
    const node = frameMock();
    mountFrame(frameElement(calls), node);
    const { port } = handshake(node);

    // Act
    run(() => port.postMessage({ height: 100, kind: 'rendered', width: 100 }));
    run(() => port.postMessage({ kind: 'escape' }));
    run(() => port.postMessage({ class: 'render', kind: 'error', message: 'ReferenceError: x is not defined' }));
    await settle(30);

    // Assert
    should(calls.events.rendered).equal(1);
    should(calls.events.escapes).equal(1);
    should(calls.events.failures).eql([{ detail: 'ReferenceError: x is not defined', kind: 'render' }]);
  });

  test('should drop a message it cannot parse', async () => {
    // Arrange
    const calls = recorder();
    const node = frameMock();
    const tree = mountFrame(frameElement(calls), node);
    const { port } = handshake(node);

    // Act — an unknown kind, and a height carrying an extra key.
    run(() => port.postMessage({ kind: 'navigate', url: 'https://example.com' }));
    run(() => port.postMessage({ extra: true, height: 100, kind: 'height' }));
    await settle(20);

    // Assert
    should(calls.events).eql({ escapes: 0, failures: [], rendered: 0 });
    should(inlineHeight(tree)).equal('none');
  });

  test('should ignore everything the page says once it has failed', async () => {
    // Arrange
    const calls = recorder();
    const node = frameMock();
    const tree = mountFrame(frameElement(calls), node);
    const { port } = handshake(node);

    // Act
    run(() => port.postMessage({ class: 'library', kind: 'error', message: 'first' }));
    run(() => port.postMessage({ height: 100, kind: 'rendered', width: 100 }));
    run(() => port.postMessage({ kind: 'escape' }));
    run(() => port.postMessage({ height: 100, kind: 'height' }));
    run(() => port.postMessage({ class: 'render', kind: 'error', message: 'second' }));
    await settle(30);

    // Assert
    should(calls.events.failures).eql([{ detail: 'first', kind: 'library' }]);
    should(calls.events.rendered).equal(0);
    should(calls.events.escapes).equal(0);
    should(inlineHeight(tree)).equal('none');
  });
});

describe('FyRenderHtmlFrame watchdogs', () => {
  test('should report startup when the shell never announces itself', async () => {
    // Arrange
    const calls = recorder();
    const node = frameMock();

    // Act
    mountFrame(frameElement(calls, { deadlines: { hardMs: 60_000, readyMs: 20 } }), node);
    await settle(60);

    // Assert
    should(calls.events.failures).eql([{ detail: null, kind: 'startup' }]);
  });

  test('should stand the startup deadline down once the handshake completes', async () => {
    // Arrange
    const calls = recorder();
    const node = frameMock();
    mountFrame(frameElement(calls, { deadlines: { hardMs: 60_000, readyMs: 30 } }), node);

    // Act
    handshake(node);
    await settle(70);

    // Assert
    should(calls.events.failures.length).equal(0);
  });

  test('should end the page at its lifetime even after it rendered', async () => {
    // Arrange — the page says everything is fine; the wall clock does not care.
    const calls = recorder();
    const node = frameMock();
    mountFrame(frameElement(calls, { deadlines: { hardMs: 50, readyMs: 60_000 } }), node);
    const { port } = handshake(node);
    run(() => port.postMessage({ height: 100, kind: 'rendered', width: 100 }));

    // Act
    await settle(100);

    // Assert
    should(calls.events.rendered).equal(1);
    should(calls.events.failures).eql([{ detail: null, kind: 'lifetime' }]);
  });

  test('should report only the first failure when several deadlines pass', async () => {
    // Arrange
    const calls = recorder();
    const node = frameMock();

    // Act — startup at 10ms, lifetime at 30ms.
    mountFrame(frameElement(calls, { deadlines: { hardMs: 30, readyMs: 10 } }), node);
    await settle(70);

    // Assert
    should(calls.events.failures).eql([{ detail: null, kind: 'startup' }]);
  });
});

describe('FyRenderHtmlFrame navigation', () => {
  test('should accept the shell arriving and stop the frame on a second load', () => {
    // Arrange
    const calls = recorder();
    const node = frameMock();
    mountFrame(frameElement(calls), node);

    // Act / Assert — the first `load` after `src` is the shell itself.
    node.load();
    should(calls.events.failures.length).equal(0);

    // Act — anything after that is the frame having been sent elsewhere.
    node.load();
    node.load();

    // Assert — reported once, however many loads follow.
    should(calls.events.failures).eql([{ detail: null, kind: 'navigation' }]);
  });
});

describe('FyRenderHtmlFrame teardown', () => {
  test('should clear its timers, listeners and port when unmounted', async () => {
    // Arrange
    const calls = recorder();
    const node = frameMock();
    const tree = mountFrame(frameElement(calls, { deadlines: { hardMs: 40, readyMs: 60_000 } }), node);
    const { port } = handshake(node);

    // Act
    run(() => tree.unmount());
    node.load();
    node.load();
    announce({ kind: 'shell-ready' }, node.contentWindow);
    port.postMessage({ height: 100, kind: 'rendered', width: 100 });
    await settle(80);

    // Assert — nothing reaches the reader from a frame that is gone.
    should(node.loadListeners()).equal(0);
    should(node.transferred.length).equal(1);
    should(calls.events).eql({ escapes: 0, failures: [], rendered: 0 });
  });

  test('should clear the startup watchdog of a frame that never handshook', async () => {
    // Arrange
    const calls = recorder();
    const node = frameMock();
    const tree = mountFrame(frameElement(calls, { deadlines: { hardMs: 60_000, readyMs: 20 } }), node);

    // Act
    run(() => tree.unmount());
    await settle(50);
    announce({ kind: 'shell-ready' }, node.contentWindow);

    // Assert — and its global listener is gone too, so no channel is opened late.
    should(calls.events.failures.length).equal(0);
    should(node.transferred.length).equal(0);
  });
});
