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
 * capable of executing an author's bytes is anywhere in it — is a statement
 * about that tree and cannot be made by reading the source.
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

const svgBlock = (): ParsedBlock => parsed('type: svg', 'alt: A ten by ten square', '---', SQUARE);
const imageBlock = (): ParsedBlock => parsed('type: image', 'alt: A pixel', 'mime: image/png', '---', 'AAAA');
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
      // No node anywhere hands markup to the DOM.
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

describe('FyRenderBlock static types', () => {
  test('should render an SVG payload through an img data URL, never inline', () => {
    // Act
    const tree = render(<FyRenderBlock block={svgBlock()} />);

    // Assert — the `<img>` sink is the measured security boundary, so the
    // payload must reach the page ONLY through `src`. `findAllByType('svg')`
    // would be the wrong probe: the control icons are lucide SVGs and are always
    // present. What must be absent is the PAYLOAD's own markup as elements.
    const image = tree.root.findByType('img');
    should(String(image.props.src)).startWith('data:image/svg+xml,');
    should(String(image.props.src)).containEql(encodeURIComponent('<rect width="10" height="10"/>'));
    should(count(tree.root, 'rect')).equal(0);
    run(() => tree.unmount());
  });

  test('should render a raster payload through its declared MIME', () => {
    // Act
    const tree = render(<FyRenderBlock block={imageBlock()} />);

    // Assert
    should(tree.root.findByType('img').props.src).equal('data:image/png;base64,AAAA');
    run(() => tree.unmount());
  });

  test('should carry alt as both the accessible name and the visible caption', () => {
    // Act
    const tree = render(<FyRenderBlock block={svgBlock()} />);

    // Assert
    should(tree.root.findByType('img').props.alt).equal('A ten by ten square');
    should(textOf(tree.root.findByType('figcaption'))).equal('A ten by ten square');
    run(() => tree.unmount());
  });

  test('should keep the source panel closed until it is asked for', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);

    // Assert
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' }).length).equal(0);

    // Act
    run(() => buttonNamed(tree.root, 'Source')?.props.onClick());

    // Assert
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' })).have.length(1);
    should(allText(tree.root)).containEql('type: svg');
    should(buttonNamed(tree.root, 'Hide source')).not.be.undefined();
    run(() => tree.unmount());
  });

  test('should offer reload only for a type it actually renders', () => {
    // Arrange
    const visual = render(<FyRenderBlock block={svgBlock()} />);
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
    const before = tree.root.findByType('img').props;

    // Act
    run(() => buttonNamed(tree.root, 'Reload')?.props.onClick());

    // Assert — same request, fresh element: `key` is what discards the old one.
    should(tree.root.findByType('img').props.src).equal(before.src);
    should(tree.toJSON()).not.be.null();
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
      run(() => tree.unmount());
    }
  });
});

describe('FyRenderBlock failure fallback', () => {
  test('should show the source with the reason when the browser refuses the payload', () => {
    // Arrange — the grammar admits an SVG by prefix, so a malformed document
    // reaches the `<img>`; the browser's own parser is what rejects it.
    const tree = render(<FyRenderBlock block={svgBlock()} />);

    // Act
    run(() => tree.root.findByType('img').props.onError());

    // Assert
    should(allText(tree.root)).containEql('could not be decoded');
    should(tree.root.findAllByProps({ 'data-fy-render-error': 'true' })).have.length(1);
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' })).have.length(1);
    should(count(tree.root, 'img')).equal(0);
    run(() => tree.unmount());
  });

  test('should clear the failure when the reader reloads', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    run(() => tree.root.findByType('img').props.onError());

    // Act
    run(() => buttonNamed(tree.root, 'Reload')?.props.onClick());

    // Assert
    should(tree.root.findAllByType('img')).have.length(1);
    should(allText(tree.root)).not.containEql('could not be decoded');
    run(() => tree.unmount());
  });

  /**
   * THE STREAMING CASE, which is the ordinary case rather than an edge one.
   *
   * A transcript row re-renders while the assistant is still emitting it, and
   * the grammar admits an SVG by prefix, so a half-written document genuinely
   * reaches the `<img>` and genuinely fails to decode. What must not happen is
   * that the finished document then renders into a component still showing that
   * failure.
   */
  test('should recover on its own when a completed payload replaces the partial one', () => {
    // Arrange — the half-written document, which parses and cannot decode.
    const partial = parsed('type: svg', 'alt: A ten by ten square', '---', '<svg xmlns="http://www.w3.org/2000/svg');
    const tree = render(<FyRenderBlock block={partial} />);
    run(() => tree.root.findByType('img').props.onError());
    should(allText(tree.root)).containEql('could not be decoded');

    // Act — the rest of the message arrives. Same component, new payload.
    run(() => tree.update(<FyRenderBlock block={svgBlock()} />));

    // Assert — no Reload press required, and no leftover scaffolding: the panel
    // the failure opened goes when the failure does, or a correctly streamed
    // illustration finishes with an unsolicited wall of markup underneath it.
    should(allText(tree.root)).not.containEql('could not be decoded');
    should(count(tree.root, 'img')).equal(1);
    should(String(tree.root.findByType('img').props.src)).containEql(encodeURIComponent('<rect'));
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' }).length).equal(0);
    run(() => tree.unmount());
  });

  test('should keep a panel the reader opened even when it recovers from a failure', () => {
    // Arrange — the reader opens the source FIRST, then the decode fails.
    const partial = parsed('type: svg', 'alt: A ten by ten square', '---', '<svg xmlns="http://www.w3.org/2000/svg');
    const tree = render(<FyRenderBlock block={partial} />);
    run(() => buttonNamed(tree.root, 'Source')?.props.onClick());
    run(() => tree.root.findByType('img').props.onError());

    // Act — the completed payload arrives.
    run(() => tree.update(<FyRenderBlock block={svgBlock()} />));

    // Assert — the failure is gone; the reader's panel is not. Provenance is
    // what separates the two, so a failure must not adopt an open panel.
    should(allText(tree.root)).not.containEql('could not be decoded');
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' })).have.length(1);
    run(() => tree.unmount());
  });

  test('should not announce a decode failure through a live region', () => {
    // Arrange
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    run(() => tree.root.findByType('img').props.onError());

    // Assert — DELIBERATE. A transcript row re-renders while the assistant is
    // still emitting it, so a half-written SVG fails to decode for real; an
    // assertive live region would interrupt a screen-reader user repeatedly to
    // announce an error that is not one yet, and `role="status"` would make the
    // same false announcement politely. The failure is ordinary visible text.
    should(tree.root.findAllByProps({ 'data-fy-render-error': 'true' })).have.length(1);
    should(tree.root.findAllByProps({ role: 'alert' }).length).equal(0);
    should(tree.root.findAllByProps({ role: 'status' }).length).equal(0);
    should(tree.root.findAllByProps({ 'aria-live': 'assertive' }).length).equal(0);
    should(tree.root.findAllByProps({ 'aria-live': 'polite' }).length).equal(0);
    run(() => tree.unmount());
  });

  test('should keep a reader-opened source panel across an unrelated re-render', () => {
    // Arrange — the reader opened the panel deliberately.
    const tree = render(<FyRenderBlock block={svgBlock()} />);
    run(() => buttonNamed(tree.root, 'Source')?.props.onClick());
    should(tree.root.findAllByProps({ 'data-fy-render-source': 'true' })).have.length(1);

    // Act — the same block, rendered again, as a virtualised list will do.
    run(() => tree.update(<FyRenderBlock block={svgBlock()} />));

    // Assert — recovering from a stale failure must not cost the reader their
    // panel. Only what the old bytes caused is discarded.
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
 * focus is inside the dialog, focus returns to the trigger, and Tab is trapped —
 * and none of them is observable in a renderer that has no `document`,
 * no `activeElement` and no event dispatch. The regression these guard against
 * is specific and was real: giving the dialog its own conditionally-rendered
 * element changes this subtree's root, so React unmounts the button the reader
 * just pressed, `useDialogFocus` captures `document.body` as the restore target,
 * and the reader ends up outside the dialog they opened. Every assertion below
 * fails on that shape and passes on the stable host.
 */
describe('FyRenderBlock fullscreen focus', () => {
  const openFullscreen = async () => {
    const mounted = await mount(<FyRenderBlock block={svgBlock()} />);
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
    should(dialog.contains(trigger)).be.true();
    // The trigger survived the transition, so focus is still on it — inside the
    // dialog — rather than having fallen back to the document body.
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

  test('should trap Tab rather than let it leave the modal', async () => {
    // Arrange
    const { mounted } = await openFullscreen();
    const dialog = must(mounted.container.querySelector('[role="dialog"]'), 'the dialog');

    // Act — Tab from the last reachable control.
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await interact(() => must(document.activeElement, 'the focused control').dispatchEvent(event));

    // Assert — the browser's own tabbing was suppressed, which is what a trap is.
    should(event.defaultPrevented).be.true();
    should(dialog.contains(document.activeElement)).be.true();
    await mounted.unmount();
  });

  test('should leave Tab alone while the block is an ordinary figure', async () => {
    // Arrange — no dialog, no trap: an illustration in the transcript must not
    // capture the keyboard of the page it is sitting in.
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
