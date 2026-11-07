import { describe, expect, it } from 'bun:test';
import { useState } from 'react';
import { ImageViewer, type ViewerImage } from '../../../src/ui/image-viewer.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';

const pictures = (count: number): ViewerImage[] =>
  Array.from({ length: count }, (_, at) => ({
    key: `k${at}`,
    src: `blob:viewer/${at}`,
    failed: false,
    alt: `picture ${at + 1}`,
    filename: `picture-${at + 1}.png`,
    meta: '2 KB',
  }));

function Harness({
  images,
  start = 0,
  onClose,
}: {
  images: readonly ViewerImage[];
  start?: number;
  onClose?: () => void;
}) {
  const [index, setIndex] = useState(start);
  const [open, setOpen] = useState(true);
  if (!open) return <p data-testid="closed">closed</p>;
  return (
    <ImageViewer
      images={images}
      index={index}
      onClose={() => {
        setOpen(false);
        onClose?.();
      }}
      onIndexChange={setIndex}
    />
  );
}

const label = (root: ParentNode, text: string): HTMLElement =>
  must(root.querySelector<HTMLElement>(`[aria-label="${text}"]`), `an element labelled ${text}`);
const dialog = (): HTMLDialogElement =>
  must(document.querySelector<HTMLDialogElement>('[data-testid="image-viewer"]'), 'the viewer');
const shownSrc = (): string | null => dialog().querySelector('img')?.getAttribute('src') ?? null;

describe('the image viewer', () => {
  it('is a modal dialog that names the picture, its place in the set, and offers download and open', async () => {
    const view = await mount(<Harness images={pictures(3)} />);
    expect(dialog().open).toBe(true);
    expect(dialog().getAttribute('aria-label')).toBe('Image viewer: picture 1');
    expect(dialog().textContent).toContain('picture-1.png');
    expect(dialog().textContent).toContain('1 of 3 · 2 KB');
    const download = label(dialog(), 'Download picture-1.png') as HTMLAnchorElement;
    expect(download.getAttribute('href')).toBe('blob:viewer/0');
    expect(download.getAttribute('download')).toBe('picture-1.png');
    expect(label(dialog(), 'Open picture-1.png in a new tab').getAttribute('href')).toBe('blob:viewer/0');
    await view.unmount();
  });

  it('moves between a message’s pictures with the buttons and the arrow keys, and stops at both ends', async () => {
    const view = await mount(<Harness images={pictures(3)} />);
    expect((label(dialog(), 'Previous image') as HTMLButtonElement).disabled).toBe(true);
    await interact(() => label(dialog(), 'Next image').click());
    expect(shownSrc()).toBe('blob:viewer/1');
    expect(dialog().textContent).toContain('2 of 3');
    await interact(() => pressKey(dialog(), 'ArrowRight'));
    expect(shownSrc()).toBe('blob:viewer/2');
    expect((label(dialog(), 'Next image') as HTMLButtonElement).disabled).toBe(true);
    await interact(() => pressKey(dialog(), 'ArrowRight'));
    expect(shownSrc()).toBe('blob:viewer/2');
    await interact(() => pressKey(dialog(), 'ArrowLeft'));
    await interact(() => label(dialog(), 'Previous image').click());
    expect(shownSrc()).toBe('blob:viewer/0');
    await view.unmount();
  });

  it('starts on the picture it was asked to, and a lone picture has no counter or arrows', async () => {
    const many = await mount(<Harness images={pictures(3)} start={2} />);
    expect(shownSrc()).toBe('blob:viewer/2');
    await many.unmount();
    const one = await mount(<Harness images={pictures(1)} />);
    expect(dialog().querySelector('[aria-label="Next image"]')).toBeNull();
    expect(dialog().textContent).not.toContain('1 of 1');
    await one.unmount();
  });

  it('closes from the button, from Escape, and from the dialog’s own cancel', async () => {
    let closed = 0;
    const first = await mount(<Harness images={pictures(2)} onClose={() => (closed += 1)} />);
    await interact(() => label(dialog(), 'Close image viewer').click());
    expect(closed).toBe(1);
    expect(first.container.querySelector('[data-testid="closed"]')).not.toBeNull();
    await first.unmount();

    const second = await mount(<Harness images={pictures(2)} onClose={() => (closed += 1)} />);
    await interact(() => pressKey(dialog(), 'Escape'));
    expect(closed).toBe(2);
    await second.unmount();

    const third = await mount(<Harness images={pictures(2)} onClose={() => (closed += 1)} />);
    await interact(() => {
      dialog().dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(closed).toBe(3);
    await third.unmount();
  });

  it('zooms with the wheel and with + / -, and 0 fits again', async () => {
    const view = await mount(<Harness images={pictures(1)} />);
    const transform = (): string => must(dialog().querySelector('img'), 'the picture').style.transform;
    expect(transform()).toContain('scale(1)');
    await interact(() => pressKey(dialog(), '+'));
    expect(transform()).not.toContain('scale(1)');
    await interact(() => pressKey(dialog(), '0'));
    expect(transform()).toContain('scale(1)');
    const stage = must(dialog().querySelector('[data-testid="image-viewer-stage"]'), 'the stage');
    await interact(() => {
      stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }));
    });
    expect(transform()).not.toContain('scale(1)');
    await interact(() => pressKey(dialog(), '0'));
    await view.unmount();
  });

  it('draws a picture still arriving and a failed one instead of an empty box', async () => {
    const images: ViewerImage[] = [
      { key: 'a', src: null, failed: false, alt: 'late', filename: 'late.png' },
      { key: 'b', src: null, failed: true, alt: 'gone', filename: 'gone.png' },
    ];
    const view = await mount(<Harness images={images} />);
    expect(dialog().textContent).toContain('Loading image');
    expect(dialog().querySelector('a[download]')).toBeNull();
    await interact(() => label(dialog(), 'Next image').click());
    expect(dialog().textContent).toContain('This image is no longer available');
    await view.unmount();
  });
});

/** A 400x300 stage showing an 800x600 picture, so zoomed views have room to pan. */
const withStage = async (images: readonly ViewerImage[], run: (view: Mounted) => Promise<void>): Promise<void> => {
  const proto = HTMLElement.prototype;
  const originals = (['clientWidth', 'clientHeight'] as const).map(
    name => [name, Object.getOwnPropertyDescriptor(proto, name)] as const,
  );
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 400 });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 300 });
  const view = await mount(<Harness images={images} />);
  try {
    const picture = must(dialog().querySelector('img'), 'the picture');
    Object.defineProperty(picture, 'naturalWidth', { configurable: true, value: 800 });
    Object.defineProperty(picture, 'naturalHeight', { configurable: true, value: 600 });
    await interact(() => {
      picture.dispatchEvent(new Event('load'));
    });
    await run(view);
  } finally {
    await view.unmount();
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(proto, name, original);
      else Reflect.deleteProperty(proto, name);
    }
  }
};

const stage = (): HTMLElement =>
  must(dialog().querySelector<HTMLElement>('[data-testid="image-viewer-stage"]'), 'stage');
const transform = (): string => must(dialog().querySelector('img'), 'the picture').style.transform;
const pointer = (type: string, at: { id?: number; x: number; y: number; kind?: string; button?: number }): void => {
  stage().dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: at.id ?? 1,
      pointerType: at.kind ?? 'touch',
      button: at.button ?? 0,
      clientX: at.x,
      clientY: at.y,
    }),
  );
};
const tap = async (x: number, y: number): Promise<void> => {
  await interact(() => pointer('pointerdown', { x, y }));
  await interact(() => pointer('pointerup', { x, y }));
};

describe('the image viewer’s gestures', () => {
  it('double-taps to zoom in and double-taps again to fit; a lone tap and a drag-off do neither', async () => {
    await withStage(pictures(1), async () => {
      expect(transform()).toContain('scale(1)');
      await tap(200, 150);
      expect(transform()).toContain('scale(1)');
      await tap(200, 150);
      expect(transform()).not.toContain('scale(1)');
      await tap(200, 150);
      await tap(200, 150);
      expect(transform()).toContain('scale(1)');

      // A press that wandered is a drag, so the tap after it does not complete a double tap.
      await interact(() => pointer('pointerdown', { x: 200, y: 150 }));
      await interact(() => pointer('pointermove', { x: 214, y: 152 }));
      await interact(() => pointer('pointerup', { x: 214, y: 152 }));
      await tap(200, 150);
      expect(transform()).toContain('scale(1)');
    });
  });

  it('ignores a secondary mouse button and a move from a pointer it never saw', async () => {
    await withStage(pictures(1), async () => {
      await interact(() => pointer('pointerdown', { x: 200, y: 150, kind: 'mouse', button: 2 }));
      await interact(() => pointer('pointermove', { x: 220, y: 150, kind: 'mouse', button: 2 }));
      await interact(() => pointer('pointerup', { x: 220, y: 150, kind: 'mouse', button: 2 }));
      await tap(200, 150);
      await tap(200, 150);
      expect(transform()).not.toContain('scale(1)');
    });
  });

  it('swipes to the next picture and back, and a cancelled touch goes nowhere', async () => {
    await withStage(pictures(3), async () => {
      await interact(() => pointer('pointerdown', { x: 300, y: 150 }));
      await interact(() => pointer('pointermove', { x: 220, y: 152 }));
      await interact(() => pointer('pointerup', { x: 200, y: 152 }));
      expect(shownSrc()).toBe('blob:viewer/1');

      await interact(() => pointer('pointerdown', { x: 200, y: 150 }));
      await interact(() => pointer('pointercancel', { x: 320, y: 150 }));
      expect(shownSrc()).toBe('blob:viewer/1');

      await interact(() => pointer('pointerdown', { x: 100, y: 150 }));
      await interact(() => pointer('pointerup', { x: 260, y: 150 }));
      expect(shownSrc()).toBe('blob:viewer/0');
    });
  });

  it('pans a zoomed picture with a drag, and zooms back out with the - key', async () => {
    await withStage(pictures(2), async () => {
      await interact(() => pressKey(dialog(), '+'));
      await interact(() => pressKey(dialog(), '='));
      const zoomed = transform();
      expect(zoomed).not.toContain('scale(1)');
      await interact(() => pointer('pointerdown', { x: 200, y: 150 }));
      await interact(() => pointer('pointermove', { x: 240, y: 170 }));
      await interact(() => pointer('pointerup', { x: 240, y: 170 }));
      expect(transform()).not.toBe(zoomed);
      expect(shownSrc()).toBe('blob:viewer/0');

      await interact(() => pressKey(dialog(), '-'));
      await interact(() => pressKey(dialog(), '_'));
      await interact(() => pressKey(dialog(), '_'));
      expect(transform()).toContain('scale(1)');
    });
  });

  it('pinches two fingers apart to zoom in, and lifting them one by one ends the pinch', async () => {
    await withStage(pictures(1), async () => {
      await interact(() => pointer('pointerdown', { id: 1, x: 180, y: 150 }));
      await interact(() => pointer('pointerdown', { id: 2, x: 220, y: 150 }));
      await interact(() => pointer('pointermove', { id: 2, x: 320, y: 150 }));
      await interact(() => pointer('pointermove', { id: 1, x: 100, y: 150 }));
      expect(transform()).not.toContain('scale(1)');
      await interact(() => pointer('pointerup', { id: 2, x: 320, y: 150 }));
      await interact(() => pointer('pointerup', { id: 1, x: 100, y: 150 }));
      const pinched = transform();
      await interact(() => pointer('pointerdown', { id: 1, x: 200, y: 150 }));
      await interact(() => pointer('pointermove', { id: 1, x: 190, y: 150 }));
      await interact(() => pointer('pointerup', { id: 1, x: 190, y: 150 }));
      expect(transform()).not.toBe(pinched);
    });
  });
});
