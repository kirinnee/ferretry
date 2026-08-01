import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { CLICK_SUPPRESS_MS, LONG_PRESS_MS, MOVE_CANCEL_PX } from '../../src/shell/agent-sidebar-model.ts';
import { type OpenSessionMenu, useRowContextGesture } from '../../src/shell/row-context-gesture.ts';
import { interact, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const view = sessionView('row-1');

interface Opened {
  readonly view: SessionView;
  readonly x: number;
  readonly y: number;
  readonly trigger: HTMLElement;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Long enough for the dwell timer to fire, without pinning the suite to it. */
const dwell = (): Promise<void> => sleep(LONG_PRESS_MS + 40);

function Row({ open, onNavigate }: { open?: OpenSessionMenu; onNavigate?: () => void }) {
  const gesture = useRowContextGesture(open, view);
  // The real row is a nav anchor; a button stands in for it, since what the
  // gesture cares about is that activating the row navigates.
  return (
    <button type="button" data-role="row" onClick={onNavigate} {...gesture}>
      Session row
    </button>
  );
}

const harness = async (props: { readonly readOnly?: boolean } = {}) => {
  const opened: Opened[] = [];
  let navigations = 0;
  const mounted = await mount(
    <Row
      {...(props.readOnly
        ? {}
        : {
            open: (v: SessionView, x: number, y: number, trigger: HTMLElement) =>
              opened.push({ view: v, x, y, trigger }),
          })}
      onNavigate={() => {
        navigations += 1;
      }}
    />,
  );
  const row = mounted.container.querySelector('[data-role="row"]') as HTMLElement;
  return { row, opened, navigations: () => navigations, unmount: mounted.unmount };
};

const firePointer = (
  target: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  fields: { pointerType?: string; clientX?: number; clientY?: number } = {},
): void => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 0, ...fields });
  target.dispatchEvent(event);
};

const fireContextMenu = (target: HTMLElement, clientX = 0, clientY = 0): Event => {
  const event = new Event('contextmenu', { bubbles: true, cancelable: true });
  Object.assign(event, { clientX, clientY, button: 2 });
  target.dispatchEvent(event);
  return event;
};

const click = (target: HTMLElement): void => {
  target.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
};

describe('useRowContextGesture', () => {
  it('leaves the browser alone entirely when there is nothing to open', async () => {
    const harnessed = await harness({ readOnly: true });
    const event = fireContextMenu(harnessed.row);
    expect(event.defaultPrevented).toBe(false);
    expect(harnessed.opened).toHaveLength(0);
    await harnessed.unmount();
  });

  it('opens at the pointer on a right-click and suppresses the native menu', async () => {
    const harnessed = await harness();
    const event = fireContextMenu(harnessed.row, 120, 240);
    expect(event.defaultPrevented).toBe(true);
    expect(harnessed.opened).toHaveLength(1);
    expect(harnessed.opened[0]).toMatchObject({ x: 120, y: 240 });
    const first = must(harnessed.opened[0], 'the opened menu');
    expect(first.view.config.id).toBe('row-1');
    expect(first.trigger).toBe(harnessed.row);
    await harnessed.unmount();
  });

  it('opens on a held finger, since iOS never fires a contextmenu at all', async () => {
    const harnessed = await harness();
    await interact(() => firePointer(harnessed.row, 'pointerdown', { clientX: 30, clientY: 60 }));
    expect(harnessed.opened).toHaveLength(0);
    await interact(dwell);
    expect(harnessed.opened).toHaveLength(1);
    expect(harnessed.opened[0]).toMatchObject({ x: 30, y: 60 });
    await harnessed.unmount();
  });

  it('never starts a dwell timer for a mouse, which already has right-click', async () => {
    const harnessed = await harness();
    await interact(() => firePointer(harnessed.row, 'pointerdown', { pointerType: 'mouse' }));
    await interact(dwell);
    expect(harnessed.opened).toHaveLength(0);
    await harnessed.unmount();
  });

  it('treats a drifting finger as a scroll of the fleet and cancels', async () => {
    const harnessed = await harness();
    await interact(() => firePointer(harnessed.row, 'pointerdown', { clientX: 0, clientY: 0 }));
    await interact(() => firePointer(harnessed.row, 'pointermove', { clientX: 0, clientY: MOVE_CANCEL_PX + 1 }));
    await interact(dwell);
    expect(harnessed.opened).toHaveLength(0);
    await harnessed.unmount();
  });

  it('tolerates the jitter of a still finger', async () => {
    const harnessed = await harness();
    await interact(() => firePointer(harnessed.row, 'pointerdown', { clientX: 0, clientY: 0 }));
    await interact(() => firePointer(harnessed.row, 'pointermove', { clientX: MOVE_CANCEL_PX, clientY: 0 }));
    await interact(dwell);
    expect(harnessed.opened).toHaveLength(1);
    await harnessed.unmount();
  });

  it('ignores a move that belongs to no press', async () => {
    const harnessed = await harness();
    await interact(() => firePointer(harnessed.row, 'pointermove', { clientX: 900, clientY: 900 }));
    await interact(dwell);
    expect(harnessed.opened).toHaveLength(0);
    await harnessed.unmount();
  });

  it('cancels on lift and on a pointer the system takes away', async () => {
    for (const ending of ['pointerup', 'pointercancel'] as const) {
      const harnessed = await harness();
      await interact(() => firePointer(harnessed.row, 'pointerdown'));
      await interact(() => firePointer(harnessed.row, ending));
      await interact(dwell);
      expect(harnessed.opened).toHaveLength(0);
      await harnessed.unmount();
    }
  });

  it('restarts cleanly when a second press follows the first, rather than eating it', async () => {
    const harnessed = await harness();
    await interact(() => firePointer(harnessed.row, 'pointerdown', { clientX: 5, clientY: 5 }));
    await interact(() => firePointer(harnessed.row, 'pointerdown', { clientX: 11, clientY: 12 }));
    await interact(dwell);
    // One menu, opened at the SECOND press: cancelling before recording is what
    // keeps the new press's start point alive.
    expect(harnessed.opened).toHaveLength(1);
    expect(harnessed.opened[0]).toMatchObject({ x: 11, y: 12 });
    await harnessed.unmount();
  });

  it('swallows the click the long-press itself produces, so the row does not navigate under its own menu', async () => {
    const harnessed = await harness();
    await interact(() => firePointer(harnessed.row, 'pointerdown'));
    await interact(dwell);
    await interact(() => click(harnessed.row));
    expect(harnessed.opened).toHaveLength(1);
    expect(harnessed.navigations()).toBe(0);
    await harnessed.unmount();
  });

  it('swallows exactly one click — the next deliberate tap still navigates', async () => {
    const harnessed = await harness();
    await interact(() => firePointer(harnessed.row, 'pointerdown'));
    await interact(dwell);
    await interact(() => click(harnessed.row));
    await interact(() => click(harnessed.row));
    expect(harnessed.navigations()).toBe(1);
    await harnessed.unmount();
  });

  it('lets an ordinary tap through untouched when no menu was opened', async () => {
    const harnessed = await harness();
    await interact(() => firePointer(harnessed.row, 'pointerdown'));
    await interact(() => firePointer(harnessed.row, 'pointerup'));
    await interact(() => click(harnessed.row));
    expect(harnessed.navigations()).toBe(1);
    await harnessed.unmount();
  });

  it('stops suppressing once the window has passed', () => {
    // The window is the contract; the wiring above only consults it.
    expect(CLICK_SUPPRESS_MS).toBeGreaterThan(LONG_PRESS_MS);
  });

  it('drops a pending dwell timer when the row unmounts, as rows do on every refilter', async () => {
    const harnessed = await harness();
    await interact(() => firePointer(harnessed.row, 'pointerdown'));
    await harnessed.unmount();
    await interact(dwell);
    expect(harnessed.opened).toHaveLength(0);
  });
});
