/**
 * The full-size picture viewer (`fy-render-image-zoom.tsx`).
 *
 * happy-dom lays nothing out and decodes nothing, so the stage's size and the picture's natural size are given
 * to it for the length of a test, exactly as `fy-render-viewport.view.test.tsx` does for its box. The proof is
 * what the viewer is handed (the same `src`, at natural pixels), what its controls do to the transform, and the
 * focus and close contract — never how a browser rasterises.
 */
import { afterEach, describe, test } from 'bun:test';
import should from 'should';
import { ensureDom, interact, type Mounted, mount, must, pressKey } from '@ferretry/app/testing';
import { FyRenderZoomImage } from '../../../../app/render/fy-render-image-zoom.tsx';

const SRC = 'blob:https://pwa.example.test/00000000-0000-4000-8000-000000000000';
/** A large fake picture: 3000 x 2000 into a 1000 x 800 stage rests at a third. */
const NATURAL = { height: 2_000, width: 3_000 };
const STAGE = { height: 800, width: 1_000 };

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const define = (target: object, key: string, value: number): (() => void) => {
  const was = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, get: () => value });
  return () => {
    if (was) Object.defineProperty(target, key, was);
    else Reflect.deleteProperty(target, key);
  };
};

/** Give every element the stage's size and every image its natural one, for the length of `run`. */
const laidOut = async (run: () => Promise<void>): Promise<void> => {
  ensureDom();
  const undo = [
    define(HTMLElement.prototype, 'clientWidth', STAGE.width),
    define(HTMLElement.prototype, 'clientHeight', STAGE.height),
    define(HTMLImageElement.prototype, 'naturalWidth', NATURAL.width),
    define(HTMLImageElement.prototype, 'naturalHeight', NATURAL.height),
  ];
  try {
    await run();
  } finally {
    for (const each of undo) each();
  }
};

const show = async (): Promise<HTMLElement> => {
  const view = await mount(<FyRenderZoomImage alt="A big chart" className="fy-render-image" src={SRC} />);
  mounted.push(view);
  return view.container;
};

const trigger = (root: HTMLElement): HTMLButtonElement =>
  must(root.querySelector<HTMLButtonElement>('button[data-fy-render-zoom-trigger]'), 'the picture button');
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-fy-render-zoom="open"]');
const stage = (): HTMLElement => must(document.querySelector<HTMLElement>('.fy-zoom-stage'), 'the stage');
const picture = (): HTMLImageElement => must(document.querySelector<HTMLImageElement>('.fy-zoom-img'), 'the picture');
const control = (label: string): HTMLButtonElement =>
  must(document.querySelector<HTMLButtonElement>(`.fy-zoom-bar button[aria-label="${label}"]`), `the ${label} button`);
const scale = (): number => Number(stage().dataset.fyRenderZoomScale);
const open = async (root: HTMLElement): Promise<void> => {
  trigger(root).focus();
  await interact(() => trigger(root).click());
};
const pointer = (type: string, x: number, y: number, id = 1): PointerEvent =>
  new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: id });

describe('FyRenderZoomImage', () => {
  test('should be a keyboard-reachable button that holds the inline picture, and show no viewer until pressed', async () => {
    await laidOut(async () => {
      // Act
      const root = await show();

      // Assert
      const button = trigger(root);
      should(button.type).equal('button');
      should(button.getAttribute('aria-label')).equal('Open full size: A big chart');
      should(button.tabIndex).be.aboveOrEqual(0);
      should(button.querySelector('img')?.getAttribute('src')).equal(SRC);
      should(button.querySelector('img')?.className).equal('fy-render-image');
      should(dialog()).be.null();
    });
  });

  test('should open the viewer on a click with the SAME src, drawn at its natural size', async () => {
    await laidOut(async () => {
      // Arrange
      const root = await show();

      // Act
      await open(root);

      // Assert — no downscaled copy: same address, natural pixels, scaled by transform only.
      should(dialog()?.getAttribute('role')).equal('dialog');
      should(dialog()?.getAttribute('aria-modal')).equal('true');
      should(picture().getAttribute('src')).equal(SRC);
      should(picture().style.width).equal('3000px');
      should(picture().style.height).equal('2000px');
      should(picture().style.transform).match(/scale\(0\.3333/u);
      should(stage().dataset.fyRenderZoomFit).equal('true');
      should(document.querySelector('[data-fy-render-zoom-readout]')?.textContent).equal('33% · 3000×2000');
    });
  });

  test('should open from the keyboard: Enter on the focused button', async () => {
    await laidOut(async () => {
      // Arrange
      const root = await show();
      trigger(root).focus();

      // Act — a real browser turns Enter on a button into a click; happy-dom does too.
      await interact(() => trigger(root).click());

      // Assert
      should(dialog()).not.be.null();
      should(document.activeElement).equal(dialog());
    });
  });

  test('should change the transform when Zoom in is pressed, and come back on Fit', async () => {
    await laidOut(async () => {
      // Arrange
      const root = await show();
      await open(root);
      const rest = scale();
      const before = picture().style.transform;

      // Act
      await interact(() => control('Zoom in').click());

      // Assert
      should(scale()).be.approximately(rest * 1.5, 0.001);
      should(picture().style.transform).not.equal(before);
      should(stage().dataset.fyRenderZoomFit).equal('false');
      should(control('Fit to screen').getAttribute('aria-disabled')).equal('false');

      // Act
      await interact(() => control('Fit to screen').click());

      // Assert
      should(scale()).be.approximately(rest, 0.001);
      should(picture().style.transform).equal(before);
    });
  });

  test('should show the natural resolution on Actual size and never zoom out past the fit', async () => {
    await laidOut(async () => {
      // Arrange
      const root = await show();
      await open(root);

      // Act
      await interact(() => control('Actual size').click());

      // Assert
      should(scale()).equal(1);
      should(control('Actual size').getAttribute('aria-disabled')).equal('true');

      // Act — out and out again stops at the fit.
      for (let press = 0; press < 6; press += 1) await interact(() => control('Zoom out').click());

      // Assert
      should(scale()).be.approximately(1 / 3, 0.001);
      should(control('Zoom out').getAttribute('aria-disabled')).equal('true');
    });
  });

  test('should zoom on the wheel and swallow it so the page behind does not scroll', async () => {
    await laidOut(async () => {
      // Arrange
      const root = await show();
      await open(root);
      const rest = scale();
      const wheel = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: 500,
        clientY: 400,
        deltaY: -200,
      });

      // Act
      await interact(() => stage().dispatchEvent(wheel));

      // Assert
      should(scale()).be.above(rest);
      should(wheel.defaultPrevented).be.true();
    });
  });

  test('should toggle between fit and 100% on a double tap', async () => {
    await laidOut(async () => {
      // Arrange
      const root = await show();
      await open(root);
      const tap = async (): Promise<void> => {
        await interact(() => picture().dispatchEvent(pointer('pointerdown', 300, 300)));
        await interact(() => picture().dispatchEvent(pointer('pointerup', 300, 300)));
      };

      // Act / Assert
      await tap();
      should(scale()).be.approximately(1 / 3, 0.001);
      await tap();
      should(scale()).equal(1);
      await tap();
      await tap();
      should(scale()).be.approximately(1 / 3, 0.001);
    });
  });

  test('should pan by dragging once zoomed, and not move a picture that already fits', async () => {
    await laidOut(async () => {
      // Arrange
      const root = await show();
      await open(root);
      const fitted = picture().style.transform;
      await interact(() => stage().dispatchEvent(pointer('pointerdown', 500, 400)));
      await interact(() => stage().dispatchEvent(pointer('pointermove', 400, 300)));
      await interact(() => stage().dispatchEvent(pointer('pointerup', 400, 300)));
      should(picture().style.transform).equal(fitted);
      await interact(() => control('Actual size').click());
      const before = picture().style.transform;

      // Act
      await interact(() => stage().dispatchEvent(pointer('pointerdown', 500, 400, 2)));
      await interact(() => stage().dispatchEvent(pointer('pointermove', 400, 300, 2)));

      // Assert
      should(stage().dataset.fyRenderZoomDragging).equal('true');
      should(picture().style.transform).not.equal(before);
      await interact(() => stage().dispatchEvent(pointer('pointerup', 400, 300, 2)));
      should(stage().dataset.fyRenderZoomDragging).equal('false');
    });
  });

  test('should zoom on a two-finger pinch', async () => {
    await laidOut(async () => {
      // Arrange
      const root = await show();
      await open(root);
      const rest = scale();

      // Act — two fingers 100px apart spread to 200px.
      await interact(() => stage().dispatchEvent(pointer('pointerdown', 450, 400, 1)));
      await interact(() => stage().dispatchEvent(pointer('pointerdown', 550, 400, 2)));
      await interact(() => stage().dispatchEvent(pointer('pointermove', 400, 400, 1)));
      await interact(() => stage().dispatchEvent(pointer('pointermove', 600, 400, 2)));

      // Assert
      should(scale()).be.approximately(rest * 2, 0.01);
    });
  });

  test('should close on Escape and return focus to the picture button', async () => {
    await laidOut(async () => {
      // Arrange
      const root = await show();
      await open(root);

      // Act
      await interact(() => pressKey(document, 'Escape'));

      // Assert
      should(dialog()).be.null();
      should(document.activeElement).equal(trigger(root));
    });
  });

  test('should close on Escape pressed while a viewer button has focus', async () => {
    await laidOut(async () => {
      // Arrange
      const root = await show();
      await open(root);
      control('Zoom in').focus();

      // Act — the key reaches `document` only if the viewer does not swallow it.
      await interact(() => pressKey(control('Zoom in'), 'Escape'));

      // Assert
      should(dialog()).be.null();
      should(document.activeElement).equal(trigger(root));
    });
  });

  test('should close on a tap of the empty backdrop, but not on a tap of the picture', async () => {
    await laidOut(async () => {
      // Arrange
      const root = await show();
      await open(root);

      // Act — the picture.
      await interact(() => picture().dispatchEvent(pointer('pointerdown', 300, 300)));
      await interact(() => picture().dispatchEvent(pointer('pointerup', 300, 300)));

      // Assert
      should(dialog()).not.be.null();

      // Act — the backdrop.
      await interact(() => stage().dispatchEvent(pointer('pointerdown', 5, 5)));
      await interact(() => stage().dispatchEvent(pointer('pointerup', 5, 5)));

      // Assert
      should(dialog()).be.null();
      should(document.activeElement).equal(trigger(root));
    });
  });

  test('should close on the Close button and return focus', async () => {
    await laidOut(async () => {
      // Arrange
      const root = await show();
      await open(root);

      // Act
      await interact(() => control('Close').click());

      // Assert
      should(dialog()).be.null();
      should(document.activeElement).equal(trigger(root));
    });
  });

  test('should zoom from the keyboard with + - 0', async () => {
    await laidOut(async () => {
      // Arrange
      const root = await show();
      await open(root);
      const rest = scale();

      // Act / Assert
      await interact(() => pressKey(must(dialog(), 'the dialog'), '+'));
      should(scale()).be.above(rest);
      await interact(() => pressKey(must(dialog(), 'the dialog'), '0'));
      should(scale()).be.approximately(rest, 0.001);
    });
  });
});
