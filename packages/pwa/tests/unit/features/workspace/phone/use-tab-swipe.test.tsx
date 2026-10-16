import { afterEach, describe, expect, it } from 'bun:test';
import { useRef } from 'react';
import {
  TAB_SWIPE_IGNORE_ATTR,
  tabSwipeBlocked,
  useTabSwipe,
} from '../../../../../src/features/workspace/phone/use-tab-swipe.ts';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';

const touch = (type: string, x: number, y: number, at: number, count = 1): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: Array.from({ length: count }, () => ({ clientX: x, clientY: y })),
  });
  Object.defineProperty(event, 'timeStamp', { value: at });
  return event;
};

const Probe = ({ enabled, onSwipe }: { enabled: boolean; onSwipe: (direction: string) => void }) => {
  const root = useRef<HTMLDivElement>(null);
  useTabSwipe(root, { enabled, onSwipe });
  return (
    <div ref={root} data-root="">
      <p data-plain="">text</p>
      <div {...{ [TAB_SWIPE_IGNORE_ATTR]: '' }}>
        <span data-ignored="">owned</span>
      </div>
      <div data-touch-none="" style={{ touchAction: 'none' }} />
      <div data-wide="" style={{ overflowX: 'auto' }} />
    </div>
  );
};

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.getSelection()?.removeAllRanges();
});

const drag = async (target: Element, dx: number, dy = 0, duration = 400): Promise<void> => {
  await interact(() => target.dispatchEvent(touch('touchstart', 200, 300, 0)));
  await interact(() => target.dispatchEvent(touch('touchmove', 200 + dx / 4, 300 + dy / 4, duration / 4)));
  await interact(() => target.dispatchEvent(touch('touchmove', 200 + dx, 300 + dy, duration)));
  await interact(() => target.dispatchEvent(touch('touchend', 0, 0, duration)));
};

describe('useTabSwipe', () => {
  it('reports a left swipe as next and a right swipe as previous', async () => {
    const seen: string[] = [];
    mounted = await mount(<Probe enabled onSwipe={direction => seen.push(direction)} />);
    const plain = must(mounted.container.querySelector('[data-plain]'), 'plain');
    await drag(plain, -120);
    await drag(plain, 120);
    expect(seen).toEqual(['next', 'previous']);
  });

  it('ignores vertical scrolls and small moves', async () => {
    const seen: string[] = [];
    mounted = await mount(<Probe enabled onSwipe={direction => seen.push(direction)} />);
    const plain = must(mounted.container.querySelector('[data-plain]'), 'plain');
    await drag(plain, 20, 200);
    await drag(plain, -30, 0, 2000);
    expect(seen).toEqual([]);
  });

  it('drops a gesture when a second finger joins or the touch is cancelled', async () => {
    const seen: string[] = [];
    mounted = await mount(<Probe enabled onSwipe={direction => seen.push(direction)} />);
    const plain = must(mounted.container.querySelector('[data-plain]'), 'plain');
    await interact(() => plain.dispatchEvent(touch('touchstart', 200, 300, 0)));
    await interact(() => plain.dispatchEvent(touch('touchmove', 100, 300, 100, 2)));
    await interact(() => plain.dispatchEvent(touch('touchmove', 50, 300, 200)));
    await interact(() => plain.dispatchEvent(touch('touchend', 0, 0, 200)));
    await interact(() => plain.dispatchEvent(touch('touchstart', 200, 300, 0)));
    await interact(() => plain.dispatchEvent(touch('touchmove', 100, 300, 100)));
    await interact(() => plain.dispatchEvent(touch('touchcancel', 0, 0, 100)));
    await interact(() => plain.dispatchEvent(touch('touchend', 0, 0, 100)));
    expect(seen).toEqual([]);
  });

  it('never starts on a two-finger touch', async () => {
    const seen: string[] = [];
    mounted = await mount(<Probe enabled onSwipe={direction => seen.push(direction)} />);
    const plain = must(mounted.container.querySelector('[data-plain]'), 'plain');
    await interact(() => plain.dispatchEvent(touch('touchstart', 200, 300, 0, 2)));
    await interact(() => plain.dispatchEvent(touch('touchmove', 50, 300, 100)));
    await interact(() => plain.dispatchEvent(touch('touchend', 0, 0, 100)));
    expect(seen).toEqual([]);
  });

  it('declines gestures that start inside a surface that owns them', async () => {
    const seen: string[] = [];
    mounted = await mount(<Probe enabled onSwipe={direction => seen.push(direction)} />);
    await drag(must(mounted.container.querySelector('[data-ignored]'), 'ignored'), -120);
    expect(seen).toEqual([]);
  });

  it('does nothing while disabled, and detaches on unmount', async () => {
    const seen: string[] = [];
    mounted = await mount(<Probe enabled={false} onSwipe={direction => seen.push(direction)} />);
    const plain = must(mounted.container.querySelector('[data-plain]'), 'plain');
    await drag(plain, -120);
    await mounted.render(<Probe enabled onSwipe={direction => seen.push(direction)} />);
    await mounted.render(<Probe enabled={false} onSwipe={direction => seen.push(direction)} />);
    await drag(plain, -120);
    expect(seen).toEqual([]);
  });
});

describe('tabSwipeBlocked', () => {
  const tree = async () => {
    mounted = await mount(<Probe enabled={false} onSwipe={() => {}} />);
    const root = must(mounted.container.querySelector<HTMLElement>('[data-root]'), 'root');
    return { root, pick: (selector: string) => must(root.querySelector<HTMLElement>(selector), selector) };
  };

  it('allows a plain node, including a text node, and the root itself', async () => {
    const { root, pick } = await tree();
    expect(tabSwipeBlocked(pick('[data-plain]'), root)).toBe(false);
    expect(tabSwipeBlocked(must(pick('[data-plain]').firstChild, 'text'), root)).toBe(false);
    expect(tabSwipeBlocked(root, root)).toBe(false);
  });

  it('blocks nothing-targets and nodes outside the root', async () => {
    const { root } = await tree();
    expect(tabSwipeBlocked(null, root)).toBe(true);
    expect(tabSwipeBlocked(document.body, root)).toBe(true);
  });

  it('blocks an opt-out and a touch-action none surface', async () => {
    const { root, pick } = await tree();
    expect(tabSwipeBlocked(pick('[data-ignored]'), root)).toBe(true);
    expect(tabSwipeBlocked(pick('[data-touch-none]'), root)).toBe(true);
  });

  it('blocks a block that scrolls sideways, but not one that merely could', async () => {
    const { root, pick } = await tree();
    const wide = pick('[data-wide]');
    expect(tabSwipeBlocked(wide, root)).toBe(false);
    Object.defineProperty(wide, 'scrollWidth', { configurable: true, value: 800 });
    Object.defineProperty(wide, 'clientWidth', { configurable: true, value: 300 });
    expect(tabSwipeBlocked(wide, root)).toBe(true);
  });

  it('blocks while the reader holds a text selection', async () => {
    const { root, pick } = await tree();
    const plain = pick('[data-plain]');
    const range = document.createRange();
    range.selectNodeContents(plain);
    document.getSelection()?.addRange(range);
    expect(tabSwipeBlocked(plain, root)).toBe(true);
  });
});
