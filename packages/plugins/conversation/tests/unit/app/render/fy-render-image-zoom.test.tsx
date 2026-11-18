/**
 * The picture that opens full-size (`fy-render-image-zoom.tsx`): a button around the inline picture that opens the
 * app's ONE `ImageViewer`. The viewer's own zoom, pan, pinch and toolbar are proved in the app package
 * (`image-viewer.test.tsx`); what is proved here is what is specific to a message picture — the button, that the
 * viewer is handed the SAME `src`, that focus comes back to the picture, and that nothing typed or tapped in the viewer
 * reaches the message it was opened from.
 */
import { afterEach, describe, test } from 'bun:test';
import should from 'should';
import { ensureDom, interact, type Mounted, mount, must, pressKey } from '@ferretry/app/testing';
import { FyRenderZoomImage } from '../../../../app/render/fy-render-image-zoom.tsx';

const SRC = 'blob:https://pwa.example.test/00000000-0000-4000-8000-000000000000';
const DATA_SRC = 'data:image/png;base64,iVBORw0KGgo=';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

interface Heard {
  clicks: number;
  keys: string[];
  pointers: number;
}

const show = async (src = SRC, heard?: Heard): Promise<HTMLElement> => {
  ensureDom();
  const view = await mount(
    // The message the picture sits in: a row that hears every click, pointer press and key.
    // biome-ignore lint/a11y/noStaticElementInteractions: a stand-in for the message row the viewer must not leak to
    <div
      onClick={() => {
        if (heard) heard.clicks += 1;
      }}
      onKeyDown={event => {
        heard?.keys.push(event.key);
      }}
      onPointerDown={() => {
        if (heard) heard.pointers += 1;
      }}
    >
      <FyRenderZoomImage alt="A big chart" className="fy-render-image" src={src} />
    </div>,
  );
  mounted.push(view);
  return view.container;
};

const trigger = (root: HTMLElement): HTMLButtonElement =>
  must(root.querySelector<HTMLButtonElement>('button[data-fy-render-zoom-trigger]'), 'the picture button');
const dialog = (): HTMLDialogElement | null =>
  document.querySelector<HTMLDialogElement>('[data-testid="image-viewer"]');
const picture = (): HTMLImageElement =>
  must(document.querySelector<HTMLImageElement>('[data-testid="image-viewer"] img'), 'the viewer picture');
const open = async (root: HTMLElement): Promise<void> => {
  trigger(root).focus();
  await interact(() => trigger(root).click());
};

describe('FyRenderZoomImage', () => {
  test('should be a keyboard-reachable button that holds the inline picture, and show no viewer until pressed', async () => {
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

  test('should open the app’s one viewer on a click, with the SAME src — no second copy', async () => {
    // Arrange
    const root = await show();

    // Act
    await open(root);

    // Assert
    should(dialog()?.open).equal(true);
    should(dialog()?.getAttribute('aria-modal')).equal('true');
    should(picture().getAttribute('src')).equal(SRC);
    should(dialog()?.textContent).containEql('A big chart');
  });

  test('should offer Download and Open for a blob picture, and Download only for a data: one', async () => {
    // Arrange
    const blob = await show();
    await open(blob);

    // Assert
    should(document.querySelector('a[download]')?.getAttribute('href')).equal(SRC);
    should(document.querySelector('a[aria-label^="Open "]')).not.be.null();
    await interact(() => pressKey(must(dialog(), 'the viewer'), 'Escape'));

    // Arrange
    await mounted.pop()?.unmount();
    const data = await show(DATA_SRC);
    await open(data);

    // Assert — a browser will not navigate to a data: URL, so it is not offered; saving it is fine and is named for its type.
    should(document.querySelector('a[aria-label^="Open "]')).be.null();
    should(document.querySelector('a[download]')?.getAttribute('download')).equal('A big chart.png');
  });

  test('should close on Escape and return focus to the picture button', async () => {
    // Arrange
    const root = await show();
    await open(root);

    // Act
    await interact(() => pressKey(must(dialog(), 'the viewer'), 'Escape'));

    // Assert
    should(dialog()).be.null();
    should(document.activeElement).equal(trigger(root));
  });

  test('should close on Escape pressed while a viewer button has focus, and not let that Escape reach the message', async () => {
    // Arrange
    const heard: Heard = { clicks: 0, keys: [], pointers: 0 };
    const root = await show(SRC, heard);
    await open(root);
    const close = must(document.querySelector<HTMLButtonElement>('[aria-label="Close image viewer"]'), 'Close');
    close.focus();
    heard.keys.length = 0;

    // Act
    await interact(() => pressKey(close, 'Escape'));

    // Assert — closed by the viewer, and the row the picture sits in never heard the key (a block's own fullscreen would have left too).
    should(dialog()).be.null();
    should(heard.keys).eql([]);
    should(document.activeElement).equal(trigger(root));
  });

  test('should keep every other key and tap inside the viewer, so the message behind is not acted on', async () => {
    // Arrange
    const heard: Heard = { clicks: 0, keys: [], pointers: 0 };
    const root = await show(SRC, heard);
    await open(root);
    const before = { clicks: heard.clicks, pointers: heard.pointers };

    // Act
    await interact(() => pressKey(must(dialog(), 'the viewer'), '+'));
    await interact(() =>
      must(document.querySelector('[data-testid="image-viewer-stage"]'), 'stage').dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5, pointerId: 1 }),
      ),
    );
    await interact(() =>
      must(document.querySelector<HTMLElement>('[data-testid="image-viewer-stage"]'), 'stage').click(),
    );

    // Assert
    should(heard.keys).eql([]);
    should(heard.clicks).equal(before.clicks);
    should(heard.pointers).equal(before.pointers);
  });

  test('should close on the Close button and return focus', async () => {
    // Arrange
    const root = await show();
    await open(root);

    // Act
    await interact(() =>
      must(document.querySelector<HTMLButtonElement>('[aria-label="Close image viewer"]'), 'Close').click(),
    );

    // Assert
    should(dialog()).be.null();
    should(document.activeElement).equal(trigger(root));
  });
});
