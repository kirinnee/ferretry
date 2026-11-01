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
    return { width: this.classList.contains('fy-item-view__title-text') ? textWidth : BOX } as DOMRect;
  };
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeObserver;
});

afterEach(async () => {
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
