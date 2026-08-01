import { describe, expect, it } from 'bun:test';
import { useRef } from 'react';
import {
  NO_PULL,
  PALETTE_PULL_THRESHOLD_PX,
  PULL_TO_PALETTE_ATTR,
  advancePull,
  beginPull,
  endPull,
  palettePullProgress,
  usePullToPalette,
  type PullToPalette,
} from '../../src/hooks/use-pull-to-palette.ts';
import { interact, mount, must } from '../support/dom.ts';

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
    expect(advancePull(begun, { touches: 1, scrollTop: 0, clientY: 50 }).distance).toBe(0);
    expect(advancePull(begun, { touches: 2, scrollTop: 0, clientY: 200 })).toEqual(NO_PULL);
    expect(advancePull(begun, { touches: 1, scrollTop: 1, clientY: 200 })).toEqual(NO_PULL);
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

describe('usePullToPalette', () => {
  it('delegates only from opted-in top scrollers and resets after release', async () => {
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
