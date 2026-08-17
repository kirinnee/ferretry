import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { BottomSheet } from '../../src/shell/bottom-sheet.tsx';
import { interact, mount, pressKey } from '../support/dom.ts';

type MediaListener = () => void;

interface FakeMedia {
  matches: boolean;
  readonly listeners: Set<MediaListener>;
}

const media: FakeMedia = { matches: false, listeners: new Set() };

const installMatchMedia = (): void => {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    // A getter, like the real MediaQueryList: the hook keeps the object it was
    // handed and re-reads `matches` when the change listener fires.
    get matches() {
      return query.includes('reduce') ? media.matches : false;
    },
    addEventListener: (_: string, listener: MediaListener) => media.listeners.add(listener),
    removeEventListener: (_: string, listener: MediaListener) => media.listeners.delete(listener),
  });
};

const sheet = (props: { open: boolean; onClose?: () => void; height?: string }) => (
  <BottomSheet
    id="test-sheet"
    open={props.open}
    onClose={props.onClose ?? (() => {})}
    closeLabel="Close the sheet"
    ariaLabel="Test sheet"
    {...(props.height ? { height: props.height } : {})}
  >
    <button type="button">inside</button>
  </BottomSheet>
);

const panelOf = (container: HTMLElement): HTMLElement => container.querySelector('#test-sheet') as HTMLElement;
const handleOf = (container: HTMLElement): HTMLElement =>
  container.querySelector('[data-sheet-swipe="supported"]') as HTMLElement;
const backdropOf = (container: HTMLElement): HTMLElement => container.querySelectorAll('button')[0] as HTMLElement;

/** React reads pointer fields off the native event, so a plain Event carrying
 *  them is exactly what the handler sees. */
const firePointer = (
  target: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  fields: { pointerId?: number; clientY?: number; button?: number } = {},
): void => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, clientY: 0, button: 0, ...fields });
  target.dispatchEvent(event);
};

/** happy-dom has no layout, so the sheet has no height to measure against. */
const givePanelHeight = (panel: HTMLElement, height: number): void => {
  panel.getBoundingClientRect = () => ({ height }) as DOMRect;
};

/**
 * `matchMedia` IS PROCESS-WIDE and this fake is deliberately partial.
 *
 * It answers `addEventListener` only, which is all `BottomSheet` asks for and is the whole point of a
 * fake this small. Bun runs the tier in one process against one happy-dom window, though, so an
 * unrestored fake becomes the `matchMedia` every later FILE gets — and something out there does ask
 * for more: xterm's core browser service still calls the LEGACY `MediaQueryList.addListener`, which
 * this object does not have. That is not hypothetical. It is why `app.test.tsx` reported a terminal
 * deck whose socket never opened on CI and nowhere else — the emulator threw
 * `this._resolutionMediaMatchList.addListener is not a function` inside a promise whose `.catch` turns
 * every failure into a silent `refused` — and it was CI-only purely because CI walks the test tree in
 * a different order than a laptop does.
 *
 * So the window is handed back. Making the fake richer would work too and would be the wrong fix: the
 * next partial fake would leak the next missing method.
 */
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

afterAll(() => {
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
});

beforeEach(() => {
  media.matches = false;
  media.listeners.clear();
  installMatchMedia();
});

describe('BottomSheet', () => {
  it('renders nothing at all while closed and never opened', async () => {
    const sheetMount = await mount(sheet({ open: false }));

    expect(sheetMount.container.innerHTML).toBe('');

    await sheetMount.unmount();
  });

  it('opens as a labelled modal dialog with a focusable panel', async () => {
    const sheetMount = await mount(sheet({ open: true }));
    const panel = panelOf(sheetMount.container);

    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('aria-label')).toBe('Test sheet');
    expect(panel.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(panel);

    await sheetMount.unmount();
  });

  it('prefers an explicit labelledby over the aria-label', async () => {
    const sheetMount = await mount(
      <BottomSheet id="test-sheet" open onClose={() => {}} closeLabel="Close" ariaLabel="Ignored" labelledBy="title-1">
        <span>body</span>
      </BottomSheet>,
    );
    const panel = panelOf(sheetMount.container);

    expect(panel.getAttribute('aria-labelledby')).toBe('title-1');
    expect(panel.getAttribute('aria-label')).toBeNull();

    await sheetMount.unmount();
  });

  it('slides in on the frame after opening', async () => {
    const sheetMount = await mount(sheet({ open: true }));
    const panel = panelOf(sheetMount.container);

    expect(panel.style.transform).toBe('translateY(0)');

    await sheetMount.unmount();
  });

  it('applies a fixed height that still yields to the max height ceiling', async () => {
    const sheetMount = await mount(sheet({ open: true, height: '480px' }));
    const panel = panelOf(sheetMount.container);

    expect(panel.style.height).toBe('480px');
    expect(panel.style.maxHeight).toContain('72dvh');

    await sheetMount.unmount();
  });

  it('closes on the backdrop, and on the handle when it was not dragged', async () => {
    let closes = 0;
    const sheetMount = await mount(sheet({ open: true, onClose: () => (closes += 1) }));

    await interact(() => backdropOf(sheetMount.container).click());
    expect(closes).toBe(1);

    await interact(() => handleOf(sheetMount.container).click());
    expect(closes).toBe(2);

    await sheetMount.unmount();
  });

  it('closes on Escape from inside', async () => {
    let closes = 0;
    const sheetMount = await mount(sheet({ open: true, onClose: () => (closes += 1) }));

    await interact(() => pressKey(document, 'Escape'));

    expect(closes).toBe(1);
    await sheetMount.unmount();
  });

  it('keeps the closing sheet mounted, inert and out of the tab order until its slide ends', async () => {
    const sheetMount = await mount(sheet({ open: true }));

    await sheetMount.render(sheet({ open: false }));
    const panel = panelOf(sheetMount.container);

    expect(panel).not.toBeNull();
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.getAttribute('aria-modal')).toBeNull();
    expect(panel.style.transform).toBe('translateY(100%)');
    expect(backdropOf(sheetMount.container).getAttribute('tabindex')).toBe('-1');
    expect(sheetMount.container.querySelector('[data-bottom-sheet]')?.getAttribute('aria-hidden')).toBe('true');

    await interact(() => {
      panel.dispatchEvent(Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'transform' }));
    });

    expect(sheetMount.container.innerHTML).toBe('');
    await sheetMount.unmount();
  });

  it('unmounts immediately, with no slide, when the reader prefers reduced motion', async () => {
    media.matches = true;
    const sheetMount = await mount(sheet({ open: true }));

    expect(panelOf(sheetMount.container).style.transform).toBe('translateY(0)');

    await sheetMount.render(sheet({ open: false }));

    expect(sheetMount.container.innerHTML).toBe('');
    await sheetMount.unmount();
  });

  it('follows a live change of the reduced-motion preference', async () => {
    const sheetMount = await mount(sheet({ open: true }));

    await interact(() => {
      media.matches = true;
      for (const listener of media.listeners) listener();
    });

    await sheetMount.render(sheet({ open: false }));
    expect(sheetMount.container.innerHTML).toBe('');

    await sheetMount.unmount();
  });

  it('dismisses a swipe that travels past a quarter of the sheet', async () => {
    let closes = 0;
    const sheetMount = await mount(sheet({ open: true, onClose: () => (closes += 1) }));
    const handle = handleOf(sheetMount.container);
    givePanelHeight(panelOf(sheetMount.container), 400);

    await interact(() => {
      firePointer(handle, 'pointerdown', { clientY: 0 });
      firePointer(handle, 'pointermove', { clientY: 150 });
      firePointer(handle, 'pointerup', { clientY: 150 });
    });

    expect(closes).toBe(1);
    await sheetMount.unmount();
  });

  it('snaps back when the swipe is too short and too slow, and swallows the handle click', async () => {
    let closes = 0;
    const sheetMount = await mount(sheet({ open: true, onClose: () => (closes += 1) }));
    const handle = handleOf(sheetMount.container);
    const panel = panelOf(sheetMount.container);
    givePanelHeight(panel, 400);

    await interact(() => {
      firePointer(handle, 'pointerdown', { clientY: 0 });
      firePointer(handle, 'pointermove', { clientY: 8 });
      firePointer(handle, 'pointermove', { clientY: 8 });
      firePointer(handle, 'pointerup', { clientY: 8 });
    });

    expect(closes).toBe(0);
    expect(panel.style.transform).toBe('translateY(0)');

    // The drag already moved the sheet, so the click that follows it is not a tap.
    await interact(() => handle.click());
    expect(closes).toBe(0);

    await sheetMount.unmount();
  });

  it('tracks the drag offset while the finger is down', async () => {
    const sheetMount = await mount(sheet({ open: true }));
    const handle = handleOf(sheetMount.container);
    const panel = panelOf(sheetMount.container);
    givePanelHeight(panel, 400);

    await interact(() => {
      firePointer(handle, 'pointerdown', { clientY: 10 });
      firePointer(handle, 'pointermove', { clientY: 60 });
    });

    expect(panel.style.transform).toBe('translateY(50px)');

    // An upward drag never lifts the sheet above its resting position.
    await interact(() => firePointer(handle, 'pointermove', { clientY: -40 }));
    expect(panel.style.transform).toBe('translateY(0px)');

    await interact(() => firePointer(handle, 'pointercancel', { clientY: -40 }));
    await sheetMount.unmount();
  });

  it('abandons the gesture on pointercancel and on losing the window', async () => {
    let closes = 0;
    const sheetMount = await mount(sheet({ open: true, onClose: () => (closes += 1) }));
    const handle = handleOf(sheetMount.container);
    givePanelHeight(panelOf(sheetMount.container), 400);

    await interact(() => {
      firePointer(handle, 'pointerdown', { clientY: 0 });
      firePointer(handle, 'pointermove', { clientY: 300 });
      firePointer(handle, 'pointercancel', { clientY: 300 });
    });
    expect(closes).toBe(0);

    await interact(() => {
      firePointer(handle, 'pointerdown', { clientY: 0 });
      firePointer(handle, 'pointermove', { clientY: 300 });
      window.dispatchEvent(new Event('blur'));
      firePointer(handle, 'pointerup', { clientY: 300 });
    });
    expect(closes).toBe(0);

    await sheetMount.unmount();
  });

  it('ignores a second pointer and a non-primary button', async () => {
    let closes = 0;
    const sheetMount = await mount(sheet({ open: true, onClose: () => (closes += 1) }));
    const handle = handleOf(sheetMount.container);
    givePanelHeight(panelOf(sheetMount.container), 400);

    await interact(() => {
      firePointer(handle, 'pointerdown', { clientY: 0, button: 2 });
      firePointer(handle, 'pointermove', { clientY: 300 });
      firePointer(handle, 'pointerup', { clientY: 300 });
    });
    expect(closes).toBe(0);

    await interact(() => {
      firePointer(handle, 'pointerdown', { pointerId: 1, clientY: 0 });
      firePointer(handle, 'pointermove', { pointerId: 2, clientY: 300 });
      firePointer(handle, 'pointerup', { pointerId: 2, clientY: 300 });
    });
    expect(closes).toBe(0);

    await sheetMount.unmount();
  });

  it('ignores a blur when no swipe is in flight', async () => {
    const sheetMount = await mount(sheet({ open: true }));

    await interact(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(panelOf(sheetMount.container).style.transform).toBe('translateY(0)');
    await sheetMount.unmount();
  });

  it('ignores a transitionend for another property or from a descendant', async () => {
    const sheetMount = await mount(sheet({ open: true }));
    await sheetMount.render(sheet({ open: false }));
    const panel = panelOf(sheetMount.container);

    await interact(() => {
      panel.dispatchEvent(Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'opacity' }));
      handleOf(sheetMount.container).dispatchEvent(
        Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'transform' }),
      );
    });

    expect(panelOf(sheetMount.container)).not.toBeNull();
    await sheetMount.unmount();
  });

  it('survives a browser with no matchMedia at all', async () => {
    const original = window.matchMedia;
    (window as unknown as { matchMedia: unknown }).matchMedia = undefined;

    const sheetMount = await mount(sheet({ open: true }));
    expect(panelOf(sheetMount.container).getAttribute('role')).toBe('dialog');

    await sheetMount.unmount();
    (window as unknown as { matchMedia: unknown }).matchMedia = original;
  });
});
