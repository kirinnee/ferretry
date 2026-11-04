import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MarqueeTitle } from '../../../src/features/agenda/marquee-title.tsx';
import { interact, mount, must } from '../../support/dom.ts';

type Mounted = Awaited<ReturnType<typeof mount>>;

const BOX = 120;
const proto = HTMLElement.prototype;
const realClientWidth = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
const realRect = proto.getBoundingClientRect;

let textWidth = 300;
let view: Mounted | null = null;
let observers: FakeObserver[] = [];

class FakeObserver {
  disconnected = false;
  constructor(readonly fire: () => void) {
    observers.push(this);
  }
  observe(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
}

const draw = async (title: string): Promise<void> => {
  view = await mount(<MarqueeTitle title={title} />);
};
const heading = (): HTMLElement => must(view?.container.querySelector<HTMLElement>('[data-agenda-title]'), 'title');
const click = (): Promise<void> => interact(() => heading().click());

beforeEach(() => {
  textWidth = 300;
  observers = [];
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => BOX });
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains('fy-item-view__title-probe'))
      return { width: (this.textContent ?? '').length * 10 } as DOMRect;
    return { width: this.classList.contains('fy-item-view__title-text') ? textWidth : BOX } as DOMRect;
  };
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeObserver;
});

const realMatchMedia = globalThis.matchMedia;
const reduceMotion = (reduce: boolean): void => {
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({
    matches: reduce,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
};

afterEach(async () => {
  (globalThis as { matchMedia?: unknown }).matchMedia = realMatchMedia;
  await view?.unmount();
  view = null;
  if (realClientWidth === undefined) Reflect.deleteProperty(proto, 'clientWidth');
  else Object.defineProperty(proto, 'clientWidth', realClientWidth);
  proto.getBoundingClientRect = realRect;
  Reflect.deleteProperty(globalThis, 'ResizeObserver');
});

describe('the one-line title', () => {
  test('is plain text when it fits its box: no marquee, and a tap does nothing', async () => {
    textWidth = 100;
    await draw('Short');
    expect(heading().hasAttribute('data-marquee')).toBe(false);
    expect(heading().getAttribute('style')).toBeNull();
    await click();
    expect(heading().hasAttribute('data-expanded')).toBe(false);
  });

  test('scrolls when it is wider than its box, by the distance and time the box needs', async () => {
    await draw('A title that is far too long for the row');
    expect(heading().hasAttribute('data-marquee')).toBe(true);
    expect(heading().style.getPropertyValue('--fy-marquee-distance')).toBe('188px');
    expect(heading().style.getPropertyValue('--fy-marquee-seconds')).toBe('12s');
  });

  test('is measured again when the box resizes, and left alone when the size comes out the same', async () => {
    await draw('A title that is far too long for the row');
    const watch = must(observers[0], 'observer');
    watch.fire();
    await interact(() => watch.fire());
    expect(heading().style.getPropertyValue('--fy-marquee-distance')).toBe('188px');
    textWidth = 100;
    await interact(() => watch.fire());
    expect(heading().hasAttribute('data-marquee')).toBe(false);
  });

  test('unfolds on a tap (reduced motion shows the whole title) and folds on a second; resizing leaves it unfolded', async () => {
    await draw('A title that is far too long for the row');
    await click();
    expect(heading().hasAttribute('data-expanded')).toBe(true);
    textWidth = 100;
    await interact(() => must(observers[0], 'observer').fire());
    expect(heading().hasAttribute('data-marquee')).toBe(true);
    await click();
    expect(heading().hasAttribute('data-expanded')).toBe(false);
  });

  test('starts folded again when the title changes, and stops watching when it goes', async () => {
    await draw('A title that is far too long for the row');
    await click();
    await view?.render(<MarqueeTitle title="Another title that is far too long" />);
    expect(heading().hasAttribute('data-expanded')).toBe(false);
    expect(observers[0]?.disconnected).toBe(true);
    await view?.unmount();
    view = null;
    expect(observers.every(watch => watch.disconnected)).toBe(true);
  });

  test('measures once and watches nothing where there is no ResizeObserver', async () => {
    Reflect.deleteProperty(globalThis, 'ResizeObserver');
    await draw('A title that is far too long for the row');
    expect(heading().hasAttribute('data-marquee')).toBe(true);
    expect(observers).toHaveLength(0);
  });
});

describe('the title where motion is reduced', () => {
  // The fake probe makes every character 10px, and the box is 120px: twelve characters.
  const LONG = 'Three answers for the catalog before I can finish';

  test('ends at the last whole word with "…", never mid-word, and keeps the whole title for a reader', async () => {
    reduceMotion(true);
    await draw(LONG);
    const cut = must(view?.container.querySelector('.fy-item-view__title-cut'), 'the cut title');
    expect(cut.textContent).toBe('Three…');
    expect(cut.getAttribute('aria-hidden')).toBe('true');
    expect(heading().hasAttribute('data-cut')).toBe(true);
    expect(must(heading().querySelector('.fy-item-view__title-text'), 'full text').textContent).toBe(LONG);
  });

  test('shows the whole title on a tap, and the cut one again on a second', async () => {
    reduceMotion(true);
    await draw(LONG);
    await click();
    expect(heading().hasAttribute('data-expanded')).toBe(true);
    await click();
    expect(heading().hasAttribute('data-expanded')).toBe(false);
    expect(heading().hasAttribute('data-cut')).toBe(true);
  });

  test('draws no cut when a title fits, when its first word is wider than the box, or when motion is not reduced', async () => {
    reduceMotion(true);
    textWidth = 100;
    await draw('Short');
    expect(heading().hasAttribute('data-cut')).toBe(false);
    await view?.unmount();
    textWidth = 300;
    await draw('Supercalifragilistic and more words');
    expect(heading().hasAttribute('data-cut')).toBe(false);
    await view?.unmount();
    reduceMotion(false);
    await draw(LONG);
    expect(heading().hasAttribute('data-cut')).toBe(false);
    expect(view?.container.querySelector('.fy-item-view__title-probe')).toBeNull();
  });
});

describe('measuring again when the fonts change', () => {
  test('measures again once the page’s fonts are in and when a later face loads, and stops listening when it goes', async () => {
    const listeners = new Set<() => void>();
    let fontsIn: () => void = () => undefined;
    const fonts = {
      ready: new Promise<void>(resolve => {
        fontsIn = resolve;
      }),
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    };
    const own = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    try {
      textWidth = 100;
      await draw('A title the web face makes wider');
      expect(heading().hasAttribute('data-marquee')).toBe(false);
      // The face is wider than the fallback: the same words no longer fit, and nothing resized.
      textWidth = 300;
      await interact(() => fontsIn());
      expect(heading().hasAttribute('data-marquee')).toBe(true);
      textWidth = 100;
      await interact(() => {
        for (const listener of listeners) listener();
      });
      expect(heading().hasAttribute('data-marquee')).toBe(false);
      await view?.unmount();
      view = null;
      expect(listeners.size).toBe(0);
    } finally {
      if (own === undefined) Reflect.deleteProperty(document, 'fonts');
      else Object.defineProperty(document, 'fonts', own);
    }
  });
});
