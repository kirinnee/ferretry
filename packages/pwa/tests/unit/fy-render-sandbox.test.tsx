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
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import should from 'should';
import { FyRenderBlock } from '../../src/components/fy-render-block.tsx';
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

/**
 * A HOST NODE FOR EVERY OTHER REF IN THE TREE, and the reason the
 * block-through-sandbox suite below exists at all.
 *
 * `createNodeMock` is called for EVERY host element that carries a ref, and the
 * block has two: the fullscreen host `<div>` and, inside the sandbox, the
 * `<iframe>`. Handing the frame mock to both is what made an earlier attempt at
 * this suite unusable — the host's focus recovery then called `focus()` on an
 * object shaped like an iframe. Discriminating on `element.type` is the whole
 * trick, and it records what the recovery effect actually did.
 */
const hostMock = () => {
  const state = { contained: false, focused: 0 };
  return {
    /** Whether `document.activeElement` is inside the overlay, as the effect asks. */
    contains: (): boolean => state.contained,
    focus: (): void => {
      state.focused += 1;
    },
    state,
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

/**
 * COUNTS, NEVER INSTANCES, AND THIS IS NOT A STYLE PREFERENCE.
 *
 * A `ReactTestInstance` holds a live fiber with parent back-references, so
 * should.js building a failure diff out of one walks that whole graph. A failing
 * `should(instances).be.empty()` therefore does not report a failure — it goes
 * CPU-bound with climbing memory until something kills the run, and on a shared
 * machine that is everybody's problem. Measured here: a two-line deliberate
 * regression in `fy-render-block.tsx` turned this file from a 2-second run into
 * one that had to be interrupted.
 *
 * A hanging test is strictly worse than a red one, because it hides every test
 * after it. Every assertion in this file reduces the tree to a number or a string
 * before it reaches `should`. `fy-render-block.test.tsx` states the same rule.
 */
const frames = (tree: ReactTestRenderer): number => tree.root.findAllByType('iframe').length;

const marked = (tree: ReactTestRenderer, props: Record<string, unknown>): number =>
  tree.root.findAllByProps(props).length;

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
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => new Response('globalThis.__fyRenderStub = true;')) as unknown as typeof fetch;
});

const mounted: ReactTestRenderer[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
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
      run(() => port.postMessage({ kind: 'error', message: dump }));
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

describe('FyRenderBlock sandbox consent', () => {
  test('should create no frame and fetch nothing until a reader asks', async () => {
    // Arrange — the property the whole consent gate exists to deliver, and the
    // one most easily lost: an unapproved block must cost a scrolling reader
    // nothing at all. A transcript can hold many diagrams.
    const requested: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;

    try {
      // Act — render the block, NOT the sandbox: no Render gesture is made.
      const tree = mountTree(<FyRenderBlock block={mermaidBlock()} />);
      await settle(30);

      // Assert — no frame was created, so no shell was loaded, and the library
      // fetch that lives in the frame's mount effect never ran.
      should(frames(tree)).equal(0);
      should(requested).have.length(0);
      // And the reader is offered the choice rather than having it made.
      should(marked(tree, { 'data-fy-render-consent': 'true' })).equal(1);

      run(() => tree.unmount());
    } finally {
      globalThis.fetch = realFetch;
    }
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

/**
 * THE BLOCK DRIVEN THROUGH THE SANDBOX, which an earlier attempt reported as
 * unrunnable. It is not: `createNodeMock` is called for EVERY host element
 * carrying a ref, and the block has two — the fullscreen host `<div>` and the
 * `<iframe>` — so handing the frame mock to both put the host's focus recovery on
 * an object shaped like an iframe. Discriminate on `element.type`, stub `fetch`,
 * and unmount in `afterEach` so no 120-second watchdog outlives its test.
 *
 * WHAT THIS TIER STILL CANNOT SAY: it renders to a plain object tree, so a
 * stylesheet is not visible to it and neither is a real focus ring. The
 * `pointer-events` rule, the `dvh` cap, the wrapping action row and real focus
 * movement are measured in `tests/integration/fy-render-component.visual.test.tsx`
 * against real Chromium at both required viewports.
 *
 * FAILURE CLASSES ARE DELIVERED THROUGH THE PRODUCTION SEAM. Two of the five
 * cannot be provoked from here on any sensible clock — a Lottie `lifetime` stop
 * is 120 seconds of real time — so these tests call the `onFailed` prop the block
 * actually passes to `FyRenderSandbox` with the exact value the real watchdog
 * emits. That the watchdog emits it is proven above, on a shortened deadline. The
 * two halves compose; neither is a replica of the other.
 */
const mountBlock = (block: ParsedBlock) => {
  const frame = frameMock();
  const host = hostMock();
  const tree = mountTree(<FyRenderBlock block={block} />, {
    createNodeMock: element => (element.type === 'iframe' ? frame : host),
  });
  mounted.push(tree);
  return { frame, host, tree };
};

const press = (tree: ReactTestRenderer, label: string): void => {
  const button = tree.root.findAllByType('button').find(candidate => textOf(candidate).includes(label));
  if (button === undefined) throw new Error(`no control labelled ${label}`);
  run(() => button.props.onClick());
};

const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOf(child as ReactTestInstance))).join('');

const approve = (tree: ReactTestRenderer): void => {
  run(() => tree.root.findByProps({ 'data-fy-render-consent-action': 'true' }).props.onClick());
};

/**
 * The one sandbox-only live region, and the phase it is currently in.
 *
 * Found by predicate rather than by `findByProps({ className: … })`: that helper
 * compares prop values for equality, so a regex against a class LIST silently
 * matches nothing and every assertion built on it would pass by never running.
 */
const statusRegion = (tree: ReactTestRenderer): ReactTestInstance => {
  const regions = tree.root.findAll(node => typeof node.props['data-fy-render-sandbox-status'] === 'string');
  if (regions.length !== 1) throw new Error(`expected exactly one status region, found ${regions.length}`);
  return regions[0] as ReactTestInstance;
};

const status = (tree: ReactTestRenderer): { phase: string; text: string; tone: string | undefined } => {
  const region = statusRegion(tree);
  return {
    phase: region.props['data-fy-render-sandbox-status'] as string,
    text: textOf(region),
    tone: region.props['data-tone'] as string | undefined,
  };
};

/** The folded diagnostic body, or a failure naming what was missing. */
const foldBody = (tree: ReactTestRenderer): ReactTestInstance => {
  const bodies = tree.root.findAll(
    node => typeof node.props.className === 'string' && node.props.className.includes('kt-fs-why-body'),
  );
  if (bodies.length !== 1) throw new Error(`expected exactly one folded detail, found ${bodies.length}`);
  return bodies[0] as ReactTestInstance;
};

/** Delivers a classified failure exactly as the mounted sandbox would. */
const failFrom = (tree: ReactTestRenderer, failure: FyRenderSandboxFailure): void => {
  run(() =>
    (tree.root.findByType(FyRenderSandbox).props as { onFailed: (f: FyRenderSandboxFailure) => void }).onFailed(
      failure,
    ),
  );
};

const MERMAID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

describe('FyRenderBlock sandbox status', () => {
  test('should say the wait is happening rather than show a bordered empty plane', async () => {
    // Arrange / Act — the reader consents and the stage becomes a frame that is
    // transparent until a multi-megabyte library has been fetched, installed and
    // run. That window is bounded at 15s for Mermaid and 120s for Lottie, and it
    // used to be an empty box with nothing said to anybody.
    const { tree } = mountBlock(mermaidBlock());
    should(status(tree).phase).equal('idle');
    should(status(tree).text).be.empty();
    approve(tree);
    await settle(20);

    // Assert — visible text, and a polite atomic region to carry it.
    should(status(tree)).match({ phase: 'preparing', text: 'Preparing the Mermaid renderer…' });
    const spoken = tree.root.findByProps({ role: 'status' });
    should(spoken.props['aria-live']).equal('polite');
    should(spoken.props['aria-atomic']).equal('true');
    // The frame is mounted BESIDE the status, not replaced by it — otherwise the
    // acknowledgement that ends this state could never arrive.
    should(frames(tree)).equal(1);
  });

  test('should mount the region before consent so its first sentence is a change', async () => {
    // Assert — an inserted live region carrying text is announced inconsistently;
    // one that exists and then changes is the reliable shape. Empty is therefore a
    // real state, and `idle` is what keeps it out of the layout.
    const { tree } = mountBlock(lottieBlock());

    should(marked(tree, { role: 'status' })).equal(1);
    should(status(tree).phase).equal('idle');
    should(status(tree).text).be.empty();
    await settle(10);
  });

  test('should end the wait on the frame’s own acknowledgement, over the real port', async () => {
    await withStubbedLibrary(async () => {
      // Arrange
      const { frame, tree } = mountBlock(lottieBlock());
      approve(tree);
      await settle(20);
      should(status(tree).phase).equal('preparing');

      // Act — the whole chain: handshake, port, `rendered`, `onRendered`, state.
      const port = handshake(frame);
      run(() => port.postMessage({ height: 100, kind: 'rendered', width: 100 }));
      await settle(40);

      // Assert
      should(status(tree)).match({ phase: 'ready', text: 'The Lottie illustration is ready.' });
      // And the animation is still live, because Lottie has to keep running.
      should(frames(tree)).equal(1);
    });
  });

  test('should treat a compiled diagram as the readiness Mermaid reports', async () => {
    // Arrange
    const { tree } = mountBlock(mermaidBlock());
    approve(tree);
    await settle(20);

    // Act — Mermaid's success IS the compiled SVG; there is no `rendered` for it.
    run(() => tree.root.findByType(FyRenderSandbox).props.onCompiled(MERMAID_SVG));
    await settle(20);

    // Assert — the frame is destroyed and what remains is the measured `<img>`.
    should(status(tree)).match({ phase: 'ready', text: 'The Mermaid illustration is ready.' });
    should(frames(tree)).equal(0);
    should(marked(tree, { 'data-fy-render-diagram': 'true' })).equal(1);
  });
});

describe('FyRenderBlock sandbox failure copy', () => {
  test('should write its own sentence and fold the gate’s exact refusal away', async () => {
    // Arrange — the flagship fallback path. An author's `%%{init}%%` directive can
    // ask Mermaid for HTML labels, the re-admission gate refuses the
    // `<foreignObject>` that produces, and the gate's own wording used to BE the
    // sentence the reader was greeted with.
    const { tree } = mountBlock(mermaidBlock());
    approve(tree);
    await settle(20);

    // Act
    run(() =>
      tree.root
        .findByType(FyRenderSandbox)
        .props.onCompiled('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><foreignObject/></svg>'),
    );
    await settle(20);

    // Assert — a plain reader sentence in the region…
    should(status(tree).phase).equal('failed');
    should(status(tree).text).containEql('This Mermaid illustration could not be rendered.');
    should(status(tree).tone).equal('err');
    // …and the machine's precise reason kept, folded, under the app's own idiom.
    const fold = tree.root.findByProps({ className: 'kt-fs-why' });
    should(textOf(fold)).containEql('foreignObject');
    // A `<summary>` is what makes the fold openable, and `files.css` gives it a
    // 44px hit area. Counted, never handed to `should` as an instance.
    should(fold.findAllByType('summary').length).equal(1);
    // The refusal is NOT the sentence: it lives only inside the fold.
    should(textOf(tree.root.findByProps({ role: 'status' }))).not.containEql('foreignObject');
    // The source is scaffolding for bad bytes, so it opens.
    should(marked(tree, { 'data-fy-render-source': 'true' })).equal(1);
  });

  test('should keep an author-influenced multi-line dump out of the app’s voice', async () => {
    // Arrange — what Mermaid actually forwards: a jison dump quoting a slice of
    // the author's own source with an ASCII caret rule under it. Rendered as app
    // copy it arrived as one mangled line wearing the `err` styling. React escapes
    // it, so this is spoofing and legibility rather than injection — and it is
    // still the app appearing to say something an author wrote.
    const dump =
      'Parse error on line 2:\n<img src=x onerror="alert(1)"> & "quoted"\n----------^\nExpecting SQE, got EOF';
    const { tree } = mountBlock(mermaidBlock());
    approve(tree);
    await settle(20);

    // Act
    failFrom(tree, { detail: dump, kind: 'render' });
    await settle(20);

    // Assert — the sentence is ours…
    should(textOf(tree.root.findByProps({ role: 'status' }))).equal(
      'This Mermaid illustration could not be rendered. The authored source is shown below.',
    );
    // …and the dump is intact inside the fold, as TEXT. `findAllByType` proves no
    // element was constructed from it, which is what escaping means here.
    const body = foldBody(tree);
    should(textOf(body)).equal(dump);
    should(body.findAllByType('img').length).equal(0);
    // The class that keeps its line breaks — the caret rule is meaningless once
    // whitespace collapses it onto one line.
    should(body.props.className).containEql('fy-render-why-body');
  });

  test('should name what the Mermaid deadline actually bounded', async () => {
    // Arrange — the timer covers fetch, handshake, install AND compile, and the
    // bundle is ~3.4 MiB: a cold first block on a slow connection can exhaust it
    // while still downloading the renderer. "Too complex to draw" pointed that
    // reader at the one remedy that cannot help.
    const { tree } = mountBlock(mermaidBlock());
    approve(tree);
    await settle(20);

    // Act
    failFrom(tree, { detail: null, kind: 'deadline' });
    await settle(20);

    // Assert
    should(status(tree).text).equal(
      'The diagram did not finish rendering in time and was stopped. Reload to try again.',
    );
    should(status(tree).text).not.containEql('too long to draw');
    should(status(tree).text).not.containEql('complex');
    should(status(tree).tone).equal('err');
  });

  test('should present a designed lifetime stop as a status, not as a breakage', async () => {
    // Arrange — a perfectly healthy animation the reader chose to watch reaches
    // its permitted life. Nothing is broken. It used to become an `err`-toned note
    // with the authored JSON unfurled beneath it — scaffolding for diagnosing bad
    // bytes, and no help at all with a wall-clock cap.
    const { tree } = mountBlock(lottieBlock());
    approve(tree);
    await settle(20);

    // Act — exactly the value the watchdog emits, proven above.
    failFrom(tree, { detail: null, kind: 'lifetime' });
    await settle(20);

    // Assert
    should(status(tree).text).equal('Playback was stopped after two minutes. Reload to play it again.');
    // NEUTRAL. No error tone…
    should(status(tree).tone).be.undefined();
    // …no wall of authored JSON…
    should(marked(tree, { 'data-fy-render-source': 'true' })).equal(0);
    // …and no fold, because there is no library wording to fold.
    should(marked(tree, { className: 'kt-fs-why' })).equal(0);
    // Reload is still offered, because it is the remedy this copy names.
    should(tree.root.findAllByType('button').some(button => textOf(button).includes('Reload'))).be.true();
  });

  test('should still open the source for a failure the bytes could explain', async () => {
    // Assert — the discriminator is the CLASS, so the three classes that can be
    // about the payload or the deployment keep Slice A's scaffolding. Only
    // `lifetime` opts out, and a string compare could not express that.
    for (const kind of ['startup', 'library', 'render'] as const) {
      const { tree } = mountBlock(mermaidBlock());
      approve(tree);
      await settle(10);
      failFrom(tree, { detail: null, kind });
      await settle(10);

      should(status(tree).phase).equal('failed');
      should(status(tree).tone).equal('err');
      should(marked(tree, { 'data-fy-render-source': 'true' })).equal(1);
      should(marked(tree, { className: 'kt-fs-why' })).equal(0);
      run(() => tree.unmount());
    }
  });

  test('should state a sandbox failure once, never in the stage as well', async () => {
    // Assert — the stage renders nothing for a sandbox failure, so the sentence
    // exists in exactly one place. The streamed decode failure keeps its own
    // silent stage note, which is a different state on purpose.
    const { tree } = mountBlock(mermaidBlock());
    approve(tree);
    await settle(10);
    failFrom(tree, { detail: null, kind: 'render' });
    await settle(10);

    const sentences = tree.root
      .findAllByProps({ 'data-fy-render-error': 'true' })
      .filter(node => typeof node.type === 'string');
    should(sentences.length).equal(1);
    should(sentences[0]?.props['data-fy-render-sandbox-status']).equal('failed');
  });
});

describe('FyRenderBlock sandbox theme ownership', () => {
  test('should recompile a diagram whose theme no longer matches the page', async () => {
    // Arrange — Mermaid cannot see the page, so it is TOLD which way it is painted
    // and bakes that into the SVG; the result then lives on as an `<img>` for the
    // rest of the transcript's life. This app ships 22 themes, so a dark diagram
    // stranded on a light surface is unreadable with nothing on screen suggesting
    // Reload was the remedy.
    const before = document.documentElement.getAttribute('data-theme');
    try {
      const { tree } = mountBlock(mermaidBlock());
      approve(tree);
      await settle(20);
      should(tree.root.findByType(FyRenderSandbox).props.theme).equal('dark');
      run(() => tree.root.findByType(FyRenderSandbox).props.onCompiled(MERMAID_SVG));
      await settle(20);
      should(marked(tree, { 'data-fy-render-diagram': 'true' })).equal(1);

      // Act
      run(() => document.documentElement.setAttribute('data-theme', 'mission-light'));
      await settle(60);

      // Assert — the diagram is dropped and a frame takes its place, compiling
      // against the theme now on the document. Consent is untouched: the reader
      // approved these bytes and a repaint does not change that.
      should(marked(tree, { 'data-fy-render-diagram': 'true' })).equal(0);
      should(frames(tree)).equal(1);
      should(tree.root.findByType(FyRenderSandbox).props.theme).equal('light');
      // And the wait is visible again rather than a stale "ready" over a blank plane.
      should(status(tree).phase).equal('preparing');
      should(marked(tree, { 'data-fy-render-consent-action': 'true' })).equal(0);
    } finally {
      if (before === null) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', before);
    }
  });

  test('should leave a diagram alone when the attribute changes but the mode does not', async () => {
    // Arrange — 22 themes resolve to two modes. Recompiling on every switch between
    // two dark families would throw away a good diagram and re-run a 3.4 MiB
    // renderer for a picture that would come back identical.
    const before = document.documentElement.getAttribute('data-theme');
    try {
      run(() => document.documentElement.setAttribute('data-theme', 'mission-dark'));
      const { tree } = mountBlock(mermaidBlock());
      approve(tree);
      await settle(20);
      run(() => tree.root.findByType(FyRenderSandbox).props.onCompiled(MERMAID_SVG));
      await settle(20);

      // Act
      run(() => document.documentElement.setAttribute('data-theme', 'studio-dark'));
      await settle(60);

      // Assert
      should(marked(tree, { 'data-fy-render-diagram': 'true' })).equal(1);
      should(frames(tree)).equal(0);
    } finally {
      if (before === null) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', before);
    }
  });
});

describe('FyRenderBlock fullscreen focus recovery', () => {
  test('should pull focus back into the overlay when a control vanishes under it', async () => {
    // Arrange — Play/Pause is mounted only while the frame is, and the frame goes
    // the instant a sandbox failure is set. A reader watching an animation in
    // fullscreen with focus on Pause therefore has that control removed with no
    // action of their own. React does not relocate focus, so `activeElement`
    // becomes `<body>` — outside an `aria-modal` container — and the Tab trap, an
    // `onKeyDown` on the host, stops seeing the key.
    const { host, tree } = mountBlock(lottieBlock());
    approve(tree);
    await settle(20);
    press(tree, 'Fullscreen');
    await settle(10);
    should(tree.root.findByProps({ role: 'dialog' }).props['aria-modal']).be.true();
    // The host is focusable ONLY in fullscreen, so focus has somewhere to land.
    should(tree.root.findByProps({ role: 'dialog' }).props.tabIndex).equal(-1);
    const recoveredBefore = host.state.focused;
    // Focus is no longer inside the overlay — the state the repair exists for.
    host.state.contained = false;

    // Act
    failFrom(tree, { detail: null, kind: 'render' });
    await settle(20);

    // Assert
    should(host.state.focused).be.above(recoveredBefore);
    // And the overlay is still open, which is what makes the recovery necessary
    // rather than incidental: a dismissed overlay would have restored focus anyway.
    should(marked(tree, { role: 'dialog' })).equal(1);
  });

  test('should not steal focus from a control the reader is already using', async () => {
    // Arrange — the guard. Without it every state change inside an open overlay
    // would yank focus off the button under the reader's finger.
    const { host, tree } = mountBlock(lottieBlock());
    approve(tree);
    await settle(20);
    press(tree, 'Fullscreen');
    await settle(10);
    host.state.contained = true;
    const recoveredBefore = host.state.focused;

    // Act
    failFrom(tree, { detail: null, kind: 'render' });
    await settle(20);

    // Assert
    should(host.state.focused).equal(recoveredBefore);
  });

  test('should leave a transcript row out of the tab order entirely', async () => {
    // Assert — the host is a focus stop only while it is a dialog. An illustration
    // sitting in a transcript is not one, and every row becoming tabbable would
    // add a stop per illustration to the whole conversation.
    const { tree } = mountBlock(lottieBlock());
    await settle(10);
    // `toJSON()` names the host element unambiguously — it IS the root of the
    // rendered tree — where a `.parent` walk could land on a component instance.
    should((tree.toJSON() as { props: Record<string, unknown> }).props.tabIndex).be.undefined();
  });
});
