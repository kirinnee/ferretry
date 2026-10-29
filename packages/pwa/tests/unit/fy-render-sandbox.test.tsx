/**
 * The parent half of the sandbox bridge.
 *
 * WHAT THIS TIER CAN AND CANNOT SAY. `happy-dom` does not implement browser
 * security policy, so nothing here proves the frame is CONFINED — that belongs
 * to `tests/integration/fy-render-sandbox.security.test.ts`, which drives real
 * Chromium and corroborates every refusal with a server-side ledger. What this
 * file proves is what the parent DOES: the attributes it renders, the order it
 * does things in, whose messages it believes, and that the hard watchdog fires
 * even when the frame says everything is fine.
 */
import { afterEach, beforeEach, describe, test } from 'bun:test';
import type { ReactElement } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import should from 'should';
import { FyRenderSandbox, type FyRenderSandboxFailure } from '../../src/components/fy-render-sandbox.tsx';
import { type FyRenderBlock as ParsedBlock, parseFyRender } from '../../src/lib/fy-render.ts';
// Registers happy-dom, which is what gives this file a `window` to dispatch on.
import '../support/dom.ts';
import { render as mountTree, run, runAsync } from '../support/react.ts';

const parsed = (...lines: readonly string[]): ParsedBlock => {
  const result = parseFyRender(lines.join('\n'));
  if (!result.ok) throw new Error(`fixture did not parse: ${result.reason}`);
  return result.block;
};

const mermaidBlock = (): ParsedBlock => parsed('type: mermaid', 'alt: A flow', '---', 'graph TD; A-->B;');
const MERMAID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

const lottieBlock = (): ParsedBlock =>
  parsed('type: lottie', 'alt: A spinner', '---', '{"v":"5.7.0","w":100,"h":100,"layers":[]}');

/**
 * `react-test-renderer` hands host refs `null`, so a ref effect never runs and
 * the whole bridge would be silently untested. The mock is the smallest thing
 * that behaves like the iframe: it records what was assigned to `src` — which is
 * how the listener-before-src ordering gets proven — and exposes a
 * `contentWindow` identity for the source check to accept or reject.
 */
const frameMock = () => {
  const transferred: MessagePort[] = [];
  /**
   * Captures the port the parent transfers, which is what lets a test complete
   * the REAL handshake and then speak on the channel the shell would have. A
   * mock that swallowed the transfer could only ever prove things about global
   * messages, and the parent ignores all of those after `shell-ready`.
   */
  const contentWindow = {
    postMessage: (_message: unknown, _targetOrigin: string, transfer?: readonly MessagePort[]) => {
      if (transfer !== undefined) transferred.push(...transfer);
    },
  };
  return {
    assigned: [] as string[],
    contentWindow,
    remove() {},
    /** The port the shell would hold, once the handshake has actually happened. */
    shellPort: (): MessagePort => {
      const port = transferred[0];
      if (port === undefined) throw new Error('the parent transferred no port');
      return port;
    },
    set src(value: string) {
      (this as unknown as { assigned: string[] }).assigned.push(value);
    },
  };
};

/** Completes the handshake exactly as the shell does, and returns its port. */
const handshake = (node: ReturnType<typeof frameMock>): MessagePort => {
  run(() => {
    window.dispatchEvent(
      Object.assign(new MessageEvent('message', { data: { kind: 'shell-ready' } }), {
        source: node.contentWindow,
      }),
    );
  });
  const port = node.shellPort();
  port.start();
  return port;
};

/** A library response that succeeds, so a fetch failure is never the path under test. */
const withStubbedLibrary = async (body: () => Promise<void>): Promise<void> => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('globalThis.__fyRenderStub = true;')) as unknown as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = realFetch;
  }
};

const render = (element: ReactElement, node: ReturnType<typeof frameMock>): ReactTestRenderer =>
  mountTree(element, { createNodeMock: () => node });

const settle = async (ms: number): Promise<void> => {
  await runAsync(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
};

/**
 * Every tree a helper mounted, torn down after each test.
 *
 * `FyRenderSandbox` arms a REAL watchdog on mount — 120 seconds for Lottie —
 * and only the effect teardown clears it. A test that failed before reaching its
 * own `unmount()` therefore left a pending timer holding Bun's event loop open,
 * and the tier HUNG rather than failed, which is much harder to diagnose than a
 * red test. Cleanup belongs here rather than in each test's happy path.
 */
/**
 * NO TEST IN THIS FILE MAY TOUCH THE NETWORK. `FyRenderSandbox` starts its
 * library fetch in the mount effect, so any test that mounts one would otherwise
 * make a real request to happy-dom's origin, fail with `ECONNREFUSED`, and leave
 * a pending request holding the event loop open. The default here answers every
 * request; the two tests that care about fetching install their own stub.
 */
/**
 * THIS FILE OWNS THE DOCUMENT THEME IT TESTS AGAINST, and that is an isolation fix
 * rather than tidiness.
 *
 * `documentTheme()` reads `<html data-theme>` live, which is correct production
 * behaviour. These tests were nonetheless written against the AMBIENT default — no
 * attribute, which resolves to `dark` — and `bun test` runs the whole unit tier in one
 * process with one shared happy-dom document. So the assumption held when this file
 * ran alone and broke when anything published a theme first.
 *
 * Measured, not guessed: `theme-toggle.test.tsx` mounts the real toggle, which
 * publishes `data-theme` through `useTheme` and never puts it back, and
 * `bun test theme-toggle.test.tsx fy-render-sandbox.test.tsx` reproduces exactly the
 * three failures the full gate reported — one `ready` that had become `stale`, and two
 * `expected 'light' to be 'dark'`.
 *
 * Pinning the value per test makes this file independent of whatever ran before it,
 * and restoring the ambient value afterwards means it leaves nothing behind for
 * whatever runs next. Fixing only the leaker would have left the next publisher free
 * to break this file again.
 */
const OWNED_THEME = 'studio-dark';
let ambientTheme: string | null = null;

const realFetch = globalThis.fetch;
beforeEach(() => {
  ambientTheme = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', OWNED_THEME);
  globalThis.fetch = (async () => new Response('globalThis.__fyRenderStub = true;')) as unknown as typeof fetch;
});

const mounted: ReactTestRenderer[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  if (ambientTheme === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', ambientTheme);
  while (mounted.length > 0) {
    const tree = mounted.pop();
    try {
      run(() => tree?.unmount());
    } catch {
      // Already unmounted by the test itself, which is the ordinary path.
    }
  }
});

describe('FyRenderSandbox frame element', () => {
  test('should render an opaque-origin frame that is not yet pointed anywhere', () => {
    // Arrange
    const node = frameMock();

    // Act
    const tree = render(
      <FyRenderSandbox
        block={mermaidBlock()}
        deadlines={{ hardMs: 60_000, readyMs: 60_000 }}
        onCompiled={() => {}}
        onFailed={() => {}}
        onRendered={() => {}}
        playing={false}
        theme="dark"
      />,
      node,
    );
    const frame = tree.root.findByType('iframe');

    // Assert — `allow-scripts` WITHOUT `allow-same-origin` is what keeps the
    // origin opaque. Adding the second would hand the frame this origin's
    // storage and a reachable parent document, and would make every
    // `event.source` check below meaningless.
    should(frame.props.sandbox).equal('allow-scripts');
    should(frame.props.sandbox).not.match(/allow-same-origin/);
    // No `src` PROP at all: an iframe with a src in markup begins loading the
    // moment React inserts it, and the shell announces itself during its first
    // script — which beat a listener attached in the effect that follows. The
    // effect assigns the src instead, after the listener exists.
    should(frame.props.src).be.undefined();
    should(node.assigned).eql(['/fy-render-sandbox.html']);
    // The app's URLs carry session and daemon routes; the shell is a static
    // asset that needs none of that context to load.
    should(frame.props.referrerPolicy).equal('no-referrer');

    run(() => tree.unmount());
  });

  test('should name the frame for the mechanism, never repeat the description', () => {
    // Arrange / Act — both sandbox types, because the name is per type and a
    // single-type assertion would let the other one keep `block.alt`.
    for (const [block, name] of [
      [mermaidBlock(), 'Mermaid diagram renderer'],
      [lottieBlock(), 'Lottie animation player'],
    ] as const) {
      const node = frameMock();
      const tree = render(
        <FyRenderSandbox
          block={block}
          deadlines={{ hardMs: 60_000, readyMs: 60_000 }}
          onCompiled={() => {}}
          onFailed={() => {}}
          onRendered={() => {}}
          playing={false}
          theme="dark"
        />,
        node,
      );
      const frame = tree.root.findByType('iframe');

      // Assert — an iframe cannot be nameless (WCAG 4.1.2), so the repair is a
      // DIFFERENT name rather than no name. `block.alt` is already the
      // `figcaption`, the figure's accessible name and the fullscreen dialog's;
      // a fourth copy here made a screen reader say one sentence four times.
      should(frame.props.title).equal(name);
      should(frame.props.title).not.equal(block.alt);

      run(() => tree.unmount());
    }
  });

  test('should keep the frame out of reach of both the keyboard and the pointer', () => {
    // Arrange
    const node = frameMock();

    // Act
    const tree = render(
      <FyRenderSandbox
        block={lottieBlock()}
        deadlines={{ hardMs: 60_000, readyMs: 60_000 }}
        onCompiled={() => {}}
        onFailed={() => {}}
        onRendered={() => {}}
        playing={false}
        theme="dark"
      />,
      node,
    );
    const frame = tree.root.findByType('iframe');

    // Assert — the frame holds no reader control, and it is a separate document:
    // a keydown inside it never reaches the parent, where the app's Escape
    // listener lives. Focus resting here killed Escape for the one fullscreen
    // state that has a frame in it. `tabIndex={-1}` is half the repair; the
    // `pointer-events: none` rule in `fy-render.css` is the other half, and the
    // browser tier measures that one because a stylesheet is not a tree fact.
    should(frame.props.tabIndex).equal(-1);
    // The class the rule is keyed on, so a rename cannot silently drop it.
    should(frame.props.className).equal('fy-render-frame');

    run(() => tree.unmount());
  });

  test('should hold no credential of any kind in its props', () => {
    // Assert — the type proves no such field is present today; this asserts the
    // same thing against the value a caller actually passes, so a future prop
    // named `connection` has to fail something. Completeness still needs a
    // reviewer, which is why the component says so in its header.
    const props = Object.keys({
      block: mermaidBlock(),
      onCompiled: () => {},
      onFailed: () => {},
      onRendered: () => {},
      playing: false,
      theme: 'dark' as const,
    });
    should(props.sort()).eql(['block', 'onCompiled', 'onFailed', 'onRendered', 'playing', 'theme']);
    for (const forbidden of ['connection', 'token', 'sessionId', 'daemonUrl', 'fetcher'])
      should(props).not.containEql(forbidden);
  });
});

describe('FyRenderSandbox handshake trust', () => {
  test('should ignore a shell-ready that did not come from its own frame', async () => {
    // Arrange
    const node = frameMock();
    const failures: FyRenderSandboxFailure[] = [];
    const tree = render(
      <FyRenderSandbox
        block={mermaidBlock()}
        deadlines={{ hardMs: 60_000, readyMs: 40 }}
        onCompiled={() => {}}
        onFailed={failure => failures.push(failure)}
        onRendered={() => {}}
        playing={false}
        theme="dark"
      />,
      node,
    );

    // Act — a well-formed handshake from SOMEBODY ELSE's window. `event.origin`
    // inside an opaque frame is the string "null" and authenticates nothing, so
    // identity is the only check that carries information.
    run(() => {
      window.dispatchEvent(
        Object.assign(new MessageEvent('message', { data: { kind: 'shell-ready' } }), {
          source: { postMessage: () => {} },
        }),
      );
    });
    await settle(80);

    // Assert — the impostor bought no port, so the readiness deadline still
    // expired. Without the source check it would have been handed a live
    // capability port and the library bytes.
    should(failures).have.length(1);
    // `startup`, not a sentence. The class is what the caller branches on, and a
    // copy edit must not be able to change behaviour.
    should(failures[0]).eql({ detail: null, kind: 'startup' });

    run(() => tree.unmount());
  });
});

describe('FyRenderSandbox hard watchdog', () => {
  test('should fire even after the frame reports that it rendered', async () => {
    await withStubbedLibrary(async () => {
      // Arrange — the defect `sandbox-security-verdict.md` names: a watchdog the
      // payload can stand down by claiming success. Reporting `rendered` is the
      // first thing a runaway payload would do, so the timer must not listen.
      const node = frameMock();
      const failures: FyRenderSandboxFailure[] = [];
      const tree = render(
        <FyRenderSandbox
          block={lottieBlock()}
          deadlines={{ hardMs: 60, readyMs: 60_000 }}
          onCompiled={() => {}}
          onFailed={failure => failures.push(failure)}
          onRendered={() => {}}
          playing={true}
          theme="dark"
        />,
        node,
      );

      // Act — complete the REAL handshake first, then acknowledge through the
      // paired port. An earlier version of this test dispatched `rendered` on
      // `window`, which the parent ignores outright — so the timer firing proved
      // only that an unrelated global message does not cancel it, which is not the
      // defect. The message has to arrive on the channel a frame actually holds.
      const port = handshake(node);
      run(() => port.postMessage({ height: 100, kind: 'rendered', width: 100 }));
      await settle(140);

      // Assert — it fired anyway. If this ever goes quiet, a frame can buy itself
      // unbounded life with one message.
      should(failures).have.length(1);
      // `lifetime` — a DESIGNED bound reached by a healthy animation, which is
      // why it is not `deadline` and why the block presents it without an error
      // tone and without unfurling the authored JSON underneath it.
      should(failures[0]).eql({ detail: null, kind: 'lifetime' });

      run(() => tree.unmount());
    });
  });

  test('should stop bounding a frame it has already torn down', async () => {
    // Arrange
    const node = frameMock();
    const failures: FyRenderSandboxFailure[] = [];
    const tree = render(
      <FyRenderSandbox
        block={lottieBlock()}
        deadlines={{ hardMs: 60, readyMs: 60_000 }}
        onCompiled={() => {}}
        onFailed={failure => failures.push(failure)}
        onRendered={() => {}}
        playing={true}
        theme="dark"
      />,
      node,
    );

    // Act — unmounting IS the teardown, so the bound has nothing left to bound.
    run(() => tree.unmount());
    await settle(140);

    // Assert — no failure reported into a component that is gone, which would
    // otherwise set state on an unmounted tree every time a reader scrolled
    // past a diagram.
    should(failures).have.length(0);
  });

  test('should classify a Mermaid overrun as a deadline, never as a lifetime', async () => {
    await withStubbedLibrary(async () => {
      // Arrange — the SAME timer, the other type. Mermaid is a one-shot compile,
      // so exhausting the bound means fetch, handshake, install and compile did
      // not all finish; that is a failure. Lottie reaching the same kind of bound
      // is not. One timer, two classes, and nothing in between to string-match.
      const node = frameMock();
      const failures: FyRenderSandboxFailure[] = [];
      const tree = render(
        <FyRenderSandbox
          block={mermaidBlock()}
          deadlines={{ hardMs: 60, readyMs: 60_000 }}
          onCompiled={() => {}}
          onFailed={failure => failures.push(failure)}
          onRendered={() => {}}
          playing={false}
          theme="dark"
        />,
        node,
      );

      // Act
      handshake(node);
      await settle(140);

      // Assert
      should(failures).eql([{ detail: null, kind: 'deadline' }]);

      run(() => tree.unmount());
    });
  });
});

describe('FyRenderSandbox failure classification', () => {
  test('should report a library that could not be fetched as its own class', async () => {
    // Arrange — the bundle 404s. No author byte has been involved at this point,
    // so blaming the illustration would be wrong; the deployment is the problem.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;

    try {
      const node = frameMock();
      const failures: FyRenderSandboxFailure[] = [];
      const tree = render(
        <FyRenderSandbox
          block={mermaidBlock()}
          deadlines={{ hardMs: 60_000, readyMs: 60_000 }}
          onCompiled={() => {}}
          onFailed={failure => failures.push(failure)}
          onRendered={() => {}}
          playing={false}
          theme="dark"
        />,
        node,
      );

      // Act — the handshake succeeds, so the frame is fine and only the bytes are
      // missing. That is exactly the pair this class exists to separate.
      handshake(node);
      await settle(40);

      // Assert
      should(failures).eql([{ detail: null, kind: 'library' }]);

      run(() => tree.unmount());
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('should carry the shell’s own wording as a detail rather than as the class', async () => {
    await withStubbedLibrary(async () => {
      // Arrange — a Mermaid parse error as the shell actually forwards one: a
      // multi-line jison dump quoting a slice of the AUTHOR's source. It must
      // reach the caller intact for whoever is debugging, and it must not be the
      // thing the caller decides anything from.
      const node = frameMock();
      const failures: FyRenderSandboxFailure[] = [];
      const dump = 'Parse error on line 2:\ngraph TD; A[Unclosed\n----------^\nExpecting SQE, got EOF';
      const tree = render(
        <FyRenderSandbox
          block={mermaidBlock()}
          deadlines={{ hardMs: 60_000, readyMs: 60_000 }}
          onCompiled={() => {}}
          onFailed={failure => failures.push(failure)}
          onRendered={() => {}}
          playing={false}
          theme="dark"
        />,
        node,
      );

      // Act
      const port = handshake(node);
      run(() => port.postMessage({ class: 'render', kind: 'error', message: dump }));
      await settle(40);

      // Assert — `render` is the only class an author's bytes can cause, and the
      // dump travels as `detail`. `FyRenderBlock` writes the sentence.
      should(failures).eql([{ detail: dump, kind: 'render' }]);

      run(() => tree.unmount());
    });
  });
});

describe('FyRenderSandbox success acknowledgement', () => {
  test('should pass on the frame’s first drawn frame, which used to be discarded', async () => {
    await withStubbedLibrary(async () => {
      // Arrange — `rendered` is the ONLY success Lottie ever reports, and the
      // parent dropped it. Without it there is nothing to end a visible "preparing"
      // state with, and nothing to announce, for up to two minutes.
      const node = frameMock();
      const acknowledged: number[] = [];
      const tree = render(
        <FyRenderSandbox
          block={lottieBlock()}
          deadlines={{ hardMs: 60_000, readyMs: 60_000 }}
          onCompiled={() => {}}
          onFailed={() => {}}
          onRendered={() => acknowledged.push(1)}
          playing={true}
          theme="dark"
        />,
        node,
      );

      // Act
      const port = handshake(node);
      run(() => port.postMessage({ height: 100, kind: 'rendered', width: 100 }));
      await settle(40);

      // Assert — and note what is NOT asserted: no dimension from that message is
      // used for anything. The stylesheet sizes the frame, because a frame that
      // could ask the page for room could ask for all of it.
      should(acknowledged).have.length(1);

      run(() => tree.unmount());
    });
  });

  test('should not report readiness for a frame the watchdog has already stopped', async () => {
    await withStubbedLibrary(async () => {
      // Arrange — the ordering that matters: a runaway payload's first move is to
      // claim success, and if it can do that AFTER its bound has expired it wins
      // back the reader's attention for a frame that has already been failed.
      const node = frameMock();
      const acknowledged: number[] = [];
      const failures: FyRenderSandboxFailure[] = [];
      const tree = render(
        <FyRenderSandbox
          block={lottieBlock()}
          deadlines={{ hardMs: 40, readyMs: 60_000 }}
          onCompiled={() => {}}
          onFailed={failure => failures.push(failure)}
          onRendered={() => acknowledged.push(1)}
          playing={true}
          theme="dark"
        />,
        node,
      );

      // Act
      const port = handshake(node);
      await settle(120);
      run(() => port.postMessage({ height: 100, kind: 'rendered', width: 100 }));
      await settle(40);

      // Assert
      should(failures).eql([{ detail: null, kind: 'lifetime' }]);
      should(acknowledged).be.empty();

      run(() => tree.unmount());
    });
  });
});

describe('FyRenderSandbox compiled diagram', () => {
  test('should hand the compiled SVG and its theme over ONCE, and ignore a second', async () => {
    await withStubbedLibrary(async () => {
      /**
       * Arrange — over the REAL transferred port, never by calling the prop. The arm
       * under test is the one that consumes a `mermaid-svg` reply: it must pass the
       * svg and the theme the SHELL reported straight through, and it must be
       * one-shot. A prop call would exercise the caller's callback and none of the
       * parsing, the `done` latch or the ordering that sit in front of it.
       */
      const node = frameMock();
      const compiled: { svg: string; theme: string; palette: string }[] = [];
      const failures: FyRenderSandboxFailure[] = [];
      const tree = render(
        <FyRenderSandbox
          block={mermaidBlock()}
          deadlines={{ hardMs: 60_000, readyMs: 60_000 }}
          onCompiled={(svg, theme, palette) => compiled.push({ palette, svg, theme })}
          onFailed={failure => failures.push(failure)}
          onRendered={() => {}}
          playing={false}
          theme="dark"
        />,
        node,
      );

      // Act — the shell's own reply, on the channel the parent transferred to it.
      const port = handshake(node);
      run(() => port.postMessage({ kind: 'mermaid-svg', palette: 'light:0a1b2c3d', svg: MERMAID_SVG, theme: 'light' }));
      await settle(40);

      // Assert — exactly once, with the exact bytes and the theme the shell used.
      // `light` while the PROP says `dark` is the point: the parent must not
      // substitute what it thinks the page looks like for what the diagram was drawn
      // for, which is the race the echo closes.
      should(compiled).have.length(1);
      should(compiled[0]?.svg).equal(MERMAID_SVG);
      should(compiled[0]?.theme).equal('light');
      should(compiled[0]?.palette).equal('light:0a1b2c3d');

      // Act — a second reply on the same live port.
      run(() =>
        port.postMessage({ kind: 'mermaid-svg', palette: 'dark:0a1b2c3d', svg: '<svg id="second"/>', theme: 'dark' }),
      );
      await settle(40);

      // Assert — DROPPED. One render per frame: Reload is a fresh frame, never a
      // second command, so a frame that answered twice would be replacing a diagram
      // the reader already has with bytes nobody asked for.
      should(compiled).have.length(1);
      should(compiled[0]?.svg).equal(MERMAID_SVG);
      should(failures).be.empty();

      run(() => tree.unmount());
    });
  });
});

describe('FyRenderSandbox teardown', () => {
  test('should abort an in-flight library fetch and call nothing afterwards', async () => {
    // Arrange — a fetch that never settles on its own, so the ONLY thing that
    // can end it is the abort signal. Without one, replacing the bytes or
    // scrolling the row away left a request still streaming and still
    // allocating toward the library cap for a consumer that no longer exists.
    const realFetch = globalThis.fetch;
    let seenSignal: AbortSignal | undefined;
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as unknown as typeof fetch;

    try {
      const node = frameMock();
      const failures: FyRenderSandboxFailure[] = [];
      const compiled: string[] = [];
      const tree = render(
        <FyRenderSandbox
          block={mermaidBlock()}
          deadlines={{ hardMs: 60_000, readyMs: 60_000 }}
          onCompiled={svg => compiled.push(svg)}
          onFailed={failure => failures.push(failure)}
          onRendered={() => {}}
          playing={false}
          theme="dark"
        />,
        node,
      );

      // Act
      should(seenSignal?.aborted).be.false();
      run(() => tree.unmount());
      await settle(20);

      // Assert — the request is cancelled, and neither callback fires into a
      // component that is gone. `done` alone would have stopped us ACTING on
      // the bytes, which is not the same as not reading them.
      should(seenSignal?.aborted).be.true();
      should(failures).have.length(0);
      should(compiled).have.length(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
