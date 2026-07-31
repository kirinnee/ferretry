import { afterEach, describe, expect, it } from 'bun:test';
import {
  RESIZE_KEY_LARGE_STEP,
  RESIZE_KEY_STEP,
  RESIZE_THROTTLE_MS,
  SidePaneResizeHandle,
  type SidePaneWidthBounds,
  sidePaneWidthBounds,
  sidePaneWidthFromKey,
  sidePaneWidthFromPointer,
} from '../../src/shell/side-pane-resize-handle.tsx';
import {
  SIDE_PANE_DEFAULT_WIDTH,
  SIDE_PANE_MAX_WIDTH,
  SIDE_PANE_MIN_CHAT_WIDTH,
  SIDE_PANE_MIN_WIDTH,
  SIDE_PANE_WORKSPACE_GAP,
} from '../../src/lib/side-pane-preferences.ts';
import { interact, mount } from '../support/dom.ts';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface Harness {
  readonly handle: HTMLButtonElement;
  readonly workspace: HTMLElement;
  readonly previews: number[];
  readonly commits: number[];
  readonly unmount: () => Promise<void>;
  readonly resize: (paneWidth: number, workspaceWidth: number) => void;
}

/**
 * happy-dom has no layout, so the pane and the workspace are given the
 * rectangles the component reads. The DOM shape matters: the handle's parent is
 * the pane and its grandparent is the workspace.
 */
const harness = async (props: { width?: number; bounds?: SidePaneWidthBounds } = {}): Promise<Harness> => {
  const previews: number[] = [];
  const commits: number[] = [];
  const mounted = await mount(
    <div data-role="workspace">
      <div data-role="pane">
        <SidePaneResizeHandle
          width={props.width ?? SIDE_PANE_DEFAULT_WIDTH}
          onPreview={width => previews.push(width)}
          onCommit={width => commits.push(width)}
          {...(props.bounds ? { bounds: props.bounds } : {})}
        />
      </div>
    </div>,
  );

  const handle = mounted.container.querySelector('button') as HTMLButtonElement;
  const pane = handle.parentElement as HTMLElement;
  const workspace = pane.parentElement as HTMLElement;
  const resize = (paneWidth: number, workspaceWidth: number): void => {
    pane.getBoundingClientRect = () => ({ width: paneWidth }) as DOMRect;
    workspace.getBoundingClientRect = () => ({ width: workspaceWidth }) as DOMRect;
  };
  resize(SIDE_PANE_DEFAULT_WIDTH, 1440);
  // The rectangles only exist once the boxes are in the document, so the first
  // measurement happens the way a real one does: on a reported size change.
  await interact(() => remeasure());

  // Pointer capture is not implemented by happy-dom; the component only needs
  // it to behave like a capture bookkeeping pair.
  let captured: number | null = null;
  handle.setPointerCapture = (pointerId: number) => {
    captured = pointerId;
  };
  handle.hasPointerCapture = (pointerId: number) => captured === pointerId;
  handle.releasePointerCapture = () => {
    captured = null;
  };

  return { handle, workspace, previews, commits, unmount: mounted.unmount, resize };
};

const firePointer = (
  target: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture',
  fields: { pointerId?: number; clientX?: number; button?: number } = {},
): void => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, clientX: 0, button: 0, ...fields });
  target.dispatchEvent(event);
};

interface FakeObserver {
  readonly observed: unknown[];
  disconnected: boolean;
}

const observers: FakeObserver[] = [];
const callbacks: (() => void)[] = [];
const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');

/** Installs a ResizeObserver whose reports this suite drives by hand. */
const installResizeObserver = (): void => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: class {
      readonly #record: FakeObserver = { observed: [], disconnected: false };
      constructor(callback: () => void) {
        callbacks.push(callback);
        observers.push(this.#record);
      }
      observe(target: unknown) {
        this.#record.observed.push(target);
      }
      disconnect() {
        this.#record.disconnected = true;
      }
    },
  });
};

/** Reports a size change through whichever mechanism the handle subscribed to. */
const remeasure = (): void => {
  for (const callback of callbacks) callback();
  window.dispatchEvent(new Event('resize'));
};

afterEach(() => {
  observers.length = 0;
  callbacks.length = 0;
  if (originalResizeObserver) Object.defineProperty(globalThis, 'ResizeObserver', originalResizeObserver);
  else Reflect.deleteProperty(globalThis, 'ResizeObserver');
});

describe('sidePaneWidthBounds', () => {
  it('never lets the pane eat the readable chat column', () => {
    expect(sidePaneWidthBounds(1_000)).toEqual({
      min: SIDE_PANE_MIN_WIDTH,
      max: 1_000 - SIDE_PANE_MIN_CHAT_WIDTH - SIDE_PANE_WORKSPACE_GAP,
    });
  });

  it('honours the absolute maximum once the workspace is wide enough', () => {
    expect(sidePaneWidthBounds(4_000).max).toBe(SIDE_PANE_MAX_WIDTH);
  });

  it('collapses to the minimum rather than inverting on a narrow workspace', () => {
    expect(sidePaneWidthBounds(300)).toEqual({ min: SIDE_PANE_MIN_WIDTH, max: SIDE_PANE_MIN_WIDTH });
  });
});

describe('sidePaneWidthFromPointer', () => {
  const bounds: SidePaneWidthBounds = { min: 320, max: 900 };

  it('widens the pane as the separator moves left, because the pane is on the right', () => {
    expect(sidePaneWidthFromPointer(520, 900, 800, bounds)).toBe(620);
    expect(sidePaneWidthFromPointer(520, 900, 1_000, bounds)).toBe(420);
  });

  it('clamps to the supplied bounds at both ends', () => {
    expect(sidePaneWidthFromPointer(520, 900, 2_000, bounds)).toBe(320);
    expect(sidePaneWidthFromPointer(520, 900, 0, bounds)).toBe(900);
  });
});

describe('sidePaneWidthFromKey', () => {
  const bounds: SidePaneWidthBounds = { min: 320, max: 900 };

  it('steps by one increment, and by a larger one with Shift', () => {
    expect(sidePaneWidthFromKey('ArrowLeft', 520, bounds)).toBe(520 + RESIZE_KEY_STEP);
    expect(sidePaneWidthFromKey('ArrowRight', 520, bounds)).toBe(520 - RESIZE_KEY_STEP);
    expect(sidePaneWidthFromKey('ArrowLeft', 520, bounds, true)).toBe(520 + RESIZE_KEY_LARGE_STEP);
  });

  it('jumps to the ends on Home and End', () => {
    expect(sidePaneWidthFromKey('Home', 520, bounds)).toBe(320);
    expect(sidePaneWidthFromKey('End', 520, bounds)).toBe(900);
  });

  it('leaves every other key to the browser', () => {
    expect(sidePaneWidthFromKey('Enter', 520, bounds)).toBeNull();
  });
});

describe('SidePaneResizeHandle', () => {
  it('is an accessible separator whose ARIA values track the observed workspace', async () => {
    installResizeObserver();
    const pane = await harness({ width: 520 });

    expect(pane.handle.getAttribute('role')).toBe('separator');
    expect(pane.handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(pane.handle.getAttribute('aria-label')).toBe('Resize session side pane');
    expect(pane.handle.getAttribute('aria-valuemin')).toBe(String(SIDE_PANE_MIN_WIDTH));
    expect(pane.handle.getAttribute('aria-valuemax')).toBe(String(SIDE_PANE_MAX_WIDTH));
    expect(pane.handle.getAttribute('aria-valuenow')).toBe('520');
    expect(pane.handle.getAttribute('aria-valuetext')).toContain('keep the conversation readable');
    expect(observers[0]?.observed).toEqual([pane.workspace]);

    await pane.unmount();

    expect(observers[0]?.disconnected).toBe(true);
  });

  it('re-reads the bounds when the workspace resizes, so ARIA never goes stale', async () => {
    installResizeObserver();
    const pane = await harness({ width: 900 });

    pane.resize(900, 700);
    await interact(() => remeasure());

    expect(pane.handle.getAttribute('aria-valuemax')).toBe(String(700 - SIDE_PANE_MIN_CHAT_WIDTH - 8));
    // The reported value is clamped into the bounds it is reported against.
    expect(pane.handle.getAttribute('aria-valuenow')).toBe(String(700 - SIDE_PANE_MIN_CHAT_WIDTH - 8));

    await pane.unmount();
  });

  it('falls back to window resize events where ResizeObserver is missing', async () => {
    Reflect.deleteProperty(globalThis, 'ResizeObserver');
    const pane = await harness();

    pane.resize(520, 800);
    await interact(() => remeasure());

    expect(pane.handle.getAttribute('aria-valuemax')).toBe(String(800 - SIDE_PANE_MIN_CHAT_WIDTH - 8));

    await pane.unmount();
    // The listener is removed on unmount: a later resize cannot set state on an
    // unmounted tree.
    window.dispatchEvent(new Event('resize'));
  });

  it('uses supplied bounds verbatim and then never observes anything', async () => {
    installResizeObserver();
    const pane = await harness({ width: 2_000, bounds: { min: 400, max: 600 } });

    expect(pane.handle.getAttribute('aria-valuemin')).toBe('400');
    expect(pane.handle.getAttribute('aria-valuemax')).toBe('600');
    expect(pane.handle.getAttribute('aria-valuenow')).toBe('600');
    expect(observers).toHaveLength(0);

    await pane.unmount();
  });

  it('previews the first drag motion immediately and commits exactly once at the end', async () => {
    installResizeObserver();
    const pane = await harness();

    await interact(() => {
      firePointer(pane.handle, 'pointerdown', { clientX: 900 });
      firePointer(pane.handle, 'pointermove', { clientX: 800 });
    });

    expect(pane.previews).toEqual([620]);
    expect(pane.commits).toEqual([]);

    await interact(() => firePointer(pane.handle, 'pointerup'));

    expect(pane.previews).toEqual([620, 620]);
    expect(pane.commits).toEqual([620]);

    await pane.unmount();
  });

  it('coalesces further motion behind the throttle instead of reflowing chat per event', async () => {
    installResizeObserver();
    const pane = await harness();

    await interact(() => {
      firePointer(pane.handle, 'pointerdown', { clientX: 900 });
      firePointer(pane.handle, 'pointermove', { clientX: 800 });
      firePointer(pane.handle, 'pointermove', { clientX: 790 });
      // Identical to the pending position: not motion, so nothing is scheduled.
      firePointer(pane.handle, 'pointermove', { clientX: 790 });
      firePointer(pane.handle, 'pointermove', { clientX: 780 });
    });

    expect(pane.previews).toEqual([620]);

    await interact(() => sleep(RESIZE_THROTTLE_MS + 20));

    // One coalesced frame carrying the LAST position, not one frame per event.
    expect(pane.previews).toEqual([620, 640]);

    await interact(() => firePointer(pane.handle, 'pointerup'));

    expect(pane.commits).toEqual([640]);

    await pane.unmount();
  });

  it('drops a coalesced frame belonging to a superseded drag', async () => {
    installResizeObserver();
    const pane = await harness();

    await interact(() => {
      firePointer(pane.handle, 'pointerdown', { clientX: 900 });
      firePointer(pane.handle, 'pointermove', { clientX: 800 });
      firePointer(pane.handle, 'pointermove', { clientX: 700 });
      // A second pointer takes over before the pending frame fires.
      firePointer(pane.handle, 'pointerdown', { pointerId: 2, clientX: 900 });
    });
    await interact(() => sleep(RESIZE_THROTTLE_MS + 20));

    expect(pane.previews).toEqual([620]);

    await pane.unmount();
  });

  it('ignores non-primary buttons, foreign pointer ids and a release with no drag', async () => {
    installResizeObserver();
    const pane = await harness();

    await interact(() => {
      firePointer(pane.handle, 'pointerup');
      firePointer(pane.handle, 'pointerdown', { clientX: 900, button: 2 });
      firePointer(pane.handle, 'pointermove', { clientX: 800 });
      firePointer(pane.handle, 'pointerdown', { clientX: 900 });
      firePointer(pane.handle, 'pointermove', { pointerId: 9, clientX: 800 });
    });

    expect(pane.previews).toEqual([]);

    // A press that never moved commits nothing at all.
    await interact(() => firePointer(pane.handle, 'pointerup'));

    expect(pane.previews).toEqual([]);
    expect(pane.commits).toEqual([]);

    await pane.unmount();
  });

  it('treats cancel and a lost capture as the end of the drag', async () => {
    installResizeObserver();
    const pane = await harness();

    await interact(() => {
      firePointer(pane.handle, 'pointerdown', { clientX: 900 });
      firePointer(pane.handle, 'pointermove', { clientX: 800 });
      firePointer(pane.handle, 'pointercancel');
    });

    expect(pane.commits).toEqual([620]);

    await interact(() => {
      firePointer(pane.handle, 'pointerdown', { clientX: 900 });
      firePointer(pane.handle, 'pointermove', { clientX: 850 });
      firePointer(pane.handle, 'lostpointercapture');
    });

    expect(pane.commits).toEqual([620, 570]);

    await pane.unmount();
  });

  it('abandons a pending frame when the pane unmounts mid-drag', async () => {
    installResizeObserver();
    const pane = await harness();

    await interact(() => {
      firePointer(pane.handle, 'pointerdown', { clientX: 900 });
      firePointer(pane.handle, 'pointermove', { clientX: 800 });
      firePointer(pane.handle, 'pointermove', { clientX: 700 });
    });
    await pane.unmount();
    await sleep(RESIZE_THROTTLE_MS + 20);

    expect(pane.previews).toEqual([620]);
  });

  it('commits one deliberate step per keyboard command and ignores other keys', async () => {
    installResizeObserver();
    const pane = await harness();

    await interact(() => {
      pane.handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
      pane.handle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true, shiftKey: true }),
      );
      pane.handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
    });

    expect(pane.previews).toEqual([
      SIDE_PANE_DEFAULT_WIDTH + RESIZE_KEY_STEP,
      SIDE_PANE_DEFAULT_WIDTH - RESIZE_KEY_LARGE_STEP,
    ]);
    expect(pane.commits).toEqual(pane.previews);

    await pane.unmount();
  });

  it('resets to the default width on a double-click', async () => {
    installResizeObserver();
    const pane = await harness({ width: 900 });

    await interact(() => pane.handle.dispatchEvent(new Event('dblclick', { bubbles: true, cancelable: true })));

    expect(pane.commits).toEqual([SIDE_PANE_DEFAULT_WIDTH]);

    await pane.unmount();
  });

  it('measures the unconstrained default when neither box reports a rectangle', async () => {
    installResizeObserver();
    const previews: number[] = [];
    const commits: number[] = [];
    const mounted = await mount(
      <div>
        <div>
          <SidePaneResizeHandle width={520} onPreview={w => previews.push(w)} onCommit={w => commits.push(w)} />
        </div>
      </div>,
    );
    const handle = mounted.container.querySelector('button') as HTMLButtonElement;
    const pane = handle.parentElement as HTMLElement;
    const workspace = pane.parentElement as HTMLElement;
    // A rectangle with no measurable width, as an unlaid-out box reports.
    pane.getBoundingClientRect = () => ({}) as DOMRect;
    workspace.getBoundingClientRect = () => ({}) as DOMRect;

    await interact(() =>
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })),
    );

    expect(commits).toEqual([SIDE_PANE_MAX_WIDTH]);

    await mounted.unmount();
  });
});
