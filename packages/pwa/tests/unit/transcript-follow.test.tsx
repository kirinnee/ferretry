import { afterEach, describe, expect, test } from 'bun:test';
import { Transcript } from '../../src/components/transcript.tsx';
import type { ChatScrollSlot } from '../../src/lib/scroll-memory.ts';
import { type TranscriptEntry, transcriptItems } from '../../src/lib/session-screens.ts';
import {
  followPinBlocked,
  gapFromBottom,
  JUMP_PILL_HIDE_PX,
  JUMP_PILL_SHOW_PX,
  jumpPillShown,
  jumpToLatestLabel,
  newTailRows,
  pinBlockedBySelection,
  prependedAbove,
  prependRestoreTarget,
  scrollIsByReader,
  scrollVerdict,
  TRANSCRIPT_INTENT_WINDOW_MS,
  TRANSCRIPT_REENGAGE_PX,
} from '../../src/lib/transcript-follow.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

const inside = { id: 'inside' } as unknown as Node;
const outside = { id: 'outside' } as unknown as Node;
const contains = (node: Node | null): boolean => node === inside;
const selection = (anchorNode: Node | null, focusNode: Node | null, isCollapsed = false, rangeCount = 1) => ({
  isCollapsed,
  rangeCount,
  anchorNode,
  focusNode,
});

describe('follow decisions', () => {
  test('a held selection blocks a pin only when it reaches into the transcript', () => {
    expect(pinBlockedBySelection(null, contains)).toBe(false);
    expect(pinBlockedBySelection(selection(inside, inside, true), contains)).toBe(false);
    expect(pinBlockedBySelection(selection(inside, inside, false, 0), contains)).toBe(false);
    expect(pinBlockedBySelection(selection(outside, outside), contains)).toBe(false);
    expect(pinBlockedBySelection(selection(outside, inside), contains)).toBe(true);
    expect(pinBlockedBySelection(selection(inside, outside), contains)).toBe(true);
    // A held pointer blocks on its own: the long-press window before a selection exists.
    expect(followPinBlocked(true, null, contains)).toBe(true);
    expect(followPinBlocked(false, null, contains)).toBe(false);
  });

  test('a scroll is the reader’s while a pointer is held or inside the intent window', () => {
    expect(scrollIsByReader(true, Number.NEGATIVE_INFINITY, 0)).toBe(true);
    expect(scrollIsByReader(false, 1_000, 1_000 + TRANSCRIPT_INTENT_WINDOW_MS - 1)).toBe(true);
    expect(scrollIsByReader(false, 1_000, 1_000 + TRANSCRIPT_INTENT_WINDOW_MS)).toBe(false);
  });

  test('measures the distance from the bottom, never negative', () => {
    expect(gapFromBottom({ scrollTop: 100, scrollHeight: 1_000, clientHeight: 200 })).toBe(700);
    expect(gapFromBottom({ scrollTop: 900, scrollHeight: 1_000, clientHeight: 200 })).toBe(0);
  });

  test('detaches only for a reader’s scroll-up that no shrink explains', () => {
    const memory = { lastScrollTop: 800, scrollHeight: 1_000, clientHeight: 200 };
    const up = { scrollTop: 600, scrollHeight: 1_000, clientHeight: 200 };
    expect(scrollVerdict(up, memory, { following: true, byReader: true })).toBe('detach');
    // Layout, not a person.
    expect(scrollVerdict(up, memory, { following: true, byReader: false })).toBe('stay');
    // Sub-pixel noise is not movement.
    expect(scrollVerdict({ ...up, scrollTop: 799.5 }, memory, { following: true, byReader: true })).toBe('stay');
    // The content or the viewport got shorter: scrollTop fell by itself.
    expect(scrollVerdict({ ...up, scrollHeight: 900 }, memory, { following: true, byReader: true })).toBe('stay');
    expect(scrollVerdict({ ...up, clientHeight: 150 }, memory, { following: true, byReader: true })).toBe('stay');
    // The viewport GREW and the browser clamped scrollTop to the new maximum: still not a person.
    expect(scrollVerdict({ ...up, clientHeight: 250 }, memory, { following: true, byReader: true })).toBe('stay');
  });

  test('re-engages inside the band only when not moving up', () => {
    const memory = { lastScrollTop: 600, scrollHeight: 1_000, clientHeight: 200 };
    const band = 1_000 - 200 - TRANSCRIPT_REENGAGE_PX;
    expect(
      scrollVerdict({ scrollTop: band, scrollHeight: 1_000, clientHeight: 200 }, memory, {
        following: false,
        byReader: true,
      }),
    ).toBe('reengage');
    expect(
      scrollVerdict({ scrollTop: band - 1, scrollHeight: 1_000, clientHeight: 200 }, memory, {
        following: false,
        byReader: true,
      }),
    ).toBe('stay');
    // Passing through the band on the way UP is leaving, not arriving.
    expect(
      scrollVerdict(
        { scrollTop: 780, scrollHeight: 1_000, clientHeight: 200 },
        { ...memory, lastScrollTop: 800 },
        {
          following: false,
          byReader: true,
        },
      ),
    ).toBe('stay');
  });

  test('counts rows that arrived at the tail', () => {
    expect(newTailRows(['a', 'b', 'c'], 'a', 1)).toBe(2);
    expect(newTailRows(['a', 'b'], 'b', 2)).toBe(0);
    expect(newTailRows([], 'b', 2)).toBe(0);
    expect(newTailRows(['a'], null, 0)).toBe(0);
    // A row that went away adds nothing to read.
    expect(newTailRows(['a', 'c'], 'b', 3)).toBe(0);
    // The old last row is gone but the list grew: at least one is new.
    expect(newTailRows(['x', 'y', 'z'], 'b', 2)).toBe(1);
  });

  test('a prepend is rows above a first row that is still there', () => {
    expect(prependedAbove(['old', 'a', 'b'], 'a')).toBe(true);
    expect(prependedAbove(['a', 'b'], 'a')).toBe(false);
    expect(prependedAbove(['b', 'c'], 'a')).toBe(false);
    expect(prependedAbove(['a'], null)).toBe(false);
  });

  test('restores the gap from the bottom, and never moves the reader up', () => {
    expect(prependRestoreTarget({ scrollTop: 100, scrollHeight: 2_000, clientHeight: 200 }, 300)).toBe(1_500);
    expect(prependRestoreTarget({ scrollTop: 1_600, scrollHeight: 2_000, clientHeight: 200 }, 300)).toBeUndefined();
    expect(prependRestoreTarget({ scrollTop: 100, scrollHeight: 2_000, clientHeight: 200 }, 0)).toBeUndefined();
  });

  test('labels the pill with a count only when there is one', () => {
    expect(jumpToLatestLabel(0)).toBe('Jump to latest');
    expect(jumpToLatestLabel(3)).toBe('3 new — jump to latest');
  });

  test('the pill takes more distance to appear than to leave, so drift near the tail never toggles it', () => {
    expect(jumpPillShown(false, false, 500)).toBe(false);
    expect(jumpPillShown(true, false, 500)).toBe(false);
    expect(jumpPillShown(false, true, JUMP_PILL_SHOW_PX)).toBe(false);
    expect(jumpPillShown(false, true, JUMP_PILL_SHOW_PX + 1)).toBe(true);
    expect(jumpPillShown(true, true, JUMP_PILL_SHOW_PX)).toBe(true);
    expect(jumpPillShown(true, true, JUMP_PILL_HIDE_PX + 1)).toBe(true);
    expect(jumpPillShown(true, true, JUMP_PILL_HIDE_PX)).toBe(false);
  });
});

describe('transcriptItems', () => {
  test('drops every notice but an alert and threads the visible row before each', () => {
    const entries: readonly TranscriptEntry[] = [
      { id: 'u', kind: 'user', text: 'where?' },
      { id: 'n', kind: 'notice', text: 'in=2 out=3' },
      { id: 'e', kind: 'notice', text: 'E1', alert: true },
      { id: 'a', kind: 'assistant', text: 'here' },
    ];
    expect(transcriptItems(entries).map(item => [item.entry.id, item.previous?.id])).toEqual([
      ['u', undefined],
      ['e', 'u'],
      ['a', 'e'],
    ]);
  });
});

// ---- the component, against a real DOM ----------------------------------------------------------

const rows = (count: number, prefix = 'row'): TranscriptEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    kind: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `${prefix} ${index}`,
  }));

/** happy-dom has no layout, so the scroller's height is stated — and can grow. */
const metrics = { scrollHeight: 2_000, clientHeight: 400 };
const scroller = (view: Mounted): HTMLElement => {
  const element = must(view.container.querySelector<HTMLElement>('[role="log"]'), 'the transcript scroller');
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => metrics.clientHeight });
  return element;
};
const pill = (view: Mounted): HTMLButtonElement | null => view.container.querySelector('.fy-jump-latest');
const scrollTo = async (element: HTMLElement, top: number): Promise<void> => {
  element.scrollTop = top;
  await interact(() => element.dispatchEvent(new Event('scroll')));
};
/** A reader's scroll: a wheel tick first, which is the input that proves it was them. */
const readerScroll = async (element: HTMLElement, top: number): Promise<void> => {
  await interact(() => element.dispatchEvent(new Event('wheel')));
  await scrollTo(element, top);
};
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  metrics.scrollHeight = 2_000;
  metrics.clientHeight = 400;
  window.getSelection()?.removeAllRanges();
});

/** Mounts, sizes the scroller, then re-renders once so the open pin sees the stated height. */
const open = async (
  entries: readonly TranscriptEntry[],
  props: { busy?: boolean; pinSignal?: number; readingPosition?: ChatScrollSlot } = {},
) => {
  const view = await mount(<Transcript daemonId="d" entries={entries} sessionId="s" {...props} />);
  mounted = view;
  const element = scroller(view);
  await view.render(<Transcript daemonId="d" entries={[...entries]} sessionId="s" {...props} />);
  return { view, element };
};

describe('Transcript follow', () => {
  test('opens at the latest message and stays there as rows arrive', async () => {
    const first = rows(4);
    const { view, element } = await open(first, { busy: true });
    expect(element.getAttribute('aria-live')).toBe('polite');
    expect(view.container.textContent).toContain('Working…');
    expect(element.scrollTop).toBe(2_000);
    metrics.scrollHeight = 2_400;
    await view.render(<Transcript busy daemonId="d" entries={[...first, ...rows(1, 'next')]} sessionId="s" />);
    expect(element.scrollTop).toBe(2_400);
    expect(pill(view)).toBeNull();
  });

  test('layout moving scrollTop is not the reader, and does not detach', async () => {
    const { view, element } = await open(rows(4));
    await scrollTo(element, 900);
    expect(pill(view)).toBeNull();
  });

  test('a reader scrolling up detaches, counts what arrives, and the pill brings them back', async () => {
    const first = rows(4);
    const { view, element } = await open(first);
    await readerScroll(element, 600);
    expect(must(pill(view), 'the pill').textContent).toBe('Jump to latest');

    metrics.scrollHeight = 2_600;
    await view.render(<Transcript daemonId="d" entries={[...first, ...rows(2, 'new')]} sessionId="s" />);
    expect(element.scrollTop).toBe(600);
    expect(must(pill(view), 'the pill').textContent).toBe('2 new — jump to latest');

    await interact(() => must(pill(view), 'the pill').click());
    expect(element.scrollTop).toBe(2_600);
    expect(pill(view)).toBeNull();
  });

  test('scrolling back into the band re-engages follow and lands on the tail', async () => {
    const { view, element } = await open(rows(4));
    await readerScroll(element, 600);
    expect(pill(view)).not.toBeNull();
    await scrollTo(element, 2_000 - 400 - TRANSCRIPT_REENGAGE_PX);
    expect(pill(view)).toBeNull();
    expect(element.scrollTop).toBe(2_000);
  });

  test('a nudge within reach of the tail detaches without showing the pill, and the pill row exists only with the pill', async () => {
    const { view, element } = await open(rows(4));
    expect(view.container.querySelectorAll('.fy-jump-latest-shell')).toHaveLength(0);
    await readerScroll(element, 2_000 - 400 - 10);
    expect(pill(view)).toBeNull();
    await readerScroll(element, 600);
    expect(pill(view)).not.toBeNull();
    expect(view.container.querySelectorAll('.fy-jump-latest-shell')).toHaveLength(1);
  });

  test('a send (a bumped pinSignal) and a session switch both return a detached reader to the tail', async () => {
    const first = rows(4);
    const { view, element } = await open(first, { pinSignal: 0 });
    await readerScroll(element, 600);
    await view.render(<Transcript daemonId="d" entries={first} pinSignal={1} sessionId="s" />);
    expect(element.scrollTop).toBe(2_000);
    expect(pill(view)).toBeNull();

    await readerScroll(element, 600);
    await view.render(<Transcript daemonId="other" entries={rows(5, 'other')} pinSignal={1} sessionId="s" />);
    expect(element.scrollTop).toBe(2_000);
    expect(pill(view)).toBeNull();
  });

  test('rows prepended above a detached reader keep their distance from the bottom', async () => {
    const first = rows(4);
    const { view, element } = await open(first);
    await readerScroll(element, 600);
    // gap from the bottom was 2000 - 600 - 400 = 1000.
    metrics.scrollHeight = 3_000;
    await view.render(<Transcript daemonId="d" entries={[...rows(3, 'older'), ...first]} sessionId="s" />);
    expect(element.scrollTop).toBe(1_600);
  });

  test('a held pointer stops the pin until it is released, then the tail is resumed', async () => {
    const first = rows(4);
    const { view, element } = await open(first);
    await interact(() => element.dispatchEvent(new Event('pointerdown')));
    metrics.scrollHeight = 2_300;
    await view.render(<Transcript daemonId="d" entries={[...first, ...rows(1, 'later')]} sessionId="s" />);
    expect(element.scrollTop).toBe(2_000);
    await interact(() => window.dispatchEvent(new Event('pointerup')));
    // A second release restarts the settle timer rather than stacking another.
    await interact(() => window.dispatchEvent(new Event('blur')));
    await interact(() => wait(260));
    expect(element.scrollTop).toBe(2_300);
  });

  test('a held selection in the transcript stops the pin; clearing it resumes the tail', async () => {
    const first = rows(4);
    const { view, element } = await open(first);
    const range = document.createRange();
    range.selectNodeContents(must(element.querySelector('p'), 'a row'));
    await interact(() => window.getSelection()?.addRange(range));
    metrics.scrollHeight = 2_200;
    await view.render(<Transcript daemonId="d" entries={[...first, ...rows(1, 'later')]} sessionId="s" />);
    expect(element.scrollTop).toBe(2_000);
    await interact(() => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(element.scrollTop).toBe(2_200);
  });

  test('a scrolling key is reader intent; the same key typed in a field is not', async () => {
    const { view, element } = await open(rows(4));
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    try {
      await interact(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true })));
      await scrollTo(element, 900);
      expect(pill(view)).toBeNull();
      await interact(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      await scrollTo(element, 800);
      expect(pill(view)).toBeNull();
      await interact(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true })));
      await scrollTo(element, 500);
      expect(pill(view)).not.toBeNull();
    } finally {
      field.remove();
    }
  });

  test('a resize re-pins a following reader and only re-measures a detached one', async () => {
    const original = globalThis.ResizeObserver;
    const callbacks: (() => void)[] = [];
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    try {
      const { view, element } = await open(rows(4));
      metrics.scrollHeight = 2_500;
      await interact(() => {
        for (const callback of callbacks) callback();
      });
      expect(element.scrollTop).toBe(2_500);

      await readerScroll(element, 700);
      metrics.scrollHeight = 2_800;
      await interact(() => {
        for (const callback of callbacks) callback();
      });
      expect(element.scrollTop).toBe(700);
      expect(pill(view)).not.toBeNull();
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});

describe('Transcript reading position', () => {
  const slot = (saved: { top: number; atLatest: boolean } | null) => {
    const written: { top: number; atLatest: boolean }[] = [];
    return {
      written,
      memory: { read: () => saved, write: (position: { top: number; atLatest: boolean }) => written.push(position) },
    };
  };

  test('a session left scrolled up opens at that spot, detached, with Jump to latest on offer', async () => {
    // Arrange
    const { memory } = slot({ top: 600, atLatest: false });

    // Act
    const { view, element } = await open(rows(4), { readingPosition: memory });

    // Assert
    expect(element.scrollTop).toBe(600);
    expect(must(pill(view), 'the pill').textContent).toBe('Jump to latest');
  });

  test.each([
    { subject: 'left at the latest', input: { top: 600, atLatest: true } },
    { subject: 'never opened', input: null },
  ])('a session $subject opens at the latest with no pill', async ({ input }) => {
    // Arrange
    const { memory } = slot(input);

    // Act
    const { view, element } = await open(rows(4), { readingPosition: memory });

    // Assert
    expect(element.scrollTop).toBe(2_000);
    expect(pill(view)).toBeNull();
  });

  test('records where the reader settles', async () => {
    // Arrange
    const { memory, written } = slot(null);
    const { element } = await open(rows(4), { readingPosition: memory });

    // Act
    await readerScroll(element, 600);
    await interact(() => wait(200));

    // Assert
    expect(written.at(-1)).toEqual({ top: 600, atLatest: false });
  });
});
