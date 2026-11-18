import { afterEach, describe, expect, test } from 'bun:test';
import { useState } from 'react';
import { Loading, LoadingBarHost, useBackgroundLoad, useHeldLoading } from '../../../src/ui/loading.tsx';
import { interact, type Mounted, mount } from '../../support/dom.ts';

/**
 * THE LOADER NEVER FLASHES OR BLINKS: a wait shorter than the delay mounts nothing that is ever seen; a wait that outlasts
 * it stays at least the minimum; a wait that restarts while held is the same loader. Times are shrunk (20 / 60 ms) so the
 * suite is quick; the shipped constants (180 / 300 ms) only change the numbers.
 */
const GATE = { delay: 20, min: 60, fade: 0 };
const pause = (ms: number): Promise<void> => interact(() => new Promise(resolve => setTimeout(resolve, ms)));

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

let setActive: (value: boolean) => void = () => {};
const history: boolean[] = [];
function Probe() {
  const [active, set] = useState(false);
  setActive = set;
  const held = useHeldLoading(active, GATE);
  history.push(held);
  return <p data-held={String(held)} />;
}
const held = (): string | null => view?.container.querySelector('[data-held]')?.getAttribute('data-held') ?? null;

describe('useHeldLoading', () => {
  test('a wait that ends inside the delay is never held on', async () => {
    history.length = 0;
    view = await mount(<Probe />);
    await interact(() => setActive(true));
    await pause(5);
    await interact(() => setActive(false));
    await pause(10);
    expect(held()).toBe('false');
    // It was mounted for the instant of the wait, and the stylesheet keeps a fresh loader invisible for the delay.
    expect(history.filter(Boolean).length).toBeGreaterThan(0);
  });

  test('a wait that outlasts the delay stays up for the minimum, then lets go', async () => {
    view = await mount(<Probe />);
    await interact(() => setActive(true));
    await pause(30);
    await interact(() => setActive(false));
    expect(held()).toBe('true');
    await pause(20);
    expect(held()).toBe('true');
    await pause(80);
    expect(held()).toBe('false');
  });

  test('a wait that starts again while held is the same hold, not a blink', async () => {
    view = await mount(<Probe />);
    await interact(() => setActive(true));
    await pause(30);
    await interact(() => setActive(false));
    await pause(10);
    await interact(() => setActive(true));
    await pause(100);
    expect(held()).toBe('true');
    await interact(() => setActive(false));
    await pause(120);
    expect(held()).toBe('false');
  });
});

describe('the one bar', () => {
  test('ten busy views are one bar', async () => {
    const all: ((value: boolean) => void)[] = [];
    function Many() {
      return (
        <>
          {Array.from({ length: 10 }, (_, id) => `busy-${id}`).map(key => (
            <Setter key={key} register={fn => all.push(fn)} />
          ))}
          <LoadingBarHost />
        </>
      );
    }
    function Setter({ register }: { readonly register: (fn: (value: boolean) => void) => void }) {
      const [on, set] = useState(false);
      register(set);
      useBackgroundLoad(on);
      return null;
    }
    view = await mount(<Many />);
    expect(view.container.querySelectorAll('[data-loading="bar"]').length).toBe(0);
    await interact(() => {
      for (const fn of all.slice(-10)) fn(true);
    });
    expect(view.container.querySelectorAll('[data-loading="bar"]').length).toBe(1);
    await interact(() => {
      for (const fn of all.slice(-10)) fn(false);
    });
  });
});

describe('Loading kind="bar"', () => {
  test('draws no loader of its own: words for a screen reader, and the one bar for everyone', async () => {
    view = await mount(
      <>
        <Loading kind="bar" label="Reading the terminals…" />
        <Loading kind="bar" label="Reading the grants…" />
        <LoadingBarHost />
      </>,
    );
    expect(view.container.querySelectorAll('[data-loading="bar"]').length).toBe(1);
    expect(view.container.querySelectorAll('[data-loading="background"]').length).toBe(2);
    expect(view.container.querySelectorAll('[data-loading="page"]').length).toBe(0);
  });
});

describe('Loading', () => {
  test('the page loader is a polite status with its label', async () => {
    view = await mount(<Loading kind="page" label="Opening your machine…" />);
    const page = view.container.querySelector('[data-loading="page"]');
    expect(page?.getAttribute('role')).toBe('status');
    expect(page?.textContent).toContain('Opening your machine…');
  });
});
