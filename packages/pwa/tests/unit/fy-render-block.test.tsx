import { afterEach, beforeEach, describe, test } from 'bun:test';
import type { ElementType, ReactElement } from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import should from 'should';
import { FyRenderBlock } from '../../src/components/fy-render-block.tsx';
import { FyRenderChart } from '../../src/components/fy-render-chart.tsx';
import { FyRenderFragment } from '../../src/components/fy-render-fragment.tsx';
import { FyRenderHtmlFrame, type FyRenderHtmlPaint } from '../../src/components/fy-render-html-frame.tsx';
import { FyRenderMap } from '../../src/components/fy-render-map.tsx';
import { FyRenderMedia } from '../../src/components/fy-render-media.tsx';
import { FyRenderSandbox, type FyRenderSandboxFailure } from '../../src/components/fy-render-sandbox.tsx';
import {
  FY_RENDER_LIMITS,
  type FyRenderWorkspaceReader,
  type FyRenderBlock as ParsedBlock,
  parseFyRender,
} from '../../src/lib/fy-render.ts';
import { interact, mount, must, pressKey } from '../support/dom.ts';
import { render as mountTree, run, runAsync } from '../support/react.ts';

/**
 * Rendered, not grepped. Every assertion below inspects the tree the component
 * actually produced, because the load-bearing properties — that no primitive
 * capable of executing an author's bytes is anywhere in it, and that an
 * illustration now renders by itself, inline, once it is near — are statements
 * about that tree.
 *
 * What a unit test CANNOT prove: that a browser enforces anything, or what the
 * result looks like. `react-test-renderer` renders to a plain object tree and
 * `happy-dom` implements neither image decoding nor browser security policy. The
 * look is the screenshots' job and the confinement is the integration tier's.
 *
 * COUNTS, NEVER INSTANCES. A `ReactTestInstance` holds a live fiber, so should.js
 * building a failure diff out of one walks that whole graph and a failing
 * assertion hangs instead of failing. Every assertion here reduces the tree to a
 * number or a string first.
 */

const parsed = (...lines: readonly string[]): ParsedBlock => {
  const result = parseFyRender(lines.join('\n'));
  if (!result.ok) throw new Error(`fixture did not parse: ${result.reason}`);
  return result.block;
};

const SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const CIRCLE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="5" cx="5" cy="5"/></svg>';

/**
 * An ADMISSION-SHAPED 1×1 PNG: signature, one 13-byte IHDR, one IDAT run, and a
 * zero-length terminal IEND at the exact end. That is the set of records the
 * grammar checks before anything mounts, and it is deliberately not a claim that
 * the file is complete or valid — its CRCs are zeros and its IDAT holds two
 * meaningless bytes. A browser would refuse to decode it, which is exactly the
 * separation the parser documents: admission is not validity.
 */
const PIXEL_PNG = (() => {
  const be32 = (value: number): number[] => [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ];
  const chars = (text: string): number[] => [...text].map(character => character.charCodeAt(0));
  return Buffer.from(
    Uint8Array.from([
      0x89,
      ...chars('PNG\r\n\x1a\n'),
      ...be32(13),
      ...chars('IHDR'),
      ...be32(1),
      ...be32(1),
      // bit depth, colour type, compression, filter, interlace — 13 IHDR bytes
      // with the width and height above…
      8,
      6,
      0,
      0,
      0,
      // …then the CRC the chunk walk steps over. Omitting it lands the walk in
      // the middle of the next chunk.
      0,
      0,
      0,
      0,
      ...be32(2),
      ...chars('IDAT'),
      0x78,
      0x01,
      0,
      0,
      0,
      0,
      ...be32(0),
      ...chars('IEND'),
      0,
      0,
      0,
      0,
    ]),
  ).toString('base64');
})();

const svgBlock = (payload = SQUARE): ParsedBlock => parsed('type: svg', 'alt: A ten by ten square', '---', payload);
const imageBlock = (): ParsedBlock => parsed('type: image', 'alt: A pixel', 'mime: image/png', '---', PIXEL_PNG);
const htmlBlock = (body = '<button>count</button>'): ParsedBlock =>
  parsed('type: html', 'alt: A counter widget', '---', body);
const mermaidBlock = (): ParsedBlock => parsed('type: mermaid', 'alt: A flow', '---', 'graph TD; A-->B;');
const lottieBlock = (): ParsedBlock =>
  parsed('type: lottie', 'alt: A spinner', '---', '{"v":"5.7.0","w":100,"h":100,"layers":[]}');
const workspaceImageBlock = (): ParsedBlock => parsed('type: image', 'alt: A chart', 'src: @docs/chart.png', '---');
const workspacePdfBlock = (): ParsedBlock => parsed('type: pdf', 'alt: A paper', 'src: @docs/paper.pdf', '---');
const linkedVideoBlock = (): ParsedBlock =>
  parsed('type: video', 'alt: A clip', 'src: https://media.example.com/clip.mp4', '---');
const linkedAudioBlock = (): ParsedBlock =>
  parsed('type: audio', 'alt: A chime', 'src: https://media.example.com/chime.mp3', '---');

const MERMAID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOf(child as ReactTestInstance))).join('');

const count = (tree: ReactTestRenderer, type: ElementType): number => tree.root.findAllByType(type).length;

const marked = (tree: ReactTestRenderer, props: Record<string, unknown>): number =>
  tree.root.findAllByProps(props).length;

/** The first host element carrying a data attribute, reduced to that attribute's value. */
const attribute = (tree: ReactTestRenderer, name: string): string | undefined =>
  tree.root.findAll(node => typeof node.type === 'string' && typeof node.props[name] === 'string')[0]?.props[name];

/** A corner tool by its accessible name, or a failure saying which was missing. */
const tool = (tree: ReactTestRenderer, name: string): ReactTestInstance => {
  const found = tree.root.findAllByType('button').find(button => button.props['aria-label'] === name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
};

const tools = (tree: ReactTestRenderer): string[] =>
  tree.root
    .findAllByType('button')
    .filter(button => button.props.className === 'fy-render-tool')
    .map(button => String(button.props['aria-label']));

const quietAction = (tree: ReactTestRenderer): ReactTestInstance => {
  const found = tree.root.findAllByType('button').find(button => button.props.className === 'fy-render-quiet-action');
  if (found === undefined) throw new Error('no quiet action');
  return found;
};

const sandboxProps = (tree: ReactTestRenderer) =>
  tree.root.findByType(FyRenderSandbox).props as {
    readonly playing: boolean;
    readonly theme: 'dark' | 'light';
    readonly palette?: { readonly key: string };
    readonly onCompiled: (svg: string, theme: 'dark' | 'light', palette: string) => void;
    readonly onFailed: (failure: FyRenderSandboxFailure) => void;
    readonly onRendered: () => void;
  };

/** The shell's reply: a diagram, the mode it was drawn in and the palette key the frame was SENT, echoed. */
const compile = (tree: ReactTestRenderer, mode: 'dark' | 'light', svg = MERMAID_SVG): void =>
  sandboxProps(tree).onCompiled(svg, mode, sandboxProps(tree).palette?.key ?? '');

const htmlProps = (tree: ReactTestRenderer) =>
  tree.root.findByType(FyRenderHtmlFrame).props as {
    readonly fullscreen: boolean;
    readonly paint: FyRenderHtmlPaint;
    readonly ready: boolean;
    readonly title: string;
    readonly onEscape: () => void;
    readonly onFailed: (failure: FyRenderSandboxFailure) => void;
    readonly onHeight?: (height: number) => void;
    readonly onRendered: () => void;
  };

const fragmentProps = (tree: ReactTestRenderer) =>
  tree.root.findByType(FyRenderFragment).props as {
    readonly source: string;
    readonly alt: string;
    readonly readWorkspaceMedia?: FyRenderWorkspaceReader;
  };

const wait = async (ms = 10): Promise<void> => {
  await runAsync(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
};

/**
 * A CONTROLLABLE VIEWPORT. `happy-dom`'s observer never reports anything, so a
 * block mounted against a real element would never come near. This one records
 * every observer and lets a test say when the block enters and leaves.
 */
class FakeObserver {
  static readonly live: FakeObserver[] = [];
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeObserver.live.push(this);
  }
  observe(): void {}
  disconnect(): void {
    const at = FakeObserver.live.indexOf(this);
    if (at !== -1) FakeObserver.live.splice(at, 1);
  }
}

const viewport = (isIntersecting: boolean): void => {
  run(() => {
    for (const observer of [...FakeObserver.live])
      observer.callback([{ isIntersecting } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
  });
};

/** A host node for a test renderer, so the viewport hook observes something. */
const hostNode = () => ({ contains: (): boolean => false, focus: (): void => {} });

const OWNED_THEME = 'studio-dark';
let ambientTheme: string | null = null;
const realFetch = globalThis.fetch;
const realObserver = globalThis.IntersectionObserver;
const realMatchMedia = window.matchMedia;
const mounted: ReactTestRenderer[] = [];

beforeEach(() => {
  ambientTheme = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', OWNED_THEME);
  // NO TEST MAY TOUCH THE NETWORK: a library sandbox fetches its renderer on mount.
  globalThis.fetch = (async () => new Response('globalThis.__fyRenderStub = true;')) as unknown as typeof fetch;
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  while (mounted.length > 0) {
    const tree = mounted.pop();
    try {
      run(() => tree?.unmount());
    } catch {
      // Already unmounted by the test itself.
    }
  }
  globalThis.fetch = realFetch;
  globalThis.IntersectionObserver = realObserver;
  window.matchMedia = realMatchMedia;
  FakeObserver.live.length = 0;
  if (ambientTheme === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', ambientTheme);
});

/**
 * Mounted with no host node, which is what a plain test renderer gives a ref:
 * the block then treats itself as on screen, the same answer a DOM without
 * `IntersectionObserver` gets.
 */
const render = (element: ReactElement): ReactTestRenderer => {
  const tree = mountTree(element);
  mounted.push(tree);
  return tree;
};

/** Mounted against a host node, so the fake viewport decides when the block is near. */
const renderObserved = (element: ReactElement): ReactTestRenderer => {
  const tree = mountTree(element, { createNodeMock: () => hostNode() });
  mounted.push(tree);
  return tree;
};

describe('FyRenderBlock execution surface', () => {
  test('should mount no executing sink for a static type, only an img', () => {
    for (const block of [svgBlock(), imageBlock()]) {
      // Act
      const tree = render(<FyRenderBlock block={block} />);

      // Assert — the absence IS the feature: each of these is a sink the measured
      // `<img>` result does NOT cover.
      for (const forbidden of ['iframe', 'script', 'object', 'embed', 'canvas'] as const)
        should(count(tree, forbidden)).equal(0);
      should(tree.root.findAll(node => node.props?.dangerouslySetInnerHTML !== undefined).length).equal(0);
      should(count(tree, 'img')).equal(1);
    }
  });

  test('should render a script-free HTML payload as a static fragment, never a frame', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={htmlBlock('<table><tr><td>a</td></tr></table>')} />);

    // Assert — no frame at all, and no sink in the tree React renders: the fragment is sanitized
    // into a closed shadow root by `FyRenderFragment` (proven in its own file).
    should(count(tree, FyRenderFragment)).equal(1);
    for (const forbidden of ['iframe', 'script', 'object', 'embed', 'canvas'] as const)
      should(count(tree, forbidden)).equal(0);
    should(tree.root.findAll(node => node.props?.dangerouslySetInnerHTML !== undefined).length).equal(0);
  });

  test('should run a scripted HTML payload only inside its sandboxed frame, never in this document', () => {
    // Arrange — a payload that would be unmistakable if it were ever live here.
    const tree = render(<FyRenderBlock block={htmlBlock('<script>globalThis.pwned = true</script>')} />);

    // Act — open the source.
    run(() => tool(tree, 'HTML source').props.onClick());

    // Assert — the ONLY frame is the opaque-origin one, and no other sink exists.
    should(count(tree, 'iframe')).equal(1);
    should(tree.root.findByType('iframe').props.sandbox).equal('allow-scripts');
    for (const forbidden of ['script', 'object', 'embed', 'canvas'] as const) should(count(tree, forbidden)).equal(0);
    should(tree.root.findAll(node => node.props?.dangerouslySetInnerHTML !== undefined).length).equal(0);
    // The payload reaches this document only as escaped text in the source panel.
    should(textOf(tree.root)).containEql('<script>globalThis.pwned = true</script>');
  });

  test('should compile a diagram in an off-stage library frame and show it through the img sink', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={mermaidBlock()} />);

    // Assert — compiling: a quiet plane on stage, the library frame off it.
    should(count(tree, 'iframe')).equal(1);
    should(marked(tree, { className: 'fy-render-offstage' })).equal(1);
    should(marked(tree, { className: 'fy-render-placeholder' })).equal(1);
    should(count(tree, 'img')).equal(0);

    // Act — the frame hands back a diagram.
    run(() => compile(tree, 'dark'));

    // Assert — the frame is gone and the picture is an <img> of the admitted SVG.
    should(count(tree, 'iframe')).equal(0);
    const image = tree.root.findByType('img');
    should(String(image.props.src).startsWith('data:image/svg+xml,')).be.true();
    should(image.props.alt).equal('A flow');
    should(image.props['data-fy-render-diagram']).equal('true');
  });
});

/**
 * THE OWNER'S DECISION: an illustration renders by itself, inline, as if native.
 * No Render control, no caption, no status line — and the description moves to
 * where a screen reader finds it on the picture itself.
 */
describe('FyRenderBlock inline by default', () => {
  test('should render an SVG at once, described by its own alt, with no chrome around it', () => {
    // Act
    const tree = render(<FyRenderBlock block={svgBlock()} />);

    // Assert
    const image = tree.root.findByType('img');
    should(image.props.src).equal(`data:image/svg+xml,${encodeURIComponent(SQUARE)}`);
    should(image.props.alt).equal('A ten by ten square');
    should(count(tree, 'figcaption')).equal(0);
    should(tree.root.findAll(node => node.props?.role === 'status').length).equal(0);
    should(textOf(tree.root)).not.containEql('Render');
    // The only buttons are the corner tools, hidden until hover, focus or a long press.
    should(tools(tree)).eql(['SVG source', 'Fullscreen']);
    should(attribute(tree, 'data-fy-render-tools')).equal('hover');
  });

  test('should render a raster payload through its declared MIME', () => {
    // Act
    const tree = render(<FyRenderBlock block={imageBlock()} />);

    // Assert
    should(String(tree.root.findByType('img').props.src).startsWith('data:image/png;base64,')).be.true();
  });

  test('should render an html fragment at once, named by its description, with the media reader', () => {
    // Arrange
    const reader: FyRenderWorkspaceReader = () => new Promise(() => {});

    // Act
    const tree = render(<FyRenderBlock block={htmlBlock('<p>hi</p>')} readWorkspaceMedia={reader} />);

    // Assert
    const fragment = fragmentProps(tree);
    should(fragment.source).equal('<p>hi</p>');
    should(fragment.alt).equal('A counter widget');
    should(fragment.readWorkspaceMedia === reader).be.true();
    should(tools(tree)).eql(['HTML source', 'Fullscreen']);
  });

  test('should play an animation at once and pause it from its corner tool', () => {
    // Act
    const tree = render(<FyRenderBlock block={lottieBlock()} />);

    // Assert — playing, with Play/Pause first among the tools.
    should(sandboxProps(tree).playing).be.true();
    should(tools(tree)).eql(['Pause animation', 'Lottie source', 'Fullscreen']);

    // Act — the reader pauses it.
    run(() => tool(tree, 'Pause animation').props.onClick());

    // Assert — paused, and the tools stay visible so Play is never hidden.
    should(sandboxProps(tree).playing).be.false();
    should(attribute(tree, 'data-fy-render-tools')).equal('shown');
    run(() => sandboxProps(tree).onRendered());
    should(sandboxProps(tree).playing).be.false();
  });

  test('should start an animation paused under a reduce preference, without removing Play', () => {
    // Arrange
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;

    // Act
    const tree = render(<FyRenderBlock block={lottieBlock()} />);

    // Assert
    should(sandboxProps(tree).playing).be.false();
    should(tools(tree)[0]).equal('Play animation');
    should(attribute(tree, 'data-fy-render-tools')).equal('shown');

    // Act — the reader chooses to play it anyway.
    run(() => tool(tree, 'Play animation').props.onClick());
    should(sandboxProps(tree).playing).be.true();
  });

  test('should play normally when the motion preference cannot be read', () => {
    for (const broken of [
      () => {
        throw new Error('no media queries here');
      },
      undefined,
    ]) {
      // Arrange
      window.matchMedia = broken as unknown as typeof window.matchMedia;

      // Act
      const tree = render(<FyRenderBlock block={lottieBlock()} />);

      // Assert
      should(sandboxProps(tree).playing).be.true();
    }
  });

  test('should hand a workspace media block to the media stage with the reader', () => {
    // Arrange — a read that never answers, so the stage stays in its loading state.
    const reader: FyRenderWorkspaceReader = () => new Promise(() => {});

    // Act
    const tree = render(<FyRenderBlock block={workspaceImageBlock()} readWorkspaceMedia={reader} />);

    // Assert
    should(count(tree, FyRenderMedia)).equal(1);
    should(tree.root.findByType(FyRenderMedia).props.readWorkspaceMedia === reader).be.true();
    should(tools(tree)).eql(['image source', 'Fullscreen']);
  });

  test('should pass no reader at all when the view has none', () => {
    // Act
    const tree = render(<FyRenderBlock block={linkedVideoBlock()} />);

    // Assert — omitted, not `undefined`: the media stage tells the two apart by presence.
    should(Object.hasOwn(tree.root.findByType(FyRenderMedia).props, 'readWorkspaceMedia')).be.false();
    should(count(tree, 'video')).equal(1);
  });

  test('should give a file row and an audio player no corner tools', async () => {
    // Act — a PDF row, and an audio player whose own controls fill the corner.
    const pdf = render(<FyRenderBlock block={workspacePdfBlock()} readWorkspaceMedia={() => new Promise(() => {})} />);
    const audio = render(<FyRenderBlock block={linkedAudioBlock()} />);
    await wait();

    // Assert
    should(tools(pdf)).eql([]);
    should(attribute(pdf, 'data-fy-render-stage')).equal('row');
    should(tools(audio)).eql([]);
    should(count(audio, 'audio')).equal(1);
  });
});

describe('FyRenderBlock near the viewport', () => {
  test('should render nothing until the block comes near, and keep it once it has', () => {
    // Arrange
    const tree = renderObserved(<FyRenderBlock block={svgBlock()} />);

    // Assert — far away: no decode, and no tools to reveal.
    should(count(tree, 'img')).equal(0);
    should(tools(tree)).eql([]);

    // Act — near, then far again.
    viewport(true);
    should(count(tree, 'img')).equal(1);
    viewport(false);

    // Assert — sticky: scrolling back does not decode again.
    should(count(tree, 'img')).equal(1);
  });

  test('should create no frame and fetch nothing for a diagram that is never near', async () => {
    // Arrange
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;

    // Act
    const tree = renderObserved(<FyRenderBlock block={mermaidBlock()} />);
    await wait(20);

    // Assert
    should(count(tree, 'iframe')).equal(0);
    should(requested).have.length(0);
  });

  test('should play an animation only while it is on screen', () => {
    // Arrange
    const tree = renderObserved(<FyRenderBlock block={lottieBlock()} />);
    viewport(true);
    should(sandboxProps(tree).playing).be.true();

    // Act
    viewport(false);

    // Assert — paused off screen, with the frame kept so it resumes where it was.
    should(sandboxProps(tree).playing).be.false();
    should(count(tree, 'iframe')).equal(1);
  });

  test('should redraw a diagram for a new theme only while it is on screen, keeping the old one up', async () => {
    // Arrange — a diagram drawn dark, on screen.
    const tree = renderObserved(<FyRenderBlock block={mermaidBlock()} />);
    viewport(true);
    run(() => compile(tree, 'dark'));
    should(count(tree, 'iframe')).equal(0);

    // Act — the theme turns light while the block is scrolled away.
    viewport(false);
    run(() => document.documentElement.setAttribute('data-theme', 'studio-light'));
    await wait();

    // Assert — nothing is redrawn off screen.
    should(count(tree, 'iframe')).equal(0);

    // Act — it comes back into view.
    viewport(true);

    // Assert — one off-stage redraw, told the new mode and palette, with the old picture still up.
    should(count(tree, 'iframe')).equal(1);
    should(sandboxProps(tree).theme).equal('light');
    should(sandboxProps(tree).palette?.key ?? '').startWith('light:');
    should(count(tree, 'img')).equal(1);

    // Act — the light diagram arrives.
    run(() => compile(tree, 'light'));

    // Assert
    should(count(tree, 'iframe')).equal(0);
    should(count(tree, 'img')).equal(1);
  });

  test('should not redraw when the theme name changes but its palette does not', async () => {
    // Arrange — the cache key is the mode AND the resolved palette (`paletteKey`). This DOM resolves no
    // token, so two dark theme names paint the same palette here and must not cost a recompile; two that
    // really differ are a different key, which `fy-render-palette.test.ts` proves.

    const tree = render(<FyRenderBlock block={mermaidBlock()} />);
    run(() => compile(tree, 'dark'));

    // Act
    run(() => document.documentElement.setAttribute('data-theme', 'midnight-dark'));
    await wait();

    // Assert
    should(count(tree, 'iframe')).equal(0);
  });
});

describe('FyRenderBlock streaming', () => {
  test('should keep the settled picture until new bytes stop changing', async () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} settleMs={30} />);
    const before = String(tree.root.findByType('img').props.src);

    // Act — new bytes arrive.
    run(() => tree.update(<FyRenderBlock block={svgBlock(CIRCLE)} settleMs={30} />));

    // Assert — not yet.
    should(tree.root.findByType('img').props.src).equal(before);

    // Act — they stop changing.
    await wait(60);

    // Assert
    should(tree.root.findByType('img').props.src).equal(`data:image/svg+xml,${encodeURIComponent(CIRCLE)}`);
  });

  test('should take a change of type at once', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} settleMs={60_000} />);

    // Act
    run(() => tree.update(<FyRenderBlock block={imageBlock()} settleMs={60_000} />));

    // Assert
    should(String(tree.root.findByType('img').props.src).startsWith('data:image/png;base64,')).be.true();
  });

  test('should ignore a decode error retained from bytes that have already been replaced', async () => {
    // Arrange — the error handler bound to the FIRST bytes.
    const tree = render(<FyRenderBlock block={svgBlock()} settleMs={0} />);
    const staleError = tree.root.findByType('img').props.onError as () => void;
    run(() => tree.update(<FyRenderBlock block={svgBlock(CIRCLE)} settleMs={0} />));
    await wait();

    // Act
    run(() => staleError());

    // Assert — the live picture is untouched.
    should(count(tree, 'img')).equal(1);
    should(marked(tree, { 'data-fy-render-error': 'true' })).equal(0);
  });

  test('should clear a decode fallback when new bytes settle, and render them by itself', async () => {
    // Arrange — a half-written SVG the browser refuses.
    const tree = render(
      <FyRenderBlock
        block={svgBlock('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10"/>')}
        settleMs={0}
      />,
    );
    run(() => (tree.root.findByType('img').props.onError as () => void)());
    should(attribute(tree, 'data-fy-render-failure')).equal('decode');

    // Act — the rest arrives.
    run(() => tree.update(<FyRenderBlock block={svgBlock()} settleMs={0} />));
    await wait();

    // Assert — no press needed: the finished picture renders.
    should(count(tree, 'img')).equal(1);
    should(marked(tree, { 'data-fy-render-error': 'true' })).equal(0);
  });

  test('should forget a play decision when the animation is rewritten', async () => {
    // Arrange
    const tree = render(<FyRenderBlock block={lottieBlock()} settleMs={0} />);
    run(() => tool(tree, 'Pause animation').props.onClick());

    // Act
    const rewritten = parsed('type: lottie', 'alt: A spinner', '---', '{"v":"5.7.0","w":120,"h":120,"layers":[]}');
    run(() => tree.update(<FyRenderBlock block={rewritten} settleMs={0} />));
    await wait();

    // Assert
    should(sandboxProps(tree).playing).be.true();
  });
});

/**
 * A FAILURE FALLS BACK TO THE CODE BLOCK, QUIETLY: the fence as it would have been
 * without this feature, with no sentence in the app's voice. The class and the raw
 * wording travel as attributes, for whoever is debugging.
 */
describe('FyRenderBlock fallback', () => {
  test('should show the source as an ordinary code block when the browser refuses the payload', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);

    // Act
    run(() => (tree.root.findByType('img').props.onError as () => void)());

    // Assert
    should(count(tree, 'img')).equal(0);
    should(count(tree, 'pre')).equal(1);
    should(tree.root.findByType('code').props.className).equal('language-fy-render');
    should(textOf(tree.root.findByType('pre'))).containEql('type: svg');
    should(attribute(tree, 'data-fy-render-failure')).equal('decode');
    // Quiet: no tools, no retry for a payload the browser itself refused, no live region.
    should(tools(tree)).eql([]);
    should(count(tree, 'button')).equal(0);
    should(tree.root.findAll(node => node.props?.role === 'status').length).equal(0);
  });

  test('should fall back with the gate’s reason as a title, and offer no retry for bytes that were refused', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={mermaidBlock()} />);

    // Act — the compiled diagram fails re-admission.
    run(() => compile(tree, 'dark', '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>'));

    // Assert
    should(attribute(tree, 'data-fy-render-failure')).equal('render');
    should(String(attribute(tree, 'title'))).not.be.empty();
    should(count(tree, 'iframe')).equal(0);
    should(count(tree, 'button')).equal(0);
  });

  test('should offer a retry when the renderer, not the bytes, failed', () => {
    for (const kind of ['startup', 'library', 'deadline'] as const) {
      // Arrange
      const tree = render(<FyRenderBlock block={mermaidBlock()} />);
      run(() => sandboxProps(tree).onFailed({ detail: null, kind }));
      should(count(tree, 'iframe')).equal(0);

      // Act
      run(() => quietAction(tree).props.onClick());

      // Assert — a fresh frame compiles again.
      should(count(tree, 'iframe')).equal(1);
      should(marked(tree, { 'data-fy-render-error': 'true' })).equal(0);
    }
  });

  test('should fall back when a sandbox fails, and close fullscreen with it', () => {
    // Arrange — the reader is standing in fullscreen on a playing animation.
    const tree = render(<FyRenderBlock block={lottieBlock()} />);
    run(() => tool(tree, 'Fullscreen').props.onClick());
    should(marked(tree, { role: 'dialog' })).equal(1);

    // Act
    run(() => sandboxProps(tree).onFailed({ detail: null, kind: 'render' }));

    // Assert — no overlay left behind with nothing in it.
    should(attribute(tree, 'data-fy-render-failure')).equal('render');
    should(marked(tree, { role: 'dialog' })).equal(0);
    should(count(tree, 'iframe')).equal(0);
  });

  test('should say so in the truncated preview of a very long source', () => {
    // Arrange — an animation past the preview cap.
    const long = `{"v":"5.7.0","w":100,"h":100,"layers":[],"nm":"${'x'.repeat(FY_RENDER_LIMITS.sourcePreviewCharacters)}"}`;
    const tree = render(<FyRenderBlock block={parsed('type: lottie', 'alt: A spinner', '---', long)} />);

    // Act
    run(() => sandboxProps(tree).onFailed({ detail: 'startup', kind: 'startup' }));

    // Assert
    should(textOf(tree.root)).containEql(
      `Source preview truncated at ${FY_RENDER_LIMITS.sourcePreviewCharacters} characters.`,
    );
  });
});

describe('FyRenderBlock designed stops', () => {
  test('should keep a stopped animation’s place and replay it', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={lottieBlock()} />);

    // Act
    run(() => sandboxProps(tree).onFailed({ detail: null, kind: 'lifetime' }));

    // Assert
    should(textOf(tree.root)).containEql('This animation stopped.');
    should(textOf(quietAction(tree))).containEql('Replay');

    // Act
    run(() => quietAction(tree).props.onClick());

    // Assert
    should(count(tree, 'iframe')).equal(1);
  });
});

describe('FyRenderBlock corner tools', () => {
  test('should tie the Source tool to the panel it governs, with a stable name', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    const source = (): ReactTestInstance => tool(tree, 'SVG source');
    should(source().props['aria-expanded']).be.false();
    should(source().props['aria-controls']).be.undefined();

    // Act
    run(() => source().props.onClick());

    // Assert — a named, keyboard-reachable scrollport holding the ordinary code block.
    const panel = tree.root.findByProps({ 'data-fy-render-source': 'true' });
    should(source().props['aria-expanded']).be.true();
    should(source().props['aria-controls']).equal(panel.props.id);
    should(panel.props.tabIndex).equal(0);
    should(panel.props['aria-label']).equal('Authored SVG source');
    should(count(tree, 'pre')).equal(1);
    should(count(tree, 'img')).equal(1);

    // Act
    run(() => source().props.onClick());

    // Assert
    should(marked(tree, { 'data-fy-render-source': 'true' })).equal(0);
  });

  test('should open a labelled modal from the Fullscreen tool and close it from its Exit tool', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={htmlBlock()} />);

    // Act
    run(() => tool(tree, 'Fullscreen').props.onClick());

    // Assert
    const dialog = tree.root.findByProps({ role: 'dialog' });
    should(dialog.props['aria-modal']).be.true();
    should(dialog.props['aria-label']).equal('Illustration: A counter widget');
    should(dialog.props.tabIndex).equal(-1);
    should(attribute(tree, 'data-fy-render-tools')).equal('shown');

    // Act
    run(() => tool(tree, 'Exit fullscreen').props.onClick());

    // Assert
    should(marked(tree, { role: 'dialog' })).equal(0);
  });

  test('should reveal the tools on a long press, and only on touch', async () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    const figure = (): ReactTestInstance => tree.root.findByType('figure');

    // Act — a mouse press held still does nothing; that is what hover is for.
    run(() => figure().props.onPointerDown({ pointerType: 'mouse' }));
    await wait(500);
    should(attribute(tree, 'data-fy-render-tools')).equal('hover');

    // Act — a touch that moves is a scroll, not a press.
    run(() => figure().props.onPointerDown({ pointerType: 'touch' }));
    run(() => figure().props.onPointerMove());
    await wait(500);
    should(attribute(tree, 'data-fy-render-tools')).equal('hover');

    // Act — a touch held still.
    run(() => figure().props.onPointerDown({ pointerType: 'touch' }));
    run(() => figure().props.onPointerDown({ pointerType: 'touch' }));
    await wait(500);
    should(attribute(tree, 'data-fy-render-tools')).equal('shown');

    // Act — and again, to hide them.
    run(() => figure().props.onPointerDown({ pointerType: 'touch' }));
    await wait(500);
    run(() => figure().props.onPointerUp());
    should(attribute(tree, 'data-fy-render-tools')).equal('hover');
  });
});

describe('FyRenderBlock interactive html', () => {
  const COUNTER = '<button id="b">0</button><script>b.onclick = () => b.textContent++</script>';

  /** The iframe's half of a ref, enough for the frame's mount effect to run against. */
  const frameNode = () => ({
    addEventListener: (): void => {},
    contentWindow: { postMessage: (): void => {} },
    removeEventListener: (): void => {},
    set src(_value: string) {},
  });

  const observed = (element: ReactElement, host: unknown = hostNode()): ReactTestRenderer => {
    const tree = mountTree(element, { createNodeMock: node => (node.type === 'iframe' ? frameNode() : host) });
    mounted.push(tree);
    return tree;
  };

  test('should run a scripted page at once, marked, named, painted and revealed once drawn', () => {
    // Act
    const tree = render(<FyRenderBlock block={htmlBlock(COUNTER)} />);

    // Assert — the frame, not a fragment, with a quiet marker saying it runs.
    should(count(tree, FyRenderFragment)).equal(0);
    should(marked(tree, { 'data-fy-render-marker': 'true' })).equal(1);
    should(textOf(tree.root)).containEql('interactive');
    const frame = htmlProps(tree);
    should(frame.title).equal('Interactive illustration: A counter widget');
    should(frame.ready).be.false();
    should(frame.paint.scheme).equal('dark');
    should(tools(tree)).eql(['HTML source', 'Fullscreen']);

    // Act — the page reports its first draw.
    run(() => frame.onRendered());

    // Assert
    should(htmlProps(tree).ready).be.true();
  });

  test('should unload a page scrolled far away, hold its place at its last height, and start it again on return', () => {
    // Arrange
    const tree = observed(<FyRenderBlock block={htmlBlock(COUNTER)} />);
    viewport(true);
    run(() => htmlProps(tree).onHeight?.(320));
    run(() => htmlProps(tree).onRendered());

    // Act — scrolled well away.
    viewport(false);

    // Assert — no frame, a plane of the same height.
    should(count(tree, 'iframe')).equal(0);
    const parked = tree.root.findByProps({ 'data-fy-render-parked': 'true' });
    should(parked.props.style).eql({ height: '320px' });

    // Act — back on screen.
    viewport(true);

    // Assert — a fresh frame, not yet drawn.
    should(count(tree, 'iframe')).equal(1);
    should(htmlProps(tree).ready).be.false();
  });

  test('should hold a parked page’s plane at the default before it ever reported a height', () => {
    // Arrange
    const tree = observed(<FyRenderBlock block={htmlBlock(COUNTER)} />);
    viewport(true);

    // Act
    viewport(false);

    // Assert
    should(tree.root.findByProps({ 'data-fy-render-parked': 'true' }).props.style).be.undefined();
  });

  test('should keep a page running in fullscreen even when its row is off screen, and close it on Escape from inside', () => {
    // Arrange
    const tree = observed(<FyRenderBlock block={htmlBlock(COUNTER)} />);
    viewport(true);
    run(() => tool(tree, 'Fullscreen').props.onClick());

    // Act
    viewport(false);

    // Assert
    should(count(tree, 'iframe')).equal(1);
    should(htmlProps(tree).fullscreen).be.true();

    // Act — Escape inside the frame, forwarded by the shell.
    run(() => htmlProps(tree).onEscape());

    // Assert — out of fullscreen, and off screen, so parked.
    should(marked(tree, { role: 'dialog' })).equal(0);
    should(count(tree, 'iframe')).equal(0);
  });

  for (const [kind, sentence] of [
    ['unresponsive', 'This interactive illustration stopped because it stopped responding.'],
    ['lifetime', 'This interactive illustration stopped after ten minutes.'],
  ] as const)
    test(`should keep a page stopped as ${kind} in its place with one muted line, and run it again`, () => {
      // Arrange
      const tree = render(<FyRenderBlock block={htmlBlock(COUNTER)} />);

      // Act
      run(() => htmlProps(tree).onFailed({ detail: null, kind }));

      // Assert — not a failure: no code block, no tools, no frame.
      should(textOf(tree.root)).containEql(sentence);
      should(count(tree, 'pre')).equal(0);
      should(count(tree, 'iframe')).equal(0);
      should(textOf(quietAction(tree))).containEql('Run again');

      // Act
      run(() => quietAction(tree).props.onClick());

      // Assert
      should(count(tree, 'iframe')).equal(1);
    });

  test('should fall back to the code block when the page navigates away', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={htmlBlock(COUNTER)} />);

    // Act
    run(() => htmlProps(tree).onFailed({ detail: null, kind: 'navigation' }));

    // Assert
    should(attribute(tree, 'data-fy-render-failure')).equal('navigation');
    should(count(tree, 'iframe')).equal(0);
  });

  test('should paint a page with the first painted background and the column colour and font, and follow the theme', async () => {
    // Arrange — the message column sits on a painted surface; the block's own host is unpainted.
    const surface = document.createElement('div');
    surface.style.backgroundColor = 'rgb(1, 2, 3)';
    const host = document.createElement('div');
    host.style.color = 'rgb(4, 5, 6)';
    host.style.fontFamily = 'Inter';
    surface.appendChild(host);
    document.body.appendChild(surface);
    const tree = observed(<FyRenderBlock block={htmlBlock(COUNTER)} />, host);

    // Act
    viewport(true);

    // Assert
    should(htmlProps(tree).paint).eql({
      background: 'rgb(1, 2, 3)',
      color: 'rgb(4, 5, 6)',
      font: 'Inter',
      scheme: 'dark',
    });

    // Act — the reader switches to a light theme while the page runs.
    run(() => document.documentElement.setAttribute('data-theme', 'studio-light'));
    await wait();

    // Assert — repainted, not remounted.
    should(htmlProps(tree).paint.scheme).equal('light');
    should(count(tree, 'iframe')).equal(1);
    surface.remove();
  });

  test('should hand the frame no paint for a node it cannot measure', () => {
    // Arrange
    const tree = observed(<FyRenderBlock block={htmlBlock(COUNTER)} />);

    // Act
    viewport(true);

    // Assert
    should(htmlProps(tree).paint).eql({ background: '', color: '', font: '', scheme: 'dark' });
  });
});

describe('FyRenderBlock fullscreen focus', () => {
  const openFullscreen = async () => {
    const page = await mount(<FyRenderBlock block={svgBlock()} />);
    viewport(true);
    const trigger = must(
      page.container.querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]'),
      'the Fullscreen tool',
    );
    trigger.focus();
    await interact(() => trigger.click());
    return { page, trigger };
  };

  test('should open a labelled modal and keep the reader inside it', async () => {
    // Act
    const { page, trigger } = await openFullscreen();

    // Assert
    const dialog = must(page.container.querySelector('[role="dialog"]'), 'the dialog');
    should(dialog.getAttribute('aria-modal')).equal('true');
    should(dialog.classList.contains('kt-overlay')).be.true();
    should(dialog.contains(trigger)).be.true();
    should(document.activeElement).equal(trigger);
    should(trigger.getAttribute('aria-label')).equal('Exit fullscreen');
    await page.unmount();
  });

  test('should close on Escape and return focus to the trigger', async () => {
    // Arrange
    const { page, trigger } = await openFullscreen();

    // Act
    await interact(() => pressKey(document, 'Escape'));

    // Assert
    should(page.container.querySelector('[role="dialog"]')).be.null();
    should(document.activeElement).equal(trigger);
    should(trigger.getAttribute('aria-label')).equal('Fullscreen');
    await page.unmount();
  });

  test('should trap Tab in both directions rather than let it leave the modal', async () => {
    // Arrange
    const { page } = await openFullscreen();
    const dialog = must(page.container.querySelector('[role="dialog"]'), 'the dialog');

    // Act / Assert
    for (const shiftKey of [false, true]) {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Tab', shiftKey });
      await interact(() => must(document.activeElement, 'the focused control').dispatchEvent(event));
      should(event.defaultPrevented).be.true();
      should(dialog.contains(document.activeElement)).be.true();
    }
    await page.unmount();
  });

  test('should leave Tab alone while the block is inline', async () => {
    // Arrange — an illustration must not capture the keyboard of the page it sits in.
    const page = await mount(<FyRenderBlock block={svgBlock()} />);
    viewport(true);
    const trigger = must(page.container.querySelector('button'), 'a tool');
    trigger.focus();

    // Act
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Tab' });
    await interact(() => trigger.dispatchEvent(event));

    // Assert
    should(event.defaultPrevented).be.false();
    await page.unmount();
  });
});

describe('FyRenderBlock map', () => {
  const mapBlock = (): ParsedBlock => parsed('type: map', 'alt: A city', '---', 'center: [51.5, -0.12]');
  const neverLoads = (): Promise<never> => new Promise(() => {});
  const mapProps = (tree: ReactTestRenderer) =>
    tree.root.findByType(FyRenderMap).props as {
      readonly alt: string;
      readonly payload: string;
      readonly fullscreen: boolean;
      readonly mode: 'dark' | 'light';
      readonly onListing: (listing: boolean) => void;
    };

  test('should draw a map in this document, with no frame and no executing sink', () => {
    // Act
    const tree = render(<FyRenderBlock block={mapBlock()} loadMap={neverLoads} />);

    // Assert — a map is data: the component mounts, and nothing that could run an author's bytes does.
    should(count(tree, FyRenderMap)).equal(1);
    should(mapProps(tree).alt).equal('A city');
    should(mapProps(tree).payload).equal('center: [51.5, -0.12]');
    for (const forbidden of ['iframe', 'script', 'object', 'embed'] as const) should(count(tree, forbidden)).equal(0);
    should(tools(tree)).eql(['Zoom in', 'Zoom out', 'map source', 'Fullscreen']);
  });

  test('should hold a quiet plane and mount no map until the block is near', () => {
    // Arrange
    const tree = renderObserved(<FyRenderBlock block={mapBlock()} loadMap={neverLoads} />);

    // Assert
    should(count(tree, FyRenderMap)).equal(0);
    should(marked(tree, { className: 'fy-render-placeholder' })).equal(1);

    // Act
    viewport(true);

    // Assert
    should(count(tree, FyRenderMap)).equal(1);
  });

  test('should offer nothing to enlarge once the map shows its coordinate list instead', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={mapBlock()} loadMap={neverLoads} />);

    // Act
    run(() => mapProps(tree).onListing(true));

    // Assert — the source stays; a list has no fullscreen. (The zoom buttons are the child's own.)
    should(tools(tree)).eql(['Zoom in', 'Zoom out', 'map source']);

    // Act
    run(() => mapProps(tree).onListing(false));

    // Assert
    should(tools(tree)).eql(['Zoom in', 'Zoom out', 'map source', 'Fullscreen']);
  });

  test('should give the map the whole plane in fullscreen', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={mapBlock()} loadMap={neverLoads} />);
    should(mapProps(tree).fullscreen).be.false();

    // Act
    run(() => tool(tree, 'Fullscreen').props.onClick());

    // Assert
    should(mapProps(tree).fullscreen).be.true();
  });
});

describe('FyRenderBlock chart', () => {
  const chartBlock = (): ParsedBlock =>
    parsed('type: chart', 'alt: Spend per day', '---', 'kind: bar\nseries: [{name: A, data: [1, 2]}]');
  const neverLoads = (): Promise<never> => new Promise(() => {});
  const chartProps = (tree: ReactTestRenderer) =>
    tree.root.findByType(FyRenderChart).props as {
      readonly alt: string;
      readonly payload: string;
      readonly fullscreen: boolean;
      readonly visible: boolean;
      readonly theme: { readonly mode: 'dark' | 'light' };
      readonly onFailed: (failure: FyRenderSandboxFailure) => void;
    };

  test('should draw a chart in this document, in the resolved theme, with no frame and no executing sink', () => {
    // Act
    const tree = render(<FyRenderBlock block={chartBlock()} loadChart={neverLoads} />);

    // Assert — a chart is data: the component mounts in the page's own mode, and nothing that runs an
    // author's bytes does.
    should(count(tree, FyRenderChart)).equal(1);
    should(chartProps(tree).alt).equal('Spend per day');
    should(chartProps(tree).payload).equal('kind: bar\nseries: [{name: A, data: [1, 2]}]');
    should(chartProps(tree).theme.mode).equal('dark');
    for (const forbidden of ['iframe', 'script', 'object', 'embed'] as const) should(count(tree, forbidden)).equal(0);
    should(tools(tree)).eql(['chart source', 'Fullscreen']);
  });

  test('should hold a quiet plane and mount no chart until the block is near', () => {
    // Arrange
    const tree = renderObserved(<FyRenderBlock block={chartBlock()} loadChart={neverLoads} />);

    // Assert
    should(count(tree, FyRenderChart)).equal(0);
    should(marked(tree, { className: 'fy-render-placeholder' })).equal(1);

    // Act
    viewport(true);

    // Assert
    should(count(tree, FyRenderChart)).equal(1);
    should(chartProps(tree).visible).be.true();
  });

  test('should hand a chart its new theme when the reader switches', async () => {
    // Arrange
    const tree = render(<FyRenderBlock block={chartBlock()} loadChart={neverLoads} />);

    // Act
    run(() => document.documentElement.setAttribute('data-theme', 'studio-light'));
    await wait();

    // Assert — the chart decides whether it is on screen to repaint; the block only keeps it current.
    should(chartProps(tree).theme.mode).equal('light');
  });

  test('should fall back to the code block, quietly, for a description the reader refuses', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={chartBlock()} loadChart={neverLoads} />);

    // Act
    run(() => chartProps(tree).onFailed({ detail: 'color: Unrecognized key', kind: 'render' }));

    // Assert — the ordinary fence, the reason as a title, and no retry: the same bytes fail the same way.
    should(count(tree, FyRenderChart)).equal(0);
    should(marked(tree, { 'data-fy-render-failure': 'render' })).equal(1);
    should(count(tree, 'pre')).equal(1);
    should(
      tree.root.findAllByType('button').some(button => button.props.className === 'fy-render-quiet-action'),
    ).be.false();
  });

  test('should offer to try again when the chart library did not load', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={chartBlock()} loadChart={neverLoads} />);

    // Act
    run(() => chartProps(tree).onFailed({ detail: null, kind: 'library' }));
    run(() => quietAction(tree).props.onClick());

    // Assert
    should(count(tree, FyRenderChart)).equal(1);
  });

  test('should give the chart the whole plane in fullscreen', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={chartBlock()} loadChart={neverLoads} />);
    should(chartProps(tree).fullscreen).be.false();

    // Act
    run(() => tool(tree, 'Fullscreen').props.onClick());

    // Assert
    should(chartProps(tree).fullscreen).be.true();
  });
});

describe('FyRenderBlock mermaid on a narrow column', () => {
  const LR = 'flowchart LR\n  A --> B';
  const TB = 'flowchart TB\n  A --> B';
  const lrBlock = (): ParsedBlock => parsed('type: mermaid', 'alt: A flow', '---', LR);
  const WIDE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 760 100"><rect width="760" height="100"/></svg>';

  class FakeResize {
    static readonly live: FakeResize[] = [];
    constructor(readonly callback: () => void) {
      FakeResize.live.push(this);
    }
    observe(): void {}
    disconnect(): void {
      const at = FakeResize.live.indexOf(this);
      if (at !== -1) FakeResize.live.splice(at, 1);
    }
  }
  const realResize = globalThis.ResizeObserver;
  let width = 358;

  beforeEach(() => {
    FakeResize.live.length = 0;
    width = 358;
    globalThis.ResizeObserver = FakeResize as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = realResize;
  });

  /** A real element whose layout width a test controls, since happy-dom lays nothing out. */
  const columnHost = (): HTMLElement => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => width });
    return host;
  };

  const resizeTo = (next: number): void => {
    width = next;
    run(() => {
      for (const observer of [...FakeResize.live]) observer.callback();
    });
  };

  const mountOn = (block: ParsedBlock): ReactTestRenderer => {
    const host = columnHost();
    const tree = mountTree(<FyRenderBlock block={block} />, { createNodeMock: () => host });
    mounted.push(tree);
    viewport(true);
    return tree;
  };

  const sentSource = (tree: ReactTestRenderer): string =>
    (tree.root.findByType(FyRenderSandbox).props as { readonly diagramSource?: string }).diagramSource ?? '';

  test('should compile a left-to-right flowchart top-to-bottom on a phone column', () => {
    // Act
    const tree = mountOn(lrBlock());

    // Assert
    should(sentSource(tree)).equal(TB);
  });

  test('should keep the author source on a desktop column', () => {
    // Arrange
    width = 860;

    // Act
    const tree = mountOn(lrBlock());

    // Assert
    should(sentSource(tree)).equal(LR);
  });

  test('should redraw the other way when the column crosses the breakpoint, and keep the old picture up', () => {
    // Arrange — drawn vertical on a phone.
    const tree = mountOn(lrBlock());
    run(() => compile(tree, 'dark'));
    should(count(tree, 'iframe')).equal(0);

    // Act — rotated to landscape.
    resizeTo(860);

    // Assert — one off-stage redraw of the authored source, with the old picture still showing.
    should(count(tree, 'iframe')).equal(1);
    should(sentSource(tree)).equal(LR);
    should(count(tree, 'img')).equal(1);

    // Act — and back to portrait once it has arrived.
    run(() => compile(tree, 'dark'));
    resizeTo(358);

    // Assert
    should(sentSource(tree)).equal(TB);
  });

  test('should not recompile when the column changes but the direction does not', () => {
    // Arrange
    const tree = mountOn(lrBlock());
    run(() => compile(tree, 'dark'));

    // Act — still a phone column, only wider.
    resizeTo(400);

    // Assert
    should(count(tree, 'iframe')).equal(0);
  });

  test('should not recompile a diagram the rewrite does not change', () => {
    // Arrange — already vertical, drawn on a phone.
    const tree = mountOn(parsed('type: mermaid', 'alt: A flow', '---', TB));
    run(() => compile(tree, 'dark'));

    // Act
    resizeTo(860);

    // Assert
    should(count(tree, 'iframe')).equal(0);
  });

  test('should show a diagram that is wider than the column at a readable size, scrolling in its own box', () => {
    // Arrange
    const tree = mountOn(lrBlock());

    // Act
    run(() => compile(tree, 'dark', WIDE_SVG));

    // Assert — 760px at a floor of 14.45px of 16 (a 17px body is not measured here, so 14px: 11.9 → 12px floor).
    const img = tree.root.findByType('img');
    const shown = Number.parseFloat(String((img.props.style as { width: string }).width));
    should(shown / 760).be.aboveOrEqual(12 / 16);
    should(shown).be.above(358);
    should(marked(tree, { 'data-fy-render-scrolls': 'true' })).equal(1);
  });

  test('should never rewrite another kind of diagram', () => {
    // Arrange
    const state = 'stateDiagram-v2\n  direction LR\n  [*] --> A';

    // Act
    const tree = mountOn(parsed('type: mermaid', 'alt: States', '---', state));

    // Assert
    should(sentSource(tree)).equal(state);
  });
});
