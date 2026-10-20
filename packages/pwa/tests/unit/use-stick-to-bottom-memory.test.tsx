import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { TOUCH_SELECTION_RELEASE_SETTLE_MS } from '../../src/hooks/use-live-clock.ts';
import {
  READING_RESTORE_PATIENCE_MS,
  READING_WRITE_SETTLE_MS,
  type StickToBottom,
  useStickToBottom,
} from '../../src/hooks/use-stick-to-bottom.ts';
import type { ChatScroll, ChatScrollSlot } from '../../src/lib/scroll-memory.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';

/** A scroller's box: happy-dom lays nothing out, so the test states it and may change it later. */
interface Box {
  scrollHeight: number;
  clientHeight: number;
}

const measure = (element: HTMLElement | null, box: Box): void => {
  if (element === null) return;
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => box.scrollHeight });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => box.clientHeight });
};

/** A slot that holds one position and records every write. */
const slotOf = (saved: ChatScroll | null): ChatScrollSlot & { writes: ChatScroll[]; reads: number } => {
  const slot = {
    writes: [] as ChatScroll[],
    reads: 0,
    read: (): ChatScroll | null => {
      slot.reads += 1;
      return saved;
    },
    write: (position: ChatScroll): void => {
      slot.writes.push(position);
    },
  };
  return slot;
};

const TIMED = [READING_WRITE_SETTLE_MS, READING_RESTORE_PATIENCE_MS, TOUCH_SELECTION_RELEASE_SETTLE_MS];

interface Seams {
  frames: Map<number, FrameRequestCallback>;
  timers: Map<number, { delay: number; callback: () => void }>;
  resizes: Array<() => void>;
  runFrames: () => void;
  /** Fires every pending timer of this delay. */
  fire: (delay: number) => void;
  pending: (delay: number) => number;
  restore: () => void;
}

const original = {
  raf: globalThis.requestAnimationFrame,
  caf: globalThis.cancelAnimationFrame,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  resizeObserver: Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver'),
};

const installSeams = (): Seams => {
  let nextFrame = 1;
  let nextTimer = 1_000_000;
  const seams: Seams = {
    frames: new Map(),
    timers: new Map(),
    resizes: [],
    runFrames: () => {
      const due = [...seams.frames.values()];
      seams.frames.clear();
      for (const callback of due) callback(0);
    },
    fire: delay => {
      for (const [id, timer] of [...seams.timers]) {
        if (timer.delay !== delay) continue;
        seams.timers.delete(id);
        timer.callback();
      }
    },
    pending: delay => [...seams.timers.values()].filter(timer => timer.delay === delay).length,
    restore: () => {
      globalThis.requestAnimationFrame = original.raf;
      globalThis.cancelAnimationFrame = original.caf;
      globalThis.setTimeout = original.setTimeout;
      globalThis.clearTimeout = original.clearTimeout;
      if (original.resizeObserver) Object.defineProperty(globalThis, 'ResizeObserver', original.resizeObserver);
      else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    },
  };
  globalThis.requestAnimationFrame = callback => {
    const id = nextFrame++;
    seams.frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => void seams.frames.delete(id);
  globalThis.setTimeout = ((callback: () => void, delay?: number, ...rest: unknown[]) => {
    if (delay === undefined || !TIMED.includes(delay)) return original.setTimeout(callback, delay, ...rest);
    const id = nextTimer++;
    seams.timers.set(id, { delay, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    if (id !== undefined && seams.timers.delete(id)) return;
    original.clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      seams.resizes.push(callback);
    }
    observe(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  return seams;
};

interface Probe {
  api: StickToBottom | null;
  follows: number;
}

interface SurfaceProps {
  readonly probe: Probe;
  readonly box: Box;
  readonly resetKey?: string;
  readonly content?: number;
  readonly memory?: ChatScrollSlot;
  readonly attach?: boolean;
}

function Surface({ probe, box, resetKey = 'a', content = 0, memory, attach = true }: SurfaceProps) {
  const api = useStickToBottom({
    resetKey,
    contentKeys: [content],
    onFollow: () => {
      probe.follows += 1;
    },
    ...(memory === undefined ? {} : { memory }),
  });
  probe.api = api;
  return (
    <div
      data-detached={api.detached ? 'yes' : 'no'}
      data-testid="viewport"
      ref={element => {
        api.viewportRef.current = attach ? element : null;
        measure(element, box);
      }}
    >
      <div
        data-testid="content"
        ref={element => {
          api.contentRef.current = attach ? element : null;
        }}
      />
    </div>
  );
}

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

const viewportOf = (mounted: Mounted): HTMLElement =>
  mounted.container.querySelector('[data-testid="viewport"]') as HTMLElement;

const isDetached = (mounted: Mounted): boolean => viewportOf(mounted).dataset.detached === 'yes';

const freshProbe = (): Probe => ({ api: null, follows: 0 });

const api = (probe: Probe): StickToBottom => {
  if (probe.api === null) throw new Error('the hook has not rendered');
  return probe.api;
};

describe('opening without a memory', () => {
  it('lands at the latest, follows, and pins again next frame', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    // Act
    view = await mount(<Surface box={box} probe={probe} />);
    box.scrollHeight = 1200;
    await interact(() => seams.runFrames());
    // Assert
    expect(viewportOf(view).scrollTop).toBe(1200);
    expect(api(probe).following.current).toBe(true);
    expect(isDetached(view)).toBe(false);
    expect(probe.follows).toBeGreaterThan(0);
  });
});

describe('opening with a saved position', () => {
  it.each([
    { name: 'none saved', saved: null },
    { name: 'a position at the latest', saved: { top: 80, atLatest: true } },
  ])('follows the tail when $name', async ({ saved }) => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    const memory = slotOf(saved);
    // Act
    view = await mount(<Surface box={box} memory={memory} probe={probe} />);
    // Assert
    expect(viewportOf(view).scrollTop).toBe(1000);
    expect(api(probe).following.current).toBe(true);
    expect(isDetached(view)).toBe(false);
    expect(memory.reads).toBe(1);
  });

  it('puts back a position that was not at the latest, detached, when the content is tall enough', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    const memory = slotOf({ top: 300, atLatest: false });
    // Act
    view = await mount(<Surface box={box} memory={memory} probe={probe} />);
    // Assert
    expect(viewportOf(view).scrollTop).toBe(300);
    expect(api(probe).following.current).toBe(false);
    expect(isDetached(view)).toBe(true);
    expect(api(probe).gap.current).toBe(300);
    expect(seams.pending(READING_RESTORE_PATIENCE_MS)).toBe(1);
  });

  it('waits for content, then restores when a new row arrives in the same commit', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 500, clientHeight: 400 };
    const memory = slotOf({ top: 800, atLatest: false });
    view = await mount(<Surface box={box} memory={memory} probe={probe} />);
    const waiting = viewportOf(view).scrollTop;
    // Act
    box.scrollHeight = 1500;
    await view.render(<Surface box={box} content={1} memory={memory} probe={probe} />);
    // Assert
    expect(waiting).not.toBe(800);
    expect(viewportOf(view).scrollTop).toBe(800);
  });

  it('restores when the resize observer reports growth, and only refreshes the gap otherwise', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 500, clientHeight: 400 };
    const memory = slotOf({ top: 800, atLatest: false });
    view = await mount(<Surface box={box} memory={memory} probe={probe} />);
    await interact(() => seams.resizes.forEach(fire => void fire()));
    const stillWaiting = viewportOf(view).scrollTop;
    // Act
    box.scrollHeight = 1500;
    await interact(() => seams.resizes.forEach(fire => void fire()));
    // Assert
    expect(stillWaiting).not.toBe(800);
    expect(viewportOf(view).scrollTop).toBe(800);
    expect(api(probe).gap.current).toBe(1500 - 800 - 400);
  });

  it('pins on a resize while following', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    view = await mount(<Surface box={box} probe={probe} />);
    // Act
    box.scrollHeight = 1400;
    await interact(() => seams.resizes.forEach(fire => void fire()));
    // Assert
    expect(viewportOf(view).scrollTop).toBe(1400);
  });

  it('settles for the nearest offset once the patience runs out', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 700, clientHeight: 400 };
    const memory = slotOf({ top: 900, atLatest: false });
    view = await mount(<Surface box={box} memory={memory} probe={probe} />);
    // Act
    await interact(() => seams.fire(READING_RESTORE_PATIENCE_MS));
    // Assert
    expect(viewportOf(view).scrollTop).toBe(300);
    expect(isDetached(view)).toBe(true);
  });

  it('does nothing in the final attempt when the restore already happened', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    const memory = slotOf({ top: 100, atLatest: false });
    view = await mount(<Surface box={box} memory={memory} probe={probe} />);
    viewportOf(view).scrollTop = 250;
    // Act
    await interact(() => seams.fire(READING_RESTORE_PATIENCE_MS));
    // Assert
    expect(viewportOf(view).scrollTop).toBe(250);
  });

  it('treats a later reset as a return to the latest, not another restore', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 500, clientHeight: 400 };
    const memory = slotOf({ top: 800, atLatest: false });
    view = await mount(<Surface box={box} memory={memory} probe={probe} />);
    // Act
    await view.render(<Surface box={box} memory={memory} probe={probe} resetKey="b" />);
    box.scrollHeight = 1500;
    await view.render(<Surface box={box} content={1} memory={memory} probe={probe} resetKey="b" />);
    // Assert
    expect(memory.reads).toBe(1);
    expect(api(probe).following.current).toBe(true);
    expect(isDetached(view)).toBe(false);
    expect(viewportOf(view).scrollTop).toBe(1500);
  });

  it('jump to latest abandons a restore still waiting', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 500, clientHeight: 400 };
    const memory = slotOf({ top: 800, atLatest: false });
    view = await mount(<Surface box={box} memory={memory} probe={probe} />);
    // Act
    await interact(() => api(probe).jumpToLatest());
    box.scrollHeight = 1500;
    await interact(() => seams.resizes.forEach(fire => void fire()));
    // Assert
    expect(viewportOf(view).scrollTop).toBe(1500);
    expect(isDetached(view)).toBe(false);
  });
});

describe('writing the reading position', () => {
  it('writes once, after the movement settles, with the offset and whether it is at the latest', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    const memory = slotOf(null);
    view = await mount(<Surface box={box} memory={memory} probe={probe} />);
    memory.writes.length = 0;
    seams.timers.clear();
    const viewport = viewportOf(view);
    // Act
    await interact(() => {
      viewport.dispatchEvent(new Event('wheel', { bubbles: true }));
      viewport.scrollTop = 400;
      api(probe).onScroll();
      viewport.scrollTop = 350;
      api(probe).onScroll();
    });
    const pending = seams.pending(READING_WRITE_SETTLE_MS);
    await interact(() => seams.fire(READING_WRITE_SETTLE_MS));
    // Assert
    expect(pending).toBe(1);
    expect(memory.writes).toEqual([{ top: 350, atLatest: false }]);
    expect(isDetached(view)).toBe(true);
  });

  it('writes nothing without a memory', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    view = await mount(<Surface box={box} probe={probe} />);
    // Act
    await interact(() => api(probe).onScroll());
    // Assert
    expect(seams.pending(READING_WRITE_SETTLE_MS)).toBe(0);
  });

  it('re-engages and records at the latest when the reader returns to the bottom', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    const memory = slotOf({ top: 100, atLatest: false });
    view = await mount(<Surface box={box} memory={memory} probe={probe} />);
    const viewport = viewportOf(view);
    // Act
    await interact(() => {
      viewport.scrollTop = 590;
      api(probe).onScroll();
    });
    await interact(() => seams.fire(READING_WRITE_SETTLE_MS));
    // Assert
    expect(api(probe).following.current).toBe(true);
    expect(isDetached(view)).toBe(false);
    expect(memory.writes.at(-1)).toEqual({ top: 1000, atLatest: true });
  });

  it('writes the last observed position when unmounted with a write pending', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    const memory = slotOf({ top: 100, atLatest: false });
    view = await mount(<Surface box={box} memory={memory} probe={probe} />);
    const viewport = viewportOf(view);
    await interact(() => {
      viewport.scrollTop = 120;
      api(probe).onScroll();
    });
    memory.writes.length = 0;
    // Act
    await view.unmount();
    view = null;
    // Assert
    expect(memory.writes).toEqual([{ top: 120, atLatest: false }]);
    expect(seams.pending(READING_WRITE_SETTLE_MS)).toBe(0);
  });

  it('writes nothing on unmount when nothing is pending', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    const memory = slotOf({ top: 100, atLatest: false });
    view = await mount(<Surface box={box} memory={memory} probe={probe} />);
    // Act
    await view.unmount();
    view = null;
    // Assert
    expect(memory.writes).toEqual([]);
  });
});

describe('hook surface', () => {
  it('scrollTo moves the viewport and is never read as the reader', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    view = await mount(<Surface box={box} probe={probe} />);
    // Act
    await interact(() => api(probe).scrollTo(200));
    await interact(() => api(probe).onScroll());
    // Assert
    expect(viewportOf(view).scrollTop).toBe(200);
    expect(api(probe).following.current).toBe(true);
  });

  it('does nothing without a viewport', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    view = await mount(<Surface attach={false} box={box} probe={probe} />);
    // Act
    await interact(() => {
      api(probe).onScroll();
      api(probe).scrollTo(5);
      api(probe).jumpToLatest();
    });
    // Assert
    expect(api(probe).following.current).toBe(true);
    expect(viewportOf(view).scrollTop).toBe(0);
  });

  it('works where there is no ResizeObserver', async () => {
    // Arrange
    Reflect.deleteProperty(globalThis, 'ResizeObserver');
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    // Act
    view = await mount(<Surface box={box} probe={probe} />);
    // Assert
    expect(seams.resizes).toEqual([]);
    expect(viewportOf(view).scrollTop).toBe(1000);
  });
});

describe('reader input', () => {
  it('holds the pin while a pointer is down and re-pins a beat after it lifts', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    view = await mount(<Surface box={box} probe={probe} />);
    const viewport = viewportOf(view);
    await interact(() => viewport.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    box.scrollHeight = 1300;
    await interact(() => seams.resizes.forEach(fire => void fire()));
    const held = viewport.scrollTop;
    // Act
    await interact(() => {
      window.dispatchEvent(new Event('pointerup'));
      window.dispatchEvent(new Event('blur'));
    });
    await interact(() => seams.fire(TOUCH_SELECTION_RELEASE_SETTLE_MS));
    // Assert
    expect(held).toBe(1000);
    expect(viewport.scrollTop).toBe(1300);
  });

  it('a re-pin timer does not pin once the reader has detached', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    const memory = slotOf({ top: 100, atLatest: false });
    view = await mount(<Surface box={box} memory={memory} probe={probe} />);
    const viewport = viewportOf(view);
    // Act
    await interact(() => window.dispatchEvent(new Event('touchend')));
    await interact(() => seams.fire(TOUCH_SELECTION_RELEASE_SETTLE_MS));
    // Assert
    expect(viewport.scrollTop).toBe(100);
  });

  it.each([
    { name: 'a scrolling key', key: 'PageUp', tag: 'div', marks: true },
    { name: 'a letter', key: 'a', tag: 'div', marks: false },
    { name: 'a scrolling key typed in an input', key: 'ArrowUp', tag: 'input', marks: false },
    { name: 'a scrolling key typed in a textarea', key: 'ArrowUp', tag: 'textarea', marks: false },
  ])('$name: intent stamped is $marks', async ({ key, tag, marks }) => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    const memory = slotOf(null);
    view = await mount(<Surface box={box} memory={memory} probe={probe} />);
    const viewport = viewportOf(view);
    const target = document.createElement(tag);
    document.body.appendChild(target);
    await interact(() => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    // Act
    await interact(() => {
      viewport.scrollTop = 300;
      api(probe).onScroll();
    });
    target.remove();
    // Assert
    expect(api(probe).following.current).toBe(!marks);
  });

  it('a selection change re-pins a following reader', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    view = await mount(<Surface box={box} probe={probe} />);
    box.scrollHeight = 1100;
    // Act
    await interact(() => document.dispatchEvent(new Event('selectionchange')));
    // Assert
    expect(viewportOf(view).scrollTop).toBe(1100);
  });

  it('a selection change leaves a detached reader alone', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    const memory = slotOf({ top: 100, atLatest: false });
    view = await mount(<Surface box={box} memory={memory} probe={probe} />);
    // Act
    await interact(() => document.dispatchEvent(new Event('selectionchange')));
    // Assert
    expect(viewportOf(view).scrollTop).toBe(100);
  });

  it('wheel and touchmove stamp intent so an upward scroll detaches', async () => {
    // Arrange
    const probe = freshProbe();
    const box: Box = { scrollHeight: 1000, clientHeight: 400 };
    view = await mount(<Surface box={box} probe={probe} />);
    const viewport = viewportOf(view);
    // Act
    await interact(() => {
      viewport.dispatchEvent(new Event('touchmove', { bubbles: true }));
      viewport.scrollTop = 200;
      api(probe).onScroll();
    });
    // Assert
    expect(api(probe).following.current).toBe(false);
    expect(isDetached(view)).toBe(true);
  });
});
