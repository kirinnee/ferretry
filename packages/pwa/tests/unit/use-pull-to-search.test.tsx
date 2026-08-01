import { describe, expect, it } from 'bun:test';
import { useRef } from 'react';
import {
  PULL_THRESHOLD_PX,
  pullProgress,
  pullTriggered,
  usePullToSearch,
  type PullToSearch,
} from '../../src/hooks/use-pull-to-search.ts';
import { interact, mount, must } from '../support/dom.ts';

const touch = (type: string, y: number, count = 1): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, () => ({ clientY: y })) });
  return event;
};

const Probe = ({ enabled, onTrigger, states }: { enabled: boolean; onTrigger: () => void; states: PullToSearch[] }) => {
  const ref = useRef<HTMLDivElement>(null);
  const state = usePullToSearch(ref, { enabled, onTrigger });
  states.push(state);
  return <div data-armed={String(state.armed)} data-distance={state.distance} ref={ref} />;
};

describe('pull progress policy', () => {
  it('ramps, clamps, and refuses invalid thresholds', () => {
    expect(pullProgress(-1)).toBe(0);
    expect(pullProgress(PULL_THRESHOLD_PX / 2)).toBe(0.5);
    expect(pullProgress(PULL_THRESHOLD_PX * 2)).toBe(1);
    expect(pullProgress(10, 0)).toBe(0);
    expect(pullTriggered(PULL_THRESHOLD_PX - 1)).toBe(false);
    expect(pullTriggered(PULL_THRESHOLD_PX)).toBe(true);
  });
});

describe('usePullToSearch', () => {
  it('fires only for a one-finger downward pull beginning at the top', async () => {
    const states: PullToSearch[] = [];
    let fired = 0;
    const view = await mount(<Probe enabled onTrigger={() => fired++} states={states} />);
    const scroller = must(view.container.firstElementChild, 'pull scroller');

    await interact(() => scroller.dispatchEvent(touch('touchstart', 100)));
    await interact(() => scroller.dispatchEvent(touch('touchmove', 100 + PULL_THRESHOLD_PX)));
    expect(states.at(-1)).toMatchObject({ distance: PULL_THRESHOLD_PX, progress: 1, armed: true });
    await interact(() => scroller.dispatchEvent(touch('touchend', 0, 0)));

    expect(fired).toBe(1);
    expect(states.at(-1)).toMatchObject({ distance: 0, progress: 0, armed: false });
    await view.unmount();
  });

  it('does not fire for multitouch, upward travel, an ordinary scroll, or cancellation', async () => {
    const states: PullToSearch[] = [];
    let fired = 0;
    const view = await mount(<Probe enabled onTrigger={() => fired++} states={states} />);
    const scroller = must(view.container.firstElementChild, 'pull scroller');

    await interact(() => scroller.dispatchEvent(touch('touchstart', 100, 2)));
    await interact(() => scroller.dispatchEvent(touch('touchend', 0, 0)));
    await interact(() => scroller.dispatchEvent(touch('touchstart', 100)));
    await interact(() => scroller.dispatchEvent(touch('touchmove', 20)));
    await interact(() => scroller.dispatchEvent(touch('touchend', 0, 0)));
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 1 });
    await interact(() => scroller.dispatchEvent(touch('touchstart', 100)));
    await interact(() => scroller.dispatchEvent(touch('touchmove', 200)));
    await interact(() => scroller.dispatchEvent(touch('touchcancel', 0, 0)));

    expect(fired).toBe(0);
    expect(states.at(-1)?.distance).toBe(0);
    await view.unmount();
  });
});
