/**
 * The level-three tab strip: underlined tabs that switch a view, and on a phone a strip that scrolls
 * sideways with the current tab kept in the middle and a fade on whichever edge has more tabs.
 *
 * Layout is not something happy-dom computes, so every geometry fact (`scrollWidth`, `clientWidth`,
 * `offsetLeft`, …) is faked per element with `Object.defineProperty`; what is under test is what the
 * strip DOES with those numbers.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { centredScrollLeft, stripOverflow, UnderlineTabs } from '../../src/shell/underline-tabs.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

type TabId = 'one' | 'two' | 'three';

const TABS = [
  { id: 'one', label: 'One', icon: <svg data-icon="one" /> },
  { id: 'two', label: 'Two' },
  { id: 'three', label: 'Three' },
] as const;

const define = (element: Element, values: Record<string, number>): void => {
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(element, key, { configurable: true, get: () => value });
};

/**
 * Fakes the strip's geometry on every new `<ul>` and every tab button before React's layout effect reads
 * them, by patching the prototypes for the duration of one test.
 */
const geometry = {
  strip: { clientWidth: 100, scrollWidth: 300 },
  tabs: { one: [0, 80], two: [100, 80], three: [220, 80] } as Record<TabId, [number, number]>,
};

const originals = {
  matchMedia: window.matchMedia,
  ResizeObserver: globalThis.ResizeObserver,
  scrollTo: HTMLElement.prototype.scrollTo,
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  scrollWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth'),
  offsetLeft: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft'),
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
};

const restore = (target: object, key: string, descriptor: PropertyDescriptor | undefined): void => {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else delete (target as Record<string, unknown>)[key];
};

const tabOf = (element: HTMLElement): TabId | undefined =>
  (element.getAttribute('data-test-tab') ?? undefined) as TabId | undefined;

let scrolls: ScrollToOptions[];
let mounted: Mounted | undefined;

beforeEach(() => {
  scrolls = [];
  geometry.strip = { clientWidth: 100, scrollWidth: 300 };
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.tagName === 'UL' ? geometry.strip.clientWidth : 0;
    },
  });
  Object.defineProperty(Element.prototype, 'scrollWidth', {
    configurable: true,
    get(this: Element) {
      return this.tagName === 'UL' ? geometry.strip.scrollWidth : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
    configurable: true,
    get(this: HTMLElement) {
      const id = tabOf(this);
      return id === undefined ? 0 : geometry.tabs[id][0];
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      const id = tabOf(this);
      return id === undefined ? 0 : geometry.tabs[id][1];
    },
  });
  HTMLElement.prototype.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
    const next = options as ScrollToOptions;
    scrolls.push(next);
    this.scrollLeft = next.left ?? 0;
  } as typeof HTMLElement.prototype.scrollTo;
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  window.matchMedia = originals.matchMedia;
  globalThis.ResizeObserver = originals.ResizeObserver;
  HTMLElement.prototype.scrollTo = originals.scrollTo;
  restore(HTMLElement.prototype, 'clientWidth', originals.clientWidth);
  restore(Element.prototype, 'scrollWidth', originals.scrollWidth);
  restore(HTMLElement.prototype, 'offsetLeft', originals.offsetLeft);
  restore(HTMLElement.prototype, 'offsetWidth', originals.offsetWidth);
});

const strip = (
  current: TabId,
  onSelect: (id: TabId) => void = () => {},
  tabs: readonly (typeof TABS)[number][] = TABS,
) => (
  <UnderlineTabs<TabId>
    tabs={tabs}
    current={current}
    onSelect={onSelect}
    label="Studio views"
    marker="data-test-tab"
    className="extra"
  />
);

const nav = (container: HTMLElement): HTMLElement => must(container.querySelector('nav'), 'the tab strip');
const list = (container: HTMLElement): HTMLUListElement => must(container.querySelector('ul'), 'the strip');
const button = (container: HTMLElement, id: TabId): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>(`[data-test-tab="${id}"]`), `tab ${id}`);

describe('centredScrollLeft', () => {
  it('puts the tab in the middle of the strip', () => {
    expect(centredScrollLeft({ clientWidth: 100, scrollWidth: 300 }, { offsetLeft: 100, offsetWidth: 80 })).toBe(90);
  });

  it('never scrolls before the start', () => {
    expect(centredScrollLeft({ clientWidth: 100, scrollWidth: 300 }, { offsetLeft: 0, offsetWidth: 80 })).toBe(0);
  });

  it('never scrolls past the end', () => {
    expect(centredScrollLeft({ clientWidth: 100, scrollWidth: 300 }, { offsetLeft: 280, offsetWidth: 20 })).toBe(200);
  });

  it('is zero when everything fits', () => {
    expect(centredScrollLeft({ clientWidth: 300, scrollWidth: 300 }, { offsetLeft: 220, offsetWidth: 80 })).toBe(0);
  });
});

describe('stripOverflow', () => {
  it('reads a strip at its start as more at the end only', () => {
    expect(stripOverflow({ scrollLeft: 0, clientWidth: 100, scrollWidth: 300 })).toEqual({ start: false, end: true });
  });

  it('reads a strip in the middle as more on both sides', () => {
    expect(stripOverflow({ scrollLeft: 100, clientWidth: 100, scrollWidth: 300 })).toEqual({ start: true, end: true });
  });

  it('reads a strip at its end as more at the start only', () => {
    expect(stripOverflow({ scrollLeft: 200, clientWidth: 100, scrollWidth: 300 })).toEqual({ start: true, end: false });
  });

  it('absorbs one pixel of sub-pixel slack at either edge', () => {
    expect(stripOverflow({ scrollLeft: 1, clientWidth: 100, scrollWidth: 300 }).start).toBe(false);
    expect(stripOverflow({ scrollLeft: 199, clientWidth: 100, scrollWidth: 300 }).end).toBe(false);
    expect(stripOverflow({ scrollLeft: 1.5, clientWidth: 100, scrollWidth: 300 }).start).toBe(true);
  });
});

describe('UnderlineTabs', () => {
  it('is a named navigation of tabs, the current one marked as the page, with icons where given', async () => {
    const selected: TabId[] = [];
    mounted = await mount(strip('two', id => selected.push(id)));
    const landmark = nav(mounted.container);
    expect(landmark.getAttribute('aria-label')).toBe('Studio views');
    expect(landmark.className).toBe('kt-utabs extra');
    expect(landmark.hasAttribute('data-underline-tabs')).toBe(true);
    expect(landmark.querySelector('[role="tablist"]')).toBeNull();

    const tabs = [...mounted.container.querySelectorAll('[data-test-tab]')];
    expect(tabs.map(tab => tab.getAttribute('data-test-tab'))).toEqual(['one', 'two', 'three']);
    expect(tabs.map(tab => tab.textContent)).toEqual(['One', 'Two', 'Three']);
    expect(tabs.map(tab => tab.getAttribute('aria-current'))).toEqual([null, 'page', null]);
    expect(button(mounted.container, 'one').querySelector('[data-icon="one"]')).not.toBeNull();
    expect(button(mounted.container, 'two').querySelector('svg')).toBeNull();

    await interact(() => button(mounted?.container as HTMLElement, 'three').click());
    expect(selected).toEqual(['three']);
  });

  it('centres the current tab instantly on arrival, then smoothly when it changes', async () => {
    mounted = await mount(strip('two'));
    expect(scrolls).toEqual([{ left: 90, behavior: 'auto' }]);
    expect(nav(mounted.container).getAttribute('data-more-start')).toBe('true');
    expect(nav(mounted.container).getAttribute('data-more-end')).toBe('true');

    await mounted.render(strip('three'));
    expect(scrolls[1]).toEqual({ left: 200, behavior: 'smooth' });
    expect(nav(mounted.container).getAttribute('data-more-start')).toBe('true');
    expect(nav(mounted.container).getAttribute('data-more-end')).toBe('false');

    await mounted.render(strip('one'));
    expect(scrolls[2]).toEqual({ left: 0, behavior: 'smooth' });
    expect(nav(mounted.container).getAttribute('data-more-start')).toBe('false');
    expect(nav(mounted.container).getAttribute('data-more-end')).toBe('true');
  });

  it('never animates the scroll for a reader who asked for reduced motion', async () => {
    const queries: string[] = [];
    window.matchMedia = ((query: string) => {
      queries.push(query);
      return { matches: true } as MediaQueryList;
    }) as typeof window.matchMedia;
    mounted = await mount(strip('one'));
    await mounted.render(strip('three'));
    expect(scrolls.map(scroll => scroll.behavior)).toEqual(['auto', 'auto']);
    expect(queries).toContain('(prefers-reduced-motion: reduce)');
  });

  it('animates when the browser has no matchMedia at all', async () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    mounted = await mount(strip('one'));
    await mounted.render(strip('two'));
    expect(scrolls.map(scroll => scroll.behavior)).toEqual(['auto', 'smooth']);
  });

  it('sets scrollLeft itself on a browser without element scrollTo', async () => {
    HTMLElement.prototype.scrollTo = undefined as unknown as typeof HTMLElement.prototype.scrollTo;
    mounted = await mount(strip('three'));
    expect(scrolls).toEqual([]);
    expect(list(mounted.container).scrollLeft).toBe(200);
  });

  it('re-reads which edges have more tabs when the strip is scrolled by hand', async () => {
    mounted = await mount(strip('one'));
    const element = list(mounted.container);
    expect(nav(mounted.container).getAttribute('data-more-start')).toBe('false');
    define(element, { scrollLeft: 200 });
    await interact(() => element.dispatchEvent(new Event('scroll')));
    expect(nav(mounted.container).getAttribute('data-more-start')).toBe('true');
    expect(nav(mounted.container).getAttribute('data-more-end')).toBe('false');
    // The same answer again keeps the previous state rather than re-rendering.
    await interact(() => element.dispatchEvent(new Event('scroll')));
    expect(nav(mounted.container).getAttribute('data-more-end')).toBe('false');
  });

  it('puts a chevron on each edge that has more tabs, and pages the strip when it is pressed', async () => {
    mounted = await mount(strip('two'));
    const container = mounted.container;
    const end = must(container.querySelector<HTMLButtonElement>('[data-utabs-more="end"]'), 'the end chevron');
    const start = must(container.querySelector<HTMLButtonElement>('[data-utabs-more="start"]'), 'the start chevron');
    expect(end.getAttribute('aria-label')).toBe('Show more Studio views');
    expect(start.getAttribute('aria-label')).toBe('Show earlier Studio views');
    expect(end.tabIndex).toBe(-1);

    await interact(() => end.click());
    expect(scrolls.at(-1)).toEqual({ left: 160, behavior: 'smooth' });
    await interact(() => start.click());
    expect(scrolls.at(-1)).toEqual({ left: 90, behavior: 'smooth' });
  });

  it('pages without animation for a reader who asked for reduced motion, and without element scrollTo', async () => {
    window.matchMedia = (() => ({ matches: true }) as MediaQueryList) as typeof window.matchMedia;
    mounted = await mount(strip('two'));
    const end = must(mounted.container.querySelector<HTMLButtonElement>('[data-utabs-more="end"]'), 'the end chevron');
    await interact(() => end.click());
    expect(scrolls.at(-1)).toEqual({ left: 160, behavior: 'auto' });

    HTMLElement.prototype.scrollTo = undefined as unknown as typeof HTMLElement.prototype.scrollTo;
    await interact(() => end.click());
    expect(list(mounted.container).scrollLeft).toBe(230);
  });

  it('shows no chevron when every tab fits', async () => {
    geometry.strip = { clientWidth: 300, scrollWidth: 300 };
    mounted = await mount(strip('three'));
    expect(mounted.container.querySelector('[data-utabs-more]')).toBeNull();
  });

  it('shows no fade at all when every tab fits', async () => {
    geometry.strip = { clientWidth: 300, scrollWidth: 300 };
    mounted = await mount(strip('three'));
    expect(nav(mounted.container).getAttribute('data-more-start')).toBe('false');
    expect(nav(mounted.container).getAttribute('data-more-end')).toBe('false');
  });

  it('re-measures when the strip is resized, and stops observing once unmounted', async () => {
    const observed: Element[] = [];
    const disconnect = mock(() => {});
    let callback: (() => void) | undefined;
    globalThis.ResizeObserver = class {
      constructor(next: () => void) {
        callback = next;
      }
      observe(target: Element) {
        observed.push(target);
      }
      disconnect = disconnect;
      unobserve() {}
    } as unknown as typeof ResizeObserver;

    mounted = await mount(strip('one'));
    const element = list(mounted.container);
    expect(observed).toEqual([element]);
    geometry.strip = { clientWidth: 300, scrollWidth: 300 };
    await interact(() => must(callback, 'the resize callback')());
    expect(nav(mounted.container).getAttribute('data-more-end')).toBe('false');

    await mounted.unmount();
    mounted = undefined;
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('works without ResizeObserver', async () => {
    globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
    mounted = await mount(strip('two'));
    expect(nav(mounted.container).getAttribute('data-more-end')).toBe('true');
  });

  it('forgets a tab that is removed, and does not scroll for a current tab that is not in the strip', async () => {
    mounted = await mount(strip('one'));
    expect(scrolls).toHaveLength(1);
    await mounted.render(strip('three', () => {}, TABS.slice(0, 2)));
    expect(mounted.container.querySelector('[data-test-tab="three"]')).toBeNull();
    expect(scrolls).toHaveLength(1);
  });
});
