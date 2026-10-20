import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type RefObject, useRef } from 'react';
import {
  SCROLL_MEMORY_IGNORED,
  SCROLL_RESTORE_PATIENCE_MS,
  useRouteScrollMemory,
} from '../../src/hooks/use-route-scroll-memory.ts';
import { ScrollMemory, type ScrollMemoryStorage } from '../../src/lib/scroll-memory.ts';
import { PageScrollRegion } from '../../src/shell/page-scroll-region.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { settleUntil } from '../support/settle.ts';

const storageOf = (): ScrollMemoryStorage => {
  const items = new Map<string, string>();
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: key => void items.delete(key),
  };
};

/** The box a scroller reports: happy-dom lays nothing out, so a test states it and may change it later. */
interface Box {
  scrollHeight: number;
  clientHeight: number;
}

/** Defines live metrics on an element, read from `box` each time. */
const measure = (element: HTMLElement | null, box: Box): void => {
  if (element === null) return;
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => box.scrollHeight });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => box.clientHeight });
};

/**
 * Frames and the patience timer, driven by hand. Only the patience delay is captured; every other
 * timer (React's, the DOM's) keeps its real behaviour.
 */
interface Seams {
  frames: Map<number, FrameRequestCallback>;
  cancelled: number[];
  patience: Array<() => void>;
  runFrames: () => void;
  restore: () => void;
}

const original = {
  raf: globalThis.requestAnimationFrame,
  caf: globalThis.cancelAnimationFrame,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};

const installSeams = (): Seams => {
  let nextFrame = 1;
  let nextTimer = 1_000_000;
  const timers = new Map<number, () => void>();
  const seams: Seams = {
    frames: new Map(),
    cancelled: [],
    patience: [],
    runFrames: () => {
      const due = [...seams.frames.values()];
      seams.frames.clear();
      for (const callback of due) callback(0);
    },
    restore: () => {
      globalThis.requestAnimationFrame = original.raf;
      globalThis.cancelAnimationFrame = original.caf;
      globalThis.setTimeout = original.setTimeout;
      globalThis.clearTimeout = original.clearTimeout;
    },
  };
  globalThis.requestAnimationFrame = callback => {
    const id = nextFrame++;
    seams.frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => {
    seams.cancelled.push(id);
    seams.frames.delete(id);
  };
  globalThis.setTimeout = ((callback: () => void, delay?: number, ...rest: unknown[]) => {
    if (delay !== SCROLL_RESTORE_PATIENCE_MS) return original.setTimeout(callback, delay, ...rest);
    const id = nextTimer++;
    timers.set(id, callback);
    seams.patience.push(() => {
      if (!timers.has(id)) return;
      timers.delete(id);
      callback();
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    if (id !== undefined && timers.delete(id)) return;
    original.clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  return seams;
};

const scrollEvent = (): Event => new Event('scroll');

interface PageProps {
  readonly entryKey: string;
  readonly memory: ScrollMemory;
  readonly box?: Box;
  readonly className?: string;
  readonly off?: boolean;
  readonly extra?: number;
}

/** A page: one scroller (path "0") with `extra` rows inside it. */
function Page({
  entryKey,
  memory,
  box = { scrollHeight: 1000, clientHeight: 400 },
  className,
  off,
  extra = 0,
}: PageProps) {
  return (
    <PageScrollRegion entryKey={entryKey} memory={memory}>
      <div
        className={className}
        data-scroll-memory={off === true ? 'off' : undefined}
        data-testid="scroller"
        ref={element => measure(element, box)}
      >
        {Array.from({ length: extra + 1 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-order fixture
          <p key={index}>row</p>
        ))}
      </div>
    </PageScrollRegion>
  );
}

const scrollerOf = (view: Mounted): HTMLElement =>
  must(view.container.querySelector<HTMLElement>('[data-testid="scroller"]'), 'the scroller');

let view: Mounted | null = null;
let seams: Seams;
beforeEach(() => {
  seams = installSeams();
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  seams.restore();
});

describe('SCROLL_MEMORY_IGNORED', () => {
  it('names the transcript and the opt-out', () => {
    // Arrange / Act / Assert
    expect(SCROLL_MEMORY_IGNORED).toContain('.fy-transcript');
    expect(SCROLL_MEMORY_IGNORED).toContain('[data-scroll-memory="off"]');
  });
});

describe('PageScrollRegion', () => {
  it('renders its children in a layout-less region', async () => {
    // Arrange
    const memory = new ScrollMemory(storageOf());
    // Act
    view = await mount(<Page entryKey="e1" memory={memory} />);
    // Assert
    const region = must(view.container.querySelector('[data-page-scroll-region]'), 'the region');
    expect(region.className).toBe('contents');
    expect(region.querySelector('[data-testid="scroller"]')).not.toBeNull();
  });
});

describe('remembering', () => {
  it('writes the scroller offset under the entry on the next frame, not before', async () => {
    // Arrange
    const memory = new ScrollMemory(storageOf());
    view = await mount(<Page entryKey="e1" memory={memory} />);
    const scroller = scrollerOf(view);
    scroller.scrollTop = 120;
    // Act
    scroller.dispatchEvent(scrollEvent());
    const before = memory.page('e1');
    seams.runFrames();
    // Assert
    expect(before).toBeNull();
    expect(memory.page('e1')).toEqual({ '0': 120 });
  });

  it('coalesces a fling into one frame request and the last offset', async () => {
    // Arrange
    const memory = new ScrollMemory(storageOf());
    view = await mount(<Page entryKey="e1" memory={memory} />);
    const scroller = scrollerOf(view);
    // Act
    for (const top of [10, 50, 90]) {
      scroller.scrollTop = top;
      scroller.dispatchEvent(scrollEvent());
    }
    const requested = seams.frames.size;
    seams.runFrames();
    // Assert
    expect(requested).toBe(1);
    expect(memory.page('e1')).toEqual({ '0': 90 });
  });

  it('files later scrolls under the entry that is on screen then', async () => {
    // Arrange
    const memory = new ScrollMemory(storageOf());
    view = await mount(<Page entryKey="e1" memory={memory} />);
    await view.render(<Page entryKey="e2" memory={memory} />);
    const scroller = scrollerOf(view);
    scroller.scrollTop = 33;
    // Act
    scroller.dispatchEvent(scrollEvent());
    seams.runFrames();
    // Assert
    expect(memory.page('e2')).toEqual({ '0': 33 });
    expect(memory.page('e1')).toBeNull();
  });

  it.each([
    { name: 'a transcript', props: { className: 'fy-transcript' } },
    { name: 'an opted-out scroller', props: { off: true } },
  ])('ignores $name', async ({ props }) => {
    // Arrange
    const memory = new ScrollMemory(storageOf());
    view = await mount(<Page entryKey="e1" memory={memory} {...props} />);
    const scroller = scrollerOf(view);
    scroller.scrollTop = 77;
    // Act
    scroller.dispatchEvent(scrollEvent());
    // Assert
    expect(seams.frames.size).toBe(0);
    expect(memory.page('e1')).toBeNull();
  });

  it('ignores a scroll whose target is not an element', async () => {
    // Arrange
    const memory = new ScrollMemory(storageOf());
    view = await mount(<Page entryKey="e1" memory={memory} />);
    const text = must(scrollerOf(view).firstChild, 'a row').firstChild as Text;
    // Act
    text.dispatchEvent(scrollEvent());
    // Assert
    expect(seams.frames.size).toBe(0);
  });

  it('skips a scroller that left the region before the frame', async () => {
    // Arrange
    const memory = new ScrollMemory(storageOf());
    view = await mount(<Page entryKey="e1" memory={memory} />);
    const scroller = scrollerOf(view);
    scroller.scrollTop = 40;
    scroller.dispatchEvent(scrollEvent());
    scroller.remove();
    // Act
    seams.runFrames();
    // Assert
    expect(memory.page('e1')).toBeNull();
  });

  it('flushes a queued write when the page unmounts and cancels the frame', async () => {
    // Arrange
    const memory = new ScrollMemory(storageOf());
    view = await mount(<Page entryKey="e1" memory={memory} />);
    const scroller = scrollerOf(view);
    scroller.scrollTop = 55;
    scroller.dispatchEvent(scrollEvent());
    // Act
    await view.unmount();
    view = null;
    // Assert
    expect(seams.cancelled.length).toBe(1);
    expect(memory.page('e1')).toEqual({ '0': 55 });
  });

  it('unmounts cleanly with nothing queued', async () => {
    // Arrange
    const memory = new ScrollMemory(storageOf());
    view = await mount(<Page entryKey="e1" memory={memory} />);
    // Act
    await view.unmount();
    view = null;
    // Assert
    expect(seams.cancelled).toEqual([]);
    expect(memory.page('e1')).toBeNull();
  });
});

describe('restoring', () => {
  const seeded = (top: number): ScrollMemory => {
    const memory = new ScrollMemory(storageOf());
    memory.rememberPage('e1', '0', top);
    return memory;
  };

  it('puts the offset back at once when the content is already tall enough', async () => {
    // Arrange
    const memory = seeded(300);
    // Act
    view = await mount(<Page entryKey="e1" memory={memory} />);
    // Assert
    expect(scrollerOf(view).scrollTop).toBe(300);
  });

  it('does nothing for an entry with no saved place', async () => {
    // Arrange
    const memory = new ScrollMemory(storageOf());
    // Act
    view = await mount(<Page entryKey="fresh" memory={memory} />);
    // Assert
    expect(scrollerOf(view).scrollTop).toBe(0);
  });

  it('waits while the content is too short, then restores when it grows', async () => {
    // Arrange
    const memory = seeded(800);
    const box: Box = { scrollHeight: 500, clientHeight: 400 };
    view = await mount(<Page box={box} entryKey="e1" memory={memory} />);
    const scroller = scrollerOf(view);
    const waiting = scroller.scrollTop;
    // Act
    box.scrollHeight = 1500;
    await view.render(<Page box={box} entryKey="e1" extra={1} memory={memory} />);
    await settleUntil(() => scroller.scrollTop === 800, 'the restore after growth', interact);
    // Assert
    expect(waiting).toBe(0);
    expect(scroller.scrollTop).toBe(800);
  });

  it('settles for the nearest offset once the patience runs out', async () => {
    // Arrange
    const memory = seeded(900);
    const box: Box = { scrollHeight: 700, clientHeight: 400 };
    view = await mount(<Page box={box} entryKey="e1" memory={memory} />);
    const scroller = scrollerOf(view);
    // Act
    await interact(() => seams.patience.forEach(fire => void fire()));
    // Assert
    expect(scroller.scrollTop).toBe(300);
  });

  it('skips a scroller the page has not built, then clamps nothing for it', async () => {
    // Arrange
    const memory = new ScrollMemory(storageOf());
    memory.rememberPage('e1', '0', 100);
    memory.rememberPage('e1', '5.5', 100);
    // Act
    view = await mount(<Page entryKey="e1" memory={memory} />);
    await interact(() => seams.patience.forEach(fire => void fire()));
    // Assert
    expect(scrollerOf(view).scrollTop).toBe(100);
  });

  it('stops waiting for the patience timer once everything is restored', async () => {
    // Arrange
    const memory = seeded(100);
    view = await mount(<Page entryKey="e1" memory={memory} />);
    const scroller = scrollerOf(view);
    scroller.scrollTop = 5;
    // Act
    await interact(() => seams.patience.forEach(fire => void fire()));
    // Assert
    expect(scroller.scrollTop).toBe(5);
  });

  it.each(['wheel', 'pointerdown', 'touchstart', 'keydown'])(
    'a reader %s ends the restore, so later growth does not drag them back',
    async type => {
      // Arrange
      const memory = seeded(800);
      const box: Box = { scrollHeight: 500, clientHeight: 400 };
      view = await mount(<Page box={box} entryKey="e1" memory={memory} />);
      const scroller = scrollerOf(view);
      await interact(() => scroller.dispatchEvent(new Event(type, { bubbles: true })));
      // Act
      box.scrollHeight = 1500;
      await view.render(<Page box={box} entryKey="e1" extra={1} memory={memory} />);
      await interact(() => seams.patience.forEach(fire => void fire()));
      // Assert
      expect(scroller.scrollTop).toBe(0);
    },
  );

  it('restores a new entry when the entry changes', async () => {
    // Arrange
    const memory = new ScrollMemory(storageOf());
    memory.rememberPage('e2', '0', 250);
    view = await mount(<Page entryKey="e1" memory={memory} />);
    // Act
    await view.render(<Page entryKey="e2" memory={memory} />);
    // Assert
    expect(scrollerOf(view).scrollTop).toBe(250);
  });

  it('re-attempts when a ResizeObserver reports, and works with none at all', async () => {
    // Arrange
    const observers: Array<() => void> = [];
    class FakeResizeObserver {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    const memory = seeded(800);
    const box: Box = { scrollHeight: 500, clientHeight: 400 };
    try {
      view = await mount(<Page box={box} entryKey="e1" memory={memory} />);
      const scroller = scrollerOf(view);
      // Act
      box.scrollHeight = 1500;
      await interact(() => observers.forEach(fire => void fire()));
      // Assert
      expect(scroller.scrollTop).toBe(800);
      await view.unmount();
      view = null;

      // Arrange (no ResizeObserver)
      Reflect.deleteProperty(globalThis, 'ResizeObserver');
      view = await mount(<Page entryKey="e1" memory={seeded(60)} />);
      // Assert
      expect(scrollerOf(view).scrollTop).toBe(60);
    } finally {
      if (saved) Object.defineProperty(globalThis, 'ResizeObserver', saved);
      else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    }
  });
});

describe('useRouteScrollMemory without a region', () => {
  it('does nothing when the ref was never attached', async () => {
    // Arrange
    const memory = new ScrollMemory(storageOf());
    memory.rememberPage('e1', '', 10);
    function Bare() {
      const ref: RefObject<HTMLElement | null> = useRef(null);
      useRouteScrollMemory(ref, 'e1', memory);
      return <span data-testid="bare" />;
    }
    // Act
    view = await mount(<Bare />);
    // Assert
    expect(view.container.querySelector('[data-testid="bare"]')).not.toBeNull();
    expect(seams.frames.size).toBe(0);
    expect(seams.patience.length).toBe(0);
  });
});
