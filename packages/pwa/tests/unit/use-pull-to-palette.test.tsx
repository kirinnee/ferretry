import { describe, expect, it } from 'bun:test';
import { useRef } from 'react';
import {
  NO_PULL,
  PALETTE_PULL_THRESHOLD_PX,
  PULL_TO_PALETTE_ATTR,
  PULL_TO_PALETTE_IGNORE_ATTR,
  advancePull,
  beginPull,
  endPull,
  palettePullProgress,
  pullScrollerOf,
  usePullToPalette,
  type PullToPalette,
} from '../../src/hooks/use-pull-to-palette.ts';
import { interact, mount, must } from '../support/dom.ts';

/** A real element whose box genuinely scrolls, so detection is not stubbed out. */
const scrollingDiv = (): HTMLDivElement => {
  const element = document.createElement('div');
  element.style.overflowY = 'auto';
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 400 });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 100 });
  return element;
};

/** Content taller than its box, but nothing the reader can scroll. */
const overflowingDiv = (): HTMLDivElement => {
  const element = document.createElement('div');
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 400 });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 100 });
  return element;
};

const touch = (type: string, y: number, count = 1): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, () => ({ clientY: y })) });
  return event;
};

const Probe = ({ enabled, onOpen, states }: { enabled: boolean; onOpen: () => void; states: PullToPalette[] }) => {
  const root = useRef<HTMLDivElement>(null);
  const state = usePullToPalette(root, { enabled, onOpen });
  states.push(state);
  return (
    <div ref={root}>
      <div {...{ [PULL_TO_PALETTE_ATTR]: '' }} data-distance={state.distance} />
      <div data-plain />
    </div>
  );
};

describe('palette pull policy', () => {
  it('only retains a one-finger top-of-scroller downward gesture', () => {
    const begun = beginPull({ touches: 1, scrollTop: 0, clientY: 100 });
    expect(begun).toEqual({ armed: true, startY: 100, distance: 0 });
    expect(beginPull({ touches: 2, scrollTop: 0, clientY: 100 })).toEqual(NO_PULL);
    expect(beginPull({ touches: 1, scrollTop: 1, clientY: 100 })).toEqual(NO_PULL);
    // Safari reports negative scrollTop while rubber-banding at the top. It is
    // still the top edge and must not disarm the pull midway through.
    expect(beginPull({ touches: 1, scrollTop: -1, clientY: 100 })).toEqual(begun);
    expect(advancePull(begun, { touches: 1, scrollTop: 0, clientY: 50 }).distance).toBe(0);
    expect(advancePull(begun, { touches: 2, scrollTop: 0, clientY: 200 })).toEqual(NO_PULL);
    expect(advancePull(begun, { touches: 1, scrollTop: 1, clientY: 200 })).toEqual(NO_PULL);
    expect(advancePull(begun, { touches: 1, scrollTop: -1, clientY: 200 })).toEqual({
      armed: true,
      startY: 100,
      distance: 100,
    });
    expect(advancePull(NO_PULL, { touches: 1, scrollTop: 0, clientY: 200 })).toEqual(NO_PULL);
  });

  it('uses a longer, bounded threshold before opening', () => {
    expect(endPull({ armed: true, startY: 0, distance: PALETTE_PULL_THRESHOLD_PX - 1 })).toBe(false);
    expect(endPull({ armed: true, startY: 0, distance: PALETTE_PULL_THRESHOLD_PX })).toBe(true);
    expect(endPull(NO_PULL)).toBe(false);
    expect(endPull({ armed: true, startY: 0, distance: 10 }, 5)).toBe(true);
    expect(palettePullProgress(-1)).toBe(0);
    expect(palettePullProgress(PALETTE_PULL_THRESHOLD_PX / 2)).toBe(0.5);
    expect(palettePullProgress(PALETTE_PULL_THRESHOLD_PX * 2)).toBe(1);
    expect(palettePullProgress(10, 0)).toBe(0);
  });
});

describe('pullScrollerOf', () => {
  const rooted = (...chain: readonly HTMLElement[]): { root: HTMLElement; leaf: HTMLElement } => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let parent: HTMLElement = root;
    for (const link of chain) {
      parent.appendChild(link);
      parent = link;
    }
    return { root, leaf: parent };
  };

  it('takes the nearest element that actually scrolls', () => {
    const outer = scrollingDiv();
    const inner = scrollingDiv();
    const leafNode = document.createElement('span');
    const { root } = rooted(outer, inner, leafNode);

    expect(pullScrollerOf(leafNode, root)).toBe(inner);
    root.remove();
  });

  it('walks past content that merely overflows its box', () => {
    const scroller = scrollingDiv();
    const overflowing = overflowingDiv();
    const { leaf, root } = rooted(scroller, overflowing);

    expect(pullScrollerOf(leaf, root)).toBe(scroller);
    root.remove();
  });

  it('prefers an explicit marker over what it would have detected', () => {
    const scroller = scrollingDiv();
    const marked = document.createElement('div');
    marked.setAttribute(PULL_TO_PALETTE_ATTR, '');
    const { leaf, root } = rooted(scroller, marked);

    expect(pullScrollerOf(leaf, root)).toBe(marked);
    root.remove();
  });

  it('refuses a surface that has declined the gesture, outer scroller or not', () => {
    const scroller = scrollingDiv();
    const declined = scrollingDiv();
    declined.setAttribute(PULL_TO_PALETTE_IGNORE_ATTR, '');
    const { leaf, root } = rooted(scroller, declined);

    // Not "look further out": the finger is inside the surface that already owns
    // this movement, and an outer scroller must not answer for it.
    expect(pullScrollerOf(leaf, root)).toBeNull();
    root.remove();
  });

  it('refuses when the declining surface is between the touch and the scroller', () => {
    const scroller = scrollingDiv();
    const declined = document.createElement('div');
    declined.setAttribute(PULL_TO_PALETTE_IGNORE_ATTR, '');
    const leafNode = document.createElement('span');
    const { root } = rooted(scroller, declined, leafNode);

    expect(pullScrollerOf(leafNode, root)).toBeNull();
    root.remove();
  });

  it('refuses a custom drag owner instead of falling back to the page root', () => {
    const dragSurface = document.createElement('div');
    dragSurface.style.touchAction = 'none';
    const leafNode = document.createElement('span');
    const { root } = rooted(dragSurface, leafNode);

    // Bottom-sheet handles, task-graph canvases, and the remote browser all use
    // this policy because their pointer stream already gives a drag meaning.
    expect(pullScrollerOf(leafNode, root)).toBeNull();
    root.remove();
  });

  it('stands the root in for a page with nothing to scroll', () => {
    // The safe fallback, and the reason a new destination needs no wiring: a page
    // that cannot be scrolled cannot be ambiguous about a downward pull.
    const { leaf, root } = rooted(document.createElement('div'));

    expect(pullScrollerOf(leaf, root)).toBe(root);
    root.remove();
  });

  it('answers nothing for a touch that is not inside this root', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    expect(pullScrollerOf(outside, root)).toBeNull();
    expect(pullScrollerOf(null, root)).toBeNull();
    expect(pullScrollerOf(new EventTarget(), root)).toBeNull();
    root.remove();
    outside.remove();
  });
});

describe('usePullToPalette', () => {
  it('delegates from the scroller a touch began in and resets after release', async () => {
    let opened = 0;
    const states: PullToPalette[] = [];
    const view = await mount(<Probe enabled onOpen={() => opened++} states={states} />);
    const root = must(view.container.firstElementChild, 'root');
    const scroller = must(root.firstElementChild, 'opted-in scroller');
    let scrollTop = 0;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => scrollTop });

    await interact(() => scroller.dispatchEvent(touch('touchstart', 100)));
    await interact(() => scroller.dispatchEvent(touch('touchmove', 100 + PALETTE_PULL_THRESHOLD_PX)));
    expect(states.at(-1)).toMatchObject({ distance: PALETTE_PULL_THRESHOLD_PX, progress: 1, armed: true });
    await interact(() => scroller.dispatchEvent(touch('touchend', 0, 0)));
    expect(opened).toBe(1);
    expect(states.at(-1)?.distance).toBe(0);

    await interact(() => root.lastElementChild?.dispatchEvent(touch('touchstart', 100)));
    await interact(() => scroller.dispatchEvent(touch('touchstart', 100)));
    await interact(() => scroller.dispatchEvent(touch('touchmove', 0, 0)));
    scrollTop = 1;
    await interact(() => scroller.dispatchEvent(touch('touchstart', 100)));
    await interact(() => scroller.dispatchEvent(touch('touchend', 0, 0)));
    expect(opened).toBe(1);
    await view.unmount();
  });

  it('clears state while disabled', async () => {
    const states: PullToPalette[] = [];
    const view = await mount(<Probe enabled={false} onOpen={() => {}} states={states} />);
    expect(states.at(-1)).toMatchObject({ distance: 0, progress: 0, armed: false });
    await view.unmount();
  });
});
