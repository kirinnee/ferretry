import { describe, expect, it } from 'bun:test';
import { AgentControlMarker } from '../../../src/features/workspace/agent-control-marker.tsx';
import {
  DIVIDER_THROTTLE_MS,
  dividerValueFromKey,
  RailDivider,
  SplitDivider,
  type SplitDividerProps,
} from '../../../src/features/workspace/split-divider.tsx';
import { WORKSPACE_RAIL_BOUNDS } from '../../../src/lib/workspace-rail-preferences.ts';
import { interact, mount, must, pressKey } from '../../support/dom.ts';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const firePointer = (
  target: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture',
  fields: { pointerId?: number; clientX?: number; clientY?: number; button?: number } = {},
): void => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, clientX: 0, clientY: 0, button: 0, ...fields });
  target.dispatchEvent(event);
};

interface Harness {
  readonly handle: HTMLButtonElement;
  readonly previews: number[];
  readonly commits: number[];
  readonly unmount: () => Promise<void>;
}

const harness = async (
  props: Partial<SplitDividerProps> = {},
  size = { width: 1000, height: 500 },
): Promise<Harness> => {
  const previews: number[] = [];
  const commits: number[] = [];
  const mounted = await mount(
    <div>
      <SplitDivider
        axis="row"
        unit="ratio"
        value={0.5}
        min={0.15}
        max={0.85}
        defaultValue={0.5}
        step={0.02}
        label="Resize panes"
        onPreview={value => previews.push(value)}
        onCommit={value => commits.push(value)}
        {...props}
      />
    </div>,
  );
  const handle = must(mounted.container.querySelector<HTMLButtonElement>('[role="separator"]'), 'separator');
  (handle.parentElement as HTMLElement).getBoundingClientRect = () => size as DOMRect;
  let captured: number | null = null;
  handle.setPointerCapture = (pointerId: number) => {
    captured = pointerId;
  };
  handle.hasPointerCapture = (pointerId: number) => captured === pointerId;
  handle.releasePointerCapture = () => {
    captured = null;
  };
  return { handle, previews, commits, unmount: mounted.unmount };
};

describe('dividerValueFromKey', () => {
  const base = { axis: 'row' as const, value: 0.5, min: 0.2, max: 0.8, step: 0.1 };
  it('moves along the axis and clamps', () => {
    expect(dividerValueFromKey('ArrowRight', base, false)).toBeCloseTo(0.6);
    expect(dividerValueFromKey('ArrowLeft', base, false)).toBeCloseTo(0.4);
    expect(dividerValueFromKey('ArrowRight', base, true)).toBe(0.8);
    expect(dividerValueFromKey('ArrowDown', base, false)).toBeNull();
    expect(dividerValueFromKey('ArrowDown', { ...base, axis: 'column' }, false)).toBeCloseTo(0.6);
    expect(dividerValueFromKey('ArrowUp', { ...base, axis: 'column' }, false)).toBeCloseTo(0.4);
    expect(dividerValueFromKey('ArrowRight', { ...base, inverted: true }, false)).toBeCloseTo(0.4);
    expect(dividerValueFromKey('Home', base, false)).toBe(0.2);
    expect(dividerValueFromKey('End', base, false)).toBe(0.8);
    expect(dividerValueFromKey('Enter', base, false)).toBeNull();
  });
});

describe('SplitDivider', () => {
  it('exposes the window-splitter semantics as percentages for a ratio', async () => {
    const { handle, unmount } = await harness({ value: 0.95 });
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-valuenow')).toBe('85');
    expect(handle.getAttribute('aria-valuemin')).toBe('15');
    expect(handle.getAttribute('aria-valuemax')).toBe('85');
    expect(handle.getAttribute('aria-valuetext')).toBe('85% and 15%');
    expect(handle.className).toBe('fy-ws-divider');
    await unmount();
  });

  it('commits one step per key and ignores other keys', async () => {
    const { handle, previews, commits, unmount } = await harness({ axis: 'column' });
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
    await interact(() => pressKey(handle, 'ArrowDown'));
    await interact(() => pressKey(handle, 'x'));
    expect(commits).toHaveLength(1);
    expect(commits[0]).toBeCloseTo(0.52);
    expect(previews).toEqual(commits);
    await unmount();
  });

  it('resets on double-click', async () => {
    const { handle, commits, unmount } = await harness({ value: 0.3 });
    await interact(() => handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(commits).toEqual([0.5]);
    await unmount();
  });

  it('previews a drag throttled and commits once at the end', async () => {
    const { handle, previews, commits, unmount } = await harness();
    await interact(() => firePointer(handle, 'pointerdown', { clientX: 500 }));
    await interact(() => firePointer(handle, 'pointermove', { clientX: 600 }));
    expect(previews).toEqual([0.6]);
    await interact(() => firePointer(handle, 'pointermove', { clientX: 650 }));
    await interact(() => firePointer(handle, 'pointermove', { clientX: 700 }));
    // Same value again: nothing new to preview.
    await interact(() => firePointer(handle, 'pointermove', { clientX: 700 }));
    // A foreign pointer is ignored.
    await interact(() => firePointer(handle, 'pointermove', { clientX: 900, pointerId: 2 }));
    expect(previews).toEqual([0.6]);
    await interact(() => sleep(DIVIDER_THROTTLE_MS + 20));
    expect(previews).toEqual([0.6, 0.7]);
    await interact(() => sleep(DIVIDER_THROTTLE_MS + 5));
    await interact(() => firePointer(handle, 'pointermove', { clientX: 750 }));
    expect(previews).toEqual([0.6, 0.7, 0.75]);
    await interact(() => firePointer(handle, 'pointermove', { clientX: 760 }));
    await interact(() => firePointer(handle, 'pointerup', { clientX: 760 }));
    expect(commits).toEqual([0.76]);
    expect(previews.at(-1)).toBe(0.76);
    // A second finish for the same pointer is inert.
    await interact(() => firePointer(handle, 'lostpointercapture'));
    expect(commits).toHaveLength(1);
    await unmount();
  });

  it('a click without motion commits nothing; cancel ends a drag', async () => {
    const { handle, commits, unmount } = await harness();
    await interact(() => firePointer(handle, 'pointerdown', { clientX: 500 }));
    await interact(() => firePointer(handle, 'pointercancel', { pointerId: 2 }));
    await interact(() => firePointer(handle, 'pointercancel'));
    expect(commits).toEqual([]);
    await interact(() => firePointer(handle, 'pointermove', { clientX: 900 }));
    expect(commits).toEqual([]);
    await unmount();
  });

  it('ignores a secondary button and an unmeasurable container', async () => {
    const { handle, previews, unmount } = await harness({}, { width: 0, height: 0 });
    await interact(() => firePointer(handle, 'pointerdown', { button: 2 }));
    await interact(() => firePointer(handle, 'pointerdown', { clientX: 500 }));
    await interact(() => firePointer(handle, 'pointermove', { clientX: 900 }));
    expect(previews).toEqual([]);
    await unmount();
  });

  it('measures a column split by height, a pixel value directly, and an inverted drag', async () => {
    const column = await harness({ axis: 'column' }, { width: 1000, height: 200 });
    await interact(() => firePointer(column.handle, 'pointerdown', { clientY: 100 }));
    await interact(() => firePointer(column.handle, 'pointermove', { clientY: 120 }));
    expect(column.previews).toEqual([0.6]);
    await column.unmount();

    const px = await harness({ unit: 'px', value: 300, min: 200, max: 500, inverted: true, className: 'extra' });
    expect(px.handle.className).toBe('fy-ws-divider extra');
    expect(px.handle.getAttribute('aria-valuetext')).toBe('300 pixels');
    await interact(() => firePointer(px.handle, 'pointerdown', { clientX: 100 }));
    await interact(() => firePointer(px.handle, 'pointermove', { clientX: 60 }));
    expect(px.previews).toEqual([340]);
    await px.unmount();
  });

  it('works without a parent and clears a pending preview on unmount', async () => {
    const lone = await mount(
      <SplitDivider
        axis="row"
        unit="ratio"
        value={0.5}
        min={0.1}
        max={0.9}
        defaultValue={0.5}
        step={0.1}
        label="x"
        onPreview={() => undefined}
        onCommit={() => undefined}
      />,
    );
    const handle = must(lone.container.querySelector<HTMLElement>('[role="separator"]'), 'separator');
    lone.container.remove();
    await interact(() => firePointer(handle, 'pointerdown'));
    await lone.unmount();

    const { handle: live, previews, unmount } = await harness();
    await interact(() => firePointer(live, 'pointerdown', { clientX: 500 }));
    await interact(() => firePointer(live, 'pointermove', { clientX: 600 }));
    await interact(() => firePointer(live, 'pointermove', { clientX: 650 }));
    await unmount();
    await sleep(DIVIDER_THROTTLE_MS + 20);
    expect(previews).toEqual([0.6]);
  });

  it('drops a stale timer whose drag already ended', async () => {
    const { handle, previews, unmount } = await harness();
    await interact(() => firePointer(handle, 'pointerdown', { clientX: 500 }));
    await interact(() => firePointer(handle, 'pointermove', { clientX: 600 }));
    await interact(() => firePointer(handle, 'pointermove', { clientX: 650 }));
    await interact(() => firePointer(handle, 'pointerup'));
    await interact(() => sleep(DIVIDER_THROTTLE_MS + 20));
    expect(previews).toEqual([0.6, 0.65]);
    await unmount();
  });
});

describe('RailDivider', () => {
  it('drives the left rail width', async () => {
    const commits: number[] = [];
    const mounted = await mount(
      <div>
        <RailDivider side="left" width={9999} onPreview={() => undefined} onCommit={value => commits.push(value)} />
      </div>,
    );
    const handle = must(mounted.container.querySelector<HTMLElement>('[role="separator"]'), 'separator');
    expect(handle.getAttribute('aria-label')).toBe('Resize agents rail');
    expect(handle.getAttribute('aria-valuenow')).toBe(String(WORKSPACE_RAIL_BOUNDS.left.max));
    await interact(() => pressKey(handle, 'ArrowLeft'));
    expect(commits).toEqual([WORKSPACE_RAIL_BOUNDS.left.max - 16]);
    await mounted.unmount();
  });

  it('grows the right rail as its edge moves left', async () => {
    const commits: number[] = [];
    const mounted = await mount(
      <div>
        <RailDivider side="right" width={320} onPreview={() => undefined} onCommit={value => commits.push(value)} />
      </div>,
    );
    const handle = must(mounted.container.querySelector<HTMLElement>('[role="separator"]'), 'separator');
    expect(handle.getAttribute('aria-label')).toBe('Resize context rail');
    expect(handle.className).toContain('fy-ws-rail-divider--right');
    await interact(() => pressKey(handle, 'ArrowLeft'));
    expect(commits).toEqual([336]);
    await mounted.unmount();
  });
});

describe('AgentControlMarker', () => {
  it('renders nothing when nobody drives', async () => {
    const mounted = await mount(
      <AgentControlMarker driver={null} takenOver={false} onTakeOver={() => undefined} onHandBack={() => undefined} />,
    );
    expect(mounted.container.innerHTML).toBe('');
    await mounted.unmount();
  });

  it('names the driving agent and offers Take over', async () => {
    let took = 0;
    const mounted = await mount(
      <AgentControlMarker
        driver={{ name: 'Hadi' }}
        takenOver={false}
        onTakeOver={() => {
          took += 1;
        }}
        onHandBack={() => undefined}
      />,
    );
    const status = must(mounted.container.querySelector('[role="status"]'), 'status');
    expect(status.textContent).toContain('Hadi is typing here');
    expect(status.getAttribute('data-state')).toBe('agent');
    await interact(() => (status.querySelector('button') as HTMLButtonElement).click());
    expect(took).toBe(1);
    await mounted.unmount();
  });

  it('offers Hand back once taken over', async () => {
    let handed = 0;
    const mounted = await mount(
      <AgentControlMarker
        driver={{ name: 'Hadi' }}
        takenOver
        onTakeOver={() => undefined}
        onHandBack={() => {
          handed += 1;
        }}
      />,
    );
    const status = must(mounted.container.querySelector('[role="status"]'), 'status');
    expect(status.textContent).toContain('You have control');
    const hand = must(status.querySelector<HTMLButtonElement>('button[aria-label="Hand back"]'), 'Hand back');
    expect(hand.title).toContain('Hand back');
    await interact(() => hand.click());
    expect(handed).toBe(1);
    await mounted.unmount();
  });
});

describe('AgentControlMarker — an ask', () => {
  it('says "Your turn here" with the agent\'s message, and offers Take over and Dismiss', async () => {
    const taps: string[] = [];
    const mounted = await mount(
      <AgentControlMarker
        driver={null}
        takenOver={false}
        ask={{ agent: 'Hadi', message: 'Type the sudo password' }}
        onTakeOver={() => taps.push('take')}
        onHandBack={() => undefined}
        onDismissAsk={() => taps.push('dismiss')}
      />,
    );
    const status = must(mounted.container.querySelector('[role="status"]'), 'status');
    expect(status.getAttribute('data-state')).toBe('ask');
    expect(status.querySelector('.fy-ws-marker-chip')?.textContent).toBe('Your turn here');
    const note = must(status.querySelector('.fy-ws-marker-note'), 'note');
    expect(note.textContent).toBe('Type the sudo password');
    expect(note.getAttribute('title')).toBe('Type the sudo password');
    const buttons = [...status.querySelectorAll('button')];
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['Take over', 'Dismiss']);
    expect(buttons.every(button => (button.getAttribute('title') ?? '').length > 0)).toBe(true);
    await interact(() => (buttons[0] as HTMLButtonElement).click());
    await interact(() => (buttons[1] as HTMLButtonElement).click());
    expect(taps).toEqual(['take', 'dismiss']);
    await mounted.unmount();
  });

  it('names the agent when it left no message, and omits Dismiss when it cannot dismiss', async () => {
    const mounted = await mount(
      <AgentControlMarker
        driver={null}
        takenOver={false}
        ask={{ agent: 'Hadi' }}
        onTakeOver={() => undefined}
        onHandBack={() => undefined}
      />,
    );
    const status = must(mounted.container.querySelector('[role="status"]'), 'status');
    expect(status.querySelector('.fy-ws-marker-note')?.textContent).toBe('Hadi needs you');
    expect(status.querySelectorAll('button')).toHaveLength(1);
    await mounted.unmount();
  });
});
