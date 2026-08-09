import { describe, test } from 'bun:test';
import type { ElementType } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import should from 'should';
import { FyRenderBlock } from '../../src/components/fy-render-block.tsx';
import { type FyRenderBlock as ParsedBlock, FY_RENDER_LIMITS, parseFyRender } from '../../src/lib/fy-render.ts';
import { interact, mount, must, pressKey } from '../support/dom.ts';
import { render, run } from '../support/react.ts';

/**
 * Rendered, not grepped. Every assertion below inspects the tree the component
 * actually produced, because the load-bearing property — that no primitive
 * capable of executing an author's bytes is anywhere in it, and that no decoder
 * mounts without a gesture — is a statement about that tree.
 *
 * What a unit test CANNOT prove: that a browser enforces anything.
 * `react-test-renderer` renders to a plain object tree and `happy-dom` does not
 * implement image decoding or browser security policy. The claims here are
 * therefore exactly "what we asked the browser for", never "what the browser
 * did with it" — see `docs/fy-render.md` for which of those are measured.
 */

const parsed = (...lines: readonly string[]): ParsedBlock => {
  const result = parseFyRender(lines.join('\n'));
  if (!result.ok) throw new Error(`fixture did not parse: ${result.reason}`);
  return result.block;
};

const SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

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

const svgBlock = (): ParsedBlock => parsed('type: svg', 'alt: A ten by ten square', '---', SQUARE);
const imageBlock = (): ParsedBlock => parsed('type: image', 'alt: A pixel', 'mime: image/png', '---', PIXEL_PNG);
const htmlBlock = (): ParsedBlock => parsed('type: html', 'alt: A counter widget', '---', '<button>count</button>');

const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOf(child as ReactTestInstance))).join('');

const buttonNamed = (tree: ReactTestInstance, label: string): ReactTestInstance | undefined =>
  tree.findAllByType('button').find(button => textOf(button).includes(label));

const allText = (tree: ReactTestInstance): string => textOf(tree);

/**
 * Counts, not the instances themselves.
 *
 * A `ReactTestInstance` holds a live fiber with parent back-references, and
 * should.js building a failure diff out of one walks that graph — a failing
 * `should(instances).be.empty()` does not report a failure, it stops responding.
 * Asserting the length keeps every failure in this file readable.
 */
const count = (tree: ReactTestInstance, type: ElementType): number => tree.findAllByType(type).length;

/** Host `<button>` elements carrying the consent mark — one per real control. */
const consentControls = (tree: ReactTestInstance): number =>
  tree.findAllByType('button').filter(button => button.props['data-fy-render-consent-action'] === 'true').length;

/**
 * The reader's gesture. No BROWSER IMAGE DECODER mounts before it — header,
 * base64 and container parsing all happen automatically on every render, and
 * saying "nothing decodes" would overclaim in exactly the way the docs repair
 * is removing.
 */
const approve = (tree: { root: ReactTestInstance }): void => {
  run(() => tree.root.findByProps({ 'data-fy-render-consent-action': 'true' }).props.onClick());
};

describe('FyRenderBlock execution surface', () => {
  test('should contain no element capable of executing an author payload, for any type', () => {
    for (const block of [svgBlock(), imageBlock(), htmlBlock()]) {
      // Act
      const tree = render(<FyRenderBlock block={block} />);

      // Assert — the absence IS the feature, and each of these is a sink the
      // measured `<img>` result does NOT cover: an active SVG document in an
      // `<object>`, `<embed>` or `<iframe>` fetches and executes, and the probe
      // showed exactly that for the same bytes.
      for (const forbidden of ['iframe', 'script', 'object', 'embed', 'canvas'] as const) {
        should(count(tree.root, forbidden)).equal(0);
      }
      should(tree.root.findAll(node => node.props?.dangerouslySetInnerHTML !== undefined).length).equal(0);
      run(() => tree.unmount());
    }
  });

  test('should print an HTML payload as escaped text rather than mounting it', () => {
    // Arrange — a payload that would be unmistakable if it were ever live.
    const block = parsed('type: html', 'alt: A hostile widget', '---', '<script>globalThis.pwned = true</script>');

    // Act
    const tree = render(<FyRenderBlock block={block} />);

    // Assert
    should(count(tree.root, 'script')).equal(0);
    should(allText(tree.root)).containEql('<script>globalThis.pwned = true</script>');
    run(() => tree.unmount());
  });
});

/**
 * THE TRUST GATE.
 *
 * A payload's SIZE is bounded; the work of drawing it is not. A transcript is
 * written by an agent rather than by the reader, so the decode is offered rather
 * than performed, and the offer belongs to the exact bytes it was made about.
 */
describe('FyRenderBlock consent', () => {
  test('should mount no decoder at all before the reader asks for one', () => {
    for (const block of [svgBlock(), imageBlock()]) {
      // Act
      const tree = render(<FyRenderBlock block={block} />);

      // Assert
      should(count(tree.root, 'img')).equal(0);
      should(allText(tree.root)).containEql('Rendering starts only when you choose');
      run(() => tree.unmount());
    }
  });

  test('should keep the visible label short and price the accessible one', () => {
    // Act
    const tree = render(<FyRenderBlock block={svgBlock()} />);

    // Assert — the reader is sizing a decision, so the price is announced; but a
    // priced VISIBLE label could not share a row at 390px and pushed every
    // unrendered block to three stacked rows. WCAG 2.5.3 holds because the
    // visible string is contained in the accessible name.
    const action = tree.root.findByProps({ 'data-fy-render-consent-action': 'true' });
    should(textOf(action).trim()).equal('Render illustration');
    const label = String(action.props['aria-label']);
    should(label).containEql('Render illustration');
    should(label).containEql('SVG');
    should(label).match(/\d+ (bytes|KB|MB)/u);
    run(() => tree.unmount());
  });

  test('should offer a neutral note rather than a warning, and reserve no plane for it', () => {
    // Act
    const tree = render(<FyRenderBlock block={svgBlock()} />);

    // Assert — an offer is not a warning. `warn` belongs to the declared
    // limitation and `err` to a failure; wearing `warn` here made all three read
    // as the same kind of event, in the state every illustration starts in.
    const note = tree.root.findByProps({ 'data-fy-render-consent': 'true' });
    should(note.props['data-tone']).be.undefined();
    should(textOf(note).trim()).equal(
      'Rendering starts only when you choose and may use substantial browser resources.',
    );
    // The stage is a note stage, so it does not reserve the illustration plane.
    should(tree.root.findByProps({ 'data-fy-render-stage': 'note' })).be.ok();
    run(() => tree.unmount());
  });

  test('should not offer fullscreen before there is anything to enlarge', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);

    // Assert — an unrendered visual has no picture, no source and no failure, so
    // the overlay would be one line of text over an empty viewport. Same rule as
    // Reload: a control that cannot act is hidden.
    should(buttonNamed(tree.root, 'Fullscreen')).be.undefined();

    // Act
    approve(tree);

    // Assert
    should(buttonNamed(tree.root, 'Fullscreen')).not.be.undefined();
    run(() => tree.unmount());
  });

  test('should offer fullscreen for a decode failure and for a source-only type', () => {
    // Arrange — both have something to show even though neither has a picture.
    const sourceOnly = render(<FyRenderBlock block={htmlBlock()} />);
    should(buttonNamed(sourceOnly.root, 'Fullscreen')).not.be.undefined();
    run(() => sourceOnly.unmount());

    const failing = render(<FyRenderBlock block={svgBlock()} />);
    approve(failing);
    run(() => failing.root.findByType('img').props.onError());

    // Assert
    should(buttonNamed(failing.root, 'Fullscreen')).not.be.undefined();
    run(() => failing.unmount());
  });

  test('should close fullscreen when new bytes withdraw the approval holding it open', () => {
    // Arrange — rendered, and the reader is inside the overlay.
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    approve(tree);
    run(() => buttonNamed(tree.root, 'Fullscreen')?.props.onClick());
    should(tree.root.findAllByProps({ role: 'dialog' })).have.length(1);

    // Act — the assistant emits more of the message.
    const grown = parsed('type: svg', 'alt: A ten by ten square', '---', `${SQUARE}<!-- more -->`);
    run(() => tree.update(<FyRenderBlock block={grown} />));

    // Assert — withdrawing approval hides the Fullscreen control, so leaving the
    // overlay open would strand a touch reader in it: Exit is the only dismiss
    // affordance there, and it would have just disappeared.
    should(tree.root.findAllByProps({ role: 'dialog' }).length).equal(0);
    should(count(tree.root, 'img')).equal(0);
    should(buttonNamed(tree.root, 'Fullscreen')).be.undefined();
    run(() => tree.unmount());
  });

  test('should mount exactly one image once approved', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);

    // Act
    approve(tree);

    // Assert
    should(count(tree.root, 'img')).equal(1);
    should(String(tree.root.findByType('img').props.src)).startWith('data:image/svg+xml,');
    run(() => tree.unmount());
  });

  test('should not let new bytes inherit the decoder approval given to the old ones', () => {
    // Arrange — approved, rendering.
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    approve(tree);
    should(count(tree.root, 'img')).equal(1);

    // Act — the assistant emits more of the message.
    const grown = parsed('type: svg', 'alt: A ten by ten square', '---', `${SQUARE}<!-- more -->`);
    run(() => tree.update(<FyRenderBlock block={grown} />));

    // Assert — consent was to those bytes, not to this block.
    should(count(tree.root, 'img')).equal(0);
    should(allText(tree.root)).containEql('Rendering starts only when you choose');
    run(() => tree.unmount());
  });

  test('should keep approval across a re-render of the same bytes', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    approve(tree);

    // Act — a virtualised list re-renders the same row constantly.
    run(() => tree.update(<FyRenderBlock block={svgBlock()} />));

    // Assert
    should(count(tree.root, 'img')).equal(1);
    run(() => tree.unmount());
  });

  test('should offer no gate for a type that never reaches a decoder', () => {
    // Act
    const tree = render(<FyRenderBlock block={htmlBlock()} />);

    // Assert
    should(tree.root.findAllByProps({ 'data-fy-render-consent-action': 'true' }).length).equal(0);
    should(allText(tree.root)).not.containEql('Rendering starts only when you choose');
    run(() => tree.unmount());
  });

  test('should reuse the same control slot when Render becomes Reload', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    const before = tree.root
      .findAllByType('button')
      .findIndex(button => textOf(button).includes('Render illustration'));

    // Act
    approve(tree);

    // Assert — the position is what keeps focus where the reader left it.
    const after = tree.root.findAllByType('button').findIndex(button => textOf(button).includes('Reload'));
    should(after).equal(before);
    run(() => tree.unmount());
  });
});

describe('FyRenderBlock static types', () => {
  test('should render an SVG payload through an img data URL, never inline', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    approve(tree);

    // Assert — the `<img>` sink is the measured security boundary, so the
    // payload must reach the page ONLY through `src`. `findAllByType('svg')`
    // would be the wrong probe: the control icons are lucide SVGs and are always
    // present. What must be absent is the PAYLOAD's own markup as elements.
    const image = tree.root.findByType('img');
    should(String(image.props.src)).containEql(encodeURIComponent('<rect width="10" height="10"/>'));
    should(count(tree.root, 'rect')).equal(0);
    run(() => tree.unmount());
  });

  test('should render a raster payload through its declared MIME', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={imageBlock()} />);
    approve(tree);

    // Assert
    should(tree.root.findByType('img').props.src).equal(`data:image/png;base64,${PIXEL_PNG}`);
    run(() => tree.unmount());
  });

  test('should describe the illustration once, in the caption', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    approve(tree);

    // Assert — DELIBERATE. The caption already names the figure and the
    // fullscreen dialog; an identical `alt` makes a screen reader say the same
    // sentence three times, four in fullscreen.
    should(tree.root.findByType('img').props.alt).equal('');
    should(textOf(tree.root.findByType('figcaption'))).equal('A ten by ten square');
    run(() => tree.unmount());
  });

  test('should put the caption last in the figure and the controls after it', () => {
    // Assert — DOM order IS visual order now. The actions row is chrome and
    // sits outside the `<figure>` as its sibling, which lets `figcaption` be the
    // figure's last child (its content model allows only first or last) without
    // any CSS `order` making a screen reader hear a different sequence.
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    const figure = tree.root.findByType('figure');
    const figureChildren = figure.children as ReactTestInstance[];
    should(figureChildren[figureChildren.length - 1]?.type).equal('figcaption');
    should(figure.findAllByProps({ className: 'kt-rich-file-actions fy-render-actions' }).length).equal(0);

    const card = tree.root.findByProps({ 'data-fy-render-type': 'svg' });
    const cardChildren = card.children as ReactTestInstance[];
    should(cardChildren[0]?.type).equal('figure');
    should(cardChildren[cardChildren.length - 1]?.props.className).equal('kt-rich-file-actions fy-render-actions');
    run(() => tree.unmount());
  });

  test('should tie the Source control to the panel it governs, with a stable label', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    const control = must(buttonNamed(tree.root, 'Source'), 'the Source control');

    // Assert — one channel carries the state. A label that ALSO changes leaves a
    // reader asking which of the two is authoritative. And `aria-controls` is
    // ABSENT while closed: the panel is unmounted, so an unconditional reference
    // would point at an id that is not in the document.
    should(control.props['aria-expanded']).be.false();
    should(control.props['aria-controls']).be.undefined();
    should(tree.root.findAllByProps({ 'aria-pressed': true }).length).equal(0);

    // Act
    run(() => control.props.onClick());

    // Assert
    const panel = tree.root.findByProps({ 'data-fy-render-source': 'true' });
    should(buttonNamed(tree.root, 'Source')?.props['aria-controls']).equal(panel.props.id);
    should(panel.props.id).equal(buttonNamed(tree.root, 'Source')?.props['aria-controls']);
    should(buttonNamed(tree.root, 'Source')?.props['aria-expanded']).be.true();
    run(() => tree.unmount());
  });

  test('should offer reload only for a type it actually renders', () => {
    // Arrange
    const visual = render(<FyRenderBlock block={svgBlock()} />);
    approve(visual);
    const source = render(<FyRenderBlock block={htmlBlock()} />);

    // Assert — a control that cannot act is hidden, not shown inert.
    should(buttonNamed(visual.root, 'Reload')).not.be.undefined();
    should(buttonNamed(source.root, 'Reload')).be.undefined();
    run(() => visual.unmount());
    run(() => source.unmount());
  });

  test('should remount the image on reload so the payload is decoded again', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    approve(tree);
    const before = tree.root.findByType('img').props;

    // Act
    run(() => buttonNamed(tree.root, 'Reload')?.props.onClick());

    // Assert — same request, fresh element: `key` is what discards the old one.
    should(tree.root.findByType('img').props.src).equal(before.src);
    run(() => tree.unmount());
  });
});

describe('FyRenderBlock source-only types', () => {
  test('should say plainly that this build does not run the payload', () => {
    for (const [block, label] of [
      [htmlBlock(), 'HTML'],
      [parsed('type: mermaid', 'alt: A graph', '---', 'graph TD;'), 'Mermaid'],
      [parsed('type: lottie', 'alt: A spinner', '---', '{"v":"5.7.0"}'), 'Lottie'],
    ] as const) {
      // Act
      const tree = render(<FyRenderBlock block={block} />);

      // Assert — no "preparing", no spinner, no implication that something is
      // about to happen. The limitation is the state.
      should(allText(tree.root)).containEql(`This build does not run ${label} illustrations`);
      should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' })).have.length(1);
      should(tree.root.findByProps({ 'data-fy-render-stage': 'note' })).be.ok();
      run(() => tree.unmount());
    }
  });
});

describe('FyRenderBlock failure fallback', () => {
  test('should show the source with the reason when the browser refuses the payload', () => {
    // Arrange — the grammar admits an SVG by prefix, so a malformed document
    // reaches the `<img>`; the browser's own parser is what rejects it.
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    approve(tree);

    // Act
    run(() => tree.root.findByType('img').props.onError());

    // Assert
    should(allText(tree.root)).containEql('could not be decoded');
    should(tree.root.findAllByProps({ 'data-fy-render-error': 'true' })).have.length(1);
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' })).have.length(1);
    should(count(tree.root, 'img')).equal(0);
    run(() => tree.unmount());
  });

  test('should not announce a decode failure through a live region', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    approve(tree);
    run(() => tree.root.findByType('img').props.onError());

    // Assert — DELIBERATE. A transcript row re-renders while the assistant is
    // still emitting it, so a half-written SVG fails to decode for real; an
    // assertive live region would interrupt a screen-reader user repeatedly to
    // announce an error that is not one yet, and `role="status"` would make the
    // same false announcement politely. The failure is ordinary visible text.
    should(tree.root.findAllByProps({ role: 'alert' }).length).equal(0);
    should(tree.root.findAllByProps({ role: 'status' }).length).equal(0);
    should(tree.root.findAllByProps({ 'aria-live': 'assertive' }).length).equal(0);
    should(tree.root.findAllByProps({ 'aria-live': 'polite' }).length).equal(0);
    run(() => tree.unmount());
  });

  test('should clear the failure when the reader reloads, and close the panel it opened', () => {
    // Arrange — the panel was closed; only the failure opened it.
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    approve(tree);
    run(() => tree.root.findByType('img').props.onError());
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' })).have.length(1);

    // Act
    run(() => buttonNamed(tree.root, 'Reload')?.props.onClick());

    // Assert — a failure-owned panel goes with its failure by EVERY route out of
    // it, not only by new bytes. Clearing `failed` and leaving the panel open
    // left a wall of markup under a retried image.
    should(count(tree.root, 'img')).equal(1);
    should(allText(tree.root)).not.containEql('could not be decoded');
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' }).length).equal(0);
    run(() => tree.unmount());
  });

  test('should keep a reader-opened panel across a reload', () => {
    // Arrange — the reader opened the panel BEFORE the decode failed, so the
    // failure never owned it.
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    approve(tree);
    run(() => buttonNamed(tree.root, 'Source')?.props.onClick());
    run(() => tree.root.findByType('img').props.onError());

    // Act
    run(() => buttonNamed(tree.root, 'Reload')?.props.onClick());

    // Assert
    should(count(tree.root, 'img')).equal(1);
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' })).have.length(1);
    run(() => tree.unmount());
  });

  /**
   * THE STREAMING CASE, which is ordinary rather than exceptional: a transcript
   * row re-renders while the assistant is still emitting it.
   */
  test('should ignore an error retained from bytes that have already been replaced', () => {
    // Arrange — Daria's inverse order. The failure callback is captured from the
    // PARTIAL payload and delivered only AFTER the completed one has arrived,
    // which is what a queued DOM event does.
    // Every OPENING TAG is terminated, so the lexical scanner admits it; the SVG
    // ROOT is never closed, so the browser's own parser refuses it. That split
    // is the streaming shape, and it is also the admission/validity separation.
    const partial = parsed('type: svg', 'alt: A ten by ten square', '---', '<svg width="10" height="10"><rect/>');
    const tree = render(<FyRenderBlock block={partial} />);
    approve(tree);
    const staleOnError = tree.root.findByType('img').props.onError;

    // Act — the rest of the message lands, then the old error is delivered.
    run(() => tree.update(<FyRenderBlock block={svgBlock()} />));
    approve(tree);
    run(() => staleOnError());

    // Assert — the completed image must survive its predecessor's failure.
    should(allText(tree.root)).not.containEql('could not be decoded');
    should(count(tree.root, 'img')).equal(1);
    run(() => tree.unmount());
  });

  test('should clear a stale failure and return to the offer, not render on its own', () => {
    // Arrange
    // Every OPENING TAG is terminated, so the lexical scanner admits it; the SVG
    // ROOT is never closed, so the browser's own parser refuses it. That split
    // is the streaming shape, and it is also the admission/validity separation.
    const partial = parsed('type: svg', 'alt: A ten by ten square', '---', '<svg width="10" height="10"><rect/>');
    const tree = render(<FyRenderBlock block={partial} />);
    approve(tree);
    run(() => tree.root.findByType('img').props.onError());
    should(allText(tree.root)).containEql('could not be decoded');

    // Act
    run(() => tree.update(<FyRenderBlock block={svgBlock()} />));

    // Assert — the failure clears AUTOMATICALLY; the completed illustration does
    // NOT render automatically. Withdrawing approval is what clears it, so the
    // block is back at the offer and there is no Reload to press. Both halves
    // are asserted, because the docs used to claim only the first.
    should(allText(tree.root)).not.containEql('could not be decoded');
    should(count(tree.root, 'img')).equal(0);
    // HOST ELEMENTS ONLY, and exactly one. A bare `findAllByProps` counts the
    // `Button` composite that receives the prop as well as the `<button>` it
    // renders, so its total is 2 for a single control — a number that asserts a
    // renderer detail rather than the interface.
    should(consentControls(tree.root)).equal(1);
    should(buttonNamed(tree.root, 'Render illustration') !== undefined).be.true();
    should(buttonNamed(tree.root, 'Reload') === undefined).be.true();
    // …and no leftover scaffolding: the panel the failure opened goes with it.
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' }).length).equal(0);
    run(() => tree.unmount());
  });

  test('should keep a panel the reader opened even when it recovers from a failure', () => {
    // Arrange — the reader opens the source FIRST, then the decode fails.
    // Every OPENING TAG is terminated, so the lexical scanner admits it; the SVG
    // ROOT is never closed, so the browser's own parser refuses it. That split
    // is the streaming shape, and it is also the admission/validity separation.
    const partial = parsed('type: svg', 'alt: A ten by ten square', '---', '<svg width="10" height="10"><rect/>');
    const tree = render(<FyRenderBlock block={partial} />);
    approve(tree);
    run(() => buttonNamed(tree.root, 'Source')?.props.onClick());
    run(() => tree.root.findByType('img').props.onError());

    // Act
    run(() => tree.update(<FyRenderBlock block={svgBlock()} />));

    // Assert — provenance is what separates the two: a failure must not adopt an
    // open panel and then take it away on recovery.
    should(allText(tree.root)).not.containEql('could not be decoded');
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' })).have.length(1);
    run(() => tree.unmount());
  });

  /**
   * THE PANEL IS RE-DERIVED WHEN THE KIND OF BLOCK CHANGES, and only then.
   *
   * `sourcePanel` is seeded from the mount-time presentation, so a block that
   * becomes source-only while its panel is closed — the default for a visual
   * type — otherwise shows "the authored source is shown below" above nothing at
   * all. Reachable when a transcript entry with a stable id is rewritten rather
   * than appended to.
   */
  test('should open the panel when a visual block becomes source-only', () => {
    // Arrange — a visual block, panel closed by default.
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' }).length).equal(0);

    // Act
    run(() => tree.update(<FyRenderBlock block={parsed('type: mermaid', 'alt: A graph', '---', 'graph TD;')} />));

    // Assert — the note says the source is shown below, so it had better be.
    should(allText(tree.root)).containEql('This build does not run Mermaid illustrations');
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' })).have.length(1);
    run(() => tree.unmount());
  });

  test('should close the panel when a source-only block becomes visual', () => {
    // Arrange — source-only opens its panel by default.
    const tree = render(<FyRenderBlock block={htmlBlock()} />);
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' })).have.length(1);

    // Act
    run(() => tree.update(<FyRenderBlock block={svgBlock()} />));

    // Assert — a visual block starts with its illustration alone.
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' }).length).equal(0);
    run(() => tree.unmount());
  });

  test('should keep a reader-closed panel across new bytes of the same kind', () => {
    // Arrange — the reader deliberately closed a source-only block's panel.
    const tree = render(<FyRenderBlock block={htmlBlock()} />);
    run(() => buttonNamed(tree.root, 'Source')?.props.onClick());
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' }).length).equal(0);

    // Act — the message grows; the KIND of block does not change.
    run(() =>
      tree.update(
        <FyRenderBlock block={parsed('type: html', 'alt: A counter widget', '---', '<button>more</button>')} />,
      ),
    );

    // Assert — re-deriving on every source change would reopen it and undo the
    // reader's decision, which is why the trigger is the presentation.
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' }).length).equal(0);
    run(() => tree.unmount());
  });

  test('should keep a reader-opened panel across new bytes of the same kind', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    run(() => buttonNamed(tree.root, 'Source')?.props.onClick());

    // Act
    const grown = parsed('type: svg', 'alt: A ten by ten square', '---', `${SQUARE}<!-- more -->`);
    run(() => tree.update(<FyRenderBlock block={grown} />));

    // Assert
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' })).have.length(1);
    run(() => tree.unmount());
  });

  test('should truncate a source panel longer than the preview cap and say so', () => {
    // Arrange — a payload past the preview cap but inside the type's own cap.
    const payload = 'x'.repeat(FY_RENDER_LIMITS.sourcePreviewCharacters + 10);
    const block = parsed('type: html', 'alt: A long widget', '---', payload);

    // Act
    const tree = render(<FyRenderBlock block={block} />);

    // Assert
    should(textOf(tree.root.findByType('code'))).have.length(FY_RENDER_LIMITS.sourcePreviewCharacters);
    should(allText(tree.root)).containEql('Source preview truncated');
    run(() => tree.unmount());
  });
});

/**
 * MOUNTED IN A REAL DOCUMENT, not rendered to an object tree.
 *
 * Focus is a document fact. `useDialogFocus` owes four things — Escape closes,
 * focus is inside the dialog, focus returns to the trigger, and Tab is trapped
 * in BOTH directions — and none is observable in a renderer with no `document`,
 * no `activeElement` and no event dispatch.
 */
describe('FyRenderBlock fullscreen focus', () => {
  const openFullscreen = async () => {
    const mounted = await mount(<FyRenderBlock block={svgBlock()} />);
    // Fullscreen is hidden until there is something to enlarge, so the reader
    // renders first — which is also the real order of events.
    await interact(() =>
      must(
        mounted.container.querySelector<HTMLButtonElement>('[data-fy-render-consent-action="true"]'),
        'the Render control',
      ).click(),
    );
    const trigger = must(
      [...mounted.container.querySelectorAll('button')].find(button => button.textContent?.includes('Fullscreen')),
      'the Fullscreen trigger',
    );
    trigger.focus();
    await interact(() => trigger.click());
    return { mounted, trigger };
  };

  test('should open a labelled modal and keep the reader inside it', async () => {
    // Act
    const { mounted, trigger } = await openFullscreen();

    // Assert
    const dialog = must(mounted.container.querySelector('[role="dialog"]'), 'the dialog');
    should(dialog.getAttribute('aria-modal')).equal('true');
    should(dialog.getAttribute('aria-label')).equal('Illustration: A ten by ten square');
    // The app's own visible-viewport contract, so the overlay does not run under
    // a notch or behind a software keyboard.
    should(dialog.classList.contains('kt-overlay')).be.true();
    should(dialog.contains(trigger)).be.true();
    should(document.activeElement).equal(trigger);
    should(trigger.textContent).containEql('Exit fullscreen');
    await mounted.unmount();
  });

  test('should close on Escape and return focus to the trigger', async () => {
    // Arrange
    const { mounted, trigger } = await openFullscreen();

    // Act
    await interact(() => pressKey(document, 'Escape'));

    // Assert
    should(mounted.container.querySelector('[role="dialog"]')).be.null();
    should(document.activeElement).equal(trigger);
    should(trigger.textContent).containEql('Fullscreen');
    await mounted.unmount();
  });

  test('should close from its own control', async () => {
    // Arrange
    const { mounted, trigger } = await openFullscreen();

    // Act
    await interact(() => trigger.click());

    // Assert
    should(mounted.container.querySelector('[role="dialog"]')).be.null();
    should(
      must(mounted.container.querySelector('[data-fy-render-type]'), 'the figure').getAttribute(
        'data-fy-render-fullscreen',
      ),
    ).equal('false');
    await mounted.unmount();
  });

  test('should trap Tab in both directions rather than let it leave the modal', async () => {
    // Arrange
    const { mounted } = await openFullscreen();
    const dialog = must(mounted.container.querySelector('[role="dialog"]'), 'the dialog');

    // Act / Assert — forward and BACKWARD. A trap that only holds one way lets a
    // reader shift-tab straight out of a dialog claiming to be modal.
    for (const shiftKey of [false, true]) {
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, shiftKey });
      await interact(() => must(document.activeElement, 'the focused control').dispatchEvent(event));
      should(event.defaultPrevented).be.true();
      should(dialog.contains(document.activeElement)).be.true();
    }
    await mounted.unmount();
  });

  test('should leave focus on the control that started the render', async () => {
    // Arrange — Render and Reload share a DOM slot precisely so this holds.
    const mounted = await mount(<FyRenderBlock block={svgBlock()} />);
    const gate = must(
      mounted.container.querySelector<HTMLButtonElement>('[data-fy-render-consent-action="true"]'),
      'the Render control',
    );
    gate.focus();

    // Act
    await interact(() => gate.click());

    // Assert — the same element, now labelled Reload, still holds focus.
    should(document.activeElement).equal(gate);
    should(gate.textContent).containEql('Reload');
    should(mounted.container.querySelectorAll('img')).have.length(1);
    await mounted.unmount();
  });

  test('should leave Tab alone while the block is an ordinary figure', async () => {
    // Arrange — an illustration in the transcript must not capture the keyboard
    // of the page it is sitting in.
    const mounted = await mount(<FyRenderBlock block={svgBlock()} />);
    const trigger = must(mounted.container.querySelector('button'), 'a control');
    trigger.focus();

    // Act
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await interact(() => trigger.dispatchEvent(event));

    // Assert
    should(event.defaultPrevented).be.false();
    await mounted.unmount();
  });
});
