import { afterEach, describe, test } from 'bun:test';
import should from 'should';
import { FyRenderViewport } from '../../src/components/fy-render-viewport.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../support/dom.ts';

const SRC = 'data:image/svg+xml,%3Csvg%2F%3E';
const NATURAL = { height: 600, width: 1_000 };

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const show = async (over: { fullscreen?: boolean; legibleScale?: number } = {}): Promise<HTMLElement> => {
  const view = await mount(
    <FyRenderViewport
      alt="Order flow"
      diagram
      fullscreen={over.fullscreen ?? false}
      kind="Diagram"
      legibleScale={over.legibleScale ?? 0}
      natural={NATURAL}
      onError={() => undefined}
      src={SRC}
    />,
  );
  mounted.push(view);
  return view.container;
};

const pan = (root: HTMLElement): HTMLElement =>
  must(root.querySelector<HTMLElement>('[data-fy-render-scale]'), 'the pan box');
const button = (root: HTMLElement, label: string): HTMLButtonElement =>
  must(root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`), `the ${label} button`);
const scale = (root: HTMLElement): number => Number(pan(root).dataset.fyRenderScale);

describe('FyRenderViewport', () => {
  test('should rest at the fit, whole, with the zoom out and reset disabled', async () => {
    // Act
    const root = await show();

    // Assert — 600px tall into a 60% ceiling: scaled down, never up.
    should(scale(root)).be.below(1);
    should(pan(root).dataset.fyRenderFit).equal('whole');
    should(button(root, 'Zoom out').disabled).be.true();
    should(button(root, 'Reset zoom').disabled).be.true();
    should(button(root, 'Zoom in').disabled).be.false();
  });

  test('should label the viewport and every control for a screen reader', async () => {
    // Act
    const root = await show();

    // Assert
    should(pan(root).getAttribute('aria-label')).equal('Diagram: Order flow');
    should(pan(root).getAttribute('tabindex')).equal('0');
    const hint = must(root.querySelector(`#${pan(root).getAttribute('aria-describedby')}`), 'the hint');
    should(hint.textContent ?? '').match(/zoom/iu);
    for (const label of ['Zoom in', 'Zoom out', 'Reset zoom']) should(button(root, label).type).equal('button');
  });

  test('should show a real image, resized rather than scaled, with no innerHTML sink', async () => {
    // Act
    const root = await show();

    // Assert
    const img = must(root.querySelector('img'), 'the image');
    should(img.getAttribute('src')).equal(SRC);
    should(img.dataset.fyRenderDiagram).equal('true');
    should(img.style.width).match(/px$/u);
    should(root.querySelectorAll('iframe, object, embed, script, canvas').length).equal(0);
  });

  test('should zoom in and out with the buttons, and Reset returns to the fit', async () => {
    // Arrange
    const root = await show();
    const rest = scale(root);

    // Act / Assert
    await interact(() => button(root, 'Zoom in').click());
    should(scale(root)).be.approximately(rest * 1.25, 0.001);
    should(pan(root).dataset.fyRenderPannable).equal('true');
    should(button(root, 'Reset zoom').disabled).be.false();

    await interact(() => button(root, 'Zoom out').click());
    should(scale(root)).be.approximately(rest, 0.001);

    await interact(() => button(root, 'Zoom in').click());
    await interact(() => button(root, 'Reset zoom').click());
    should(scale(root)).be.approximately(rest, 0.001);
  });

  test('should zoom with + and - and reset with 0 when focused', async () => {
    // Arrange
    const root = await show();
    const rest = scale(root);

    // Act / Assert
    await interact(() => pressKey(pan(root), '+'));
    should(scale(root)).be.approximately(rest * 1.25, 0.001);
    await interact(() => pressKey(pan(root), '='));
    should(scale(root)).be.approximately(rest * 1.25 * 1.25, 0.001);
    await interact(() => pressKey(pan(root), '-'));
    should(scale(root)).be.approximately(rest * 1.25, 0.001);
    await interact(() => pressKey(pan(root), '0'));
    should(scale(root)).be.approximately(rest, 0.001);
  });

  test('should leave keys with a modifier to the browser', async () => {
    // Arrange
    const root = await show();
    const rest = scale(root);

    // Act
    await interact(() => pressKey(pan(root), '+', { ctrlKey: true }));

    // Assert
    should(scale(root)).equal(rest);
  });

  test('should zoom on Ctrl+wheel and swallow that wheel so the browser does not zoom the page', async () => {
    // Arrange
    const root = await show();
    const rest = scale(root);
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
    Object.defineProperty(wheel, 'ctrlKey', { value: true });

    // Act
    await interact(() => pan(root).dispatchEvent(wheel));

    // Assert
    should(wheel.defaultPrevented).be.true();
    should(scale(root)).be.above(rest);
  });

  test('should NOT trap a plain wheel inline: the page scrolls', async () => {
    // Arrange
    const root = await show();
    const rest = scale(root);
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 });

    // Act
    await interact(() => pan(root).dispatchEvent(wheel));

    // Assert
    should(wheel.defaultPrevented).be.false();
    should(scale(root)).equal(rest);
  });

  test('should zoom in on a double tap and go back on the next', async () => {
    // Arrange
    const root = await show();
    const rest = scale(root);
    const tap = async (): Promise<void> => {
      const down = new PointerEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 40, pointerId: 1 });
      const up = new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40, pointerId: 1 });
      await interact(() => pan(root).dispatchEvent(down));
      await interact(() => pan(root).dispatchEvent(up));
    };

    // Act / Assert
    await tap();
    should(scale(root)).equal(rest);
    await tap();
    should(scale(root)).be.above(rest * 2);
    await tap();
    await tap();
    should(scale(root)).be.approximately(rest, 0.001);
  });

  test('should pan by dragging once zoomed, and mark the drag while it lasts', async () => {
    // Arrange
    const root = await show();
    await interact(() => button(root, 'Zoom in').click());
    await interact(() => button(root, 'Zoom in').click());
    const img = must(root.querySelector('img'), 'the image');
    const before = img.style.transform;
    const at = (type: string, x: number, y: number): PointerEvent =>
      new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 2 });

    // Act
    await interact(() => pan(root).dispatchEvent(at('pointerdown', 200, 200)));
    await interact(() => pan(root).dispatchEvent(at('pointermove', 120, 150)));

    // Assert
    should(pan(root).dataset.fyRenderDragging).equal('true');
    should(img.style.transform).not.equal(before);
    await interact(() => pan(root).dispatchEvent(at('pointerup', 120, 150)));
    should(pan(root).dataset.fyRenderDragging).equal('false');
  });

  test('should not let a drag move a picture that is wholly visible', async () => {
    // Arrange
    const root = await show();
    const img = must(root.querySelector('img'), 'the image');
    const before = img.style.transform;
    const at = (type: string, x: number): PointerEvent =>
      new PointerEvent(type, { bubbles: true, clientX: x, clientY: 100, pointerId: 3 });

    // Act
    await interact(() => pan(root).dispatchEvent(at('pointerdown', 200)));
    await interact(() => pan(root).dispatchEvent(at('pointermove', 80)));
    await interact(() => pan(root).dispatchEvent(at('pointerup', 80)));

    // Assert
    should(img.style.transform).equal(before);
  });

  test('should rest a picture with unreadable text at the legible scale and pan it', async () => {
    // Act — 0.9 is far above the fit for a 460px ceiling.
    const root = await show({ legibleScale: 0.9 });

    // Assert
    should(pan(root).dataset.fyRenderFit).equal('legible');
    should(scale(root)).equal(0.9);
    should(pan(root).dataset.fyRenderPannable).equal('true');
  });

  test('should mark a fullscreen viewport', async () => {
    // Act
    const root = await show({ fullscreen: true });

    // Assert
    should(root.querySelector('[data-fy-render-viewport="fullscreen"]')).not.be.null();
  });
});
