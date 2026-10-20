import { afterEach, describe, expect, test } from 'bun:test';
import { type AllMachinesView, allMachinesView, type MachineSource } from '../../src/lib/all-machines.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { LIFT_MS } from '../../src/shell/machine-reorder-model.ts';
import { SessionsBarMachines } from '../../src/shell/sessions-bar-machines.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../support/dom.ts';

const [A, B, C] = ['alpha', 'beta', 'gamma'] as DaemonId[] as [DaemonId, DaemonId, DaemonId];
const NAMES = new Map<DaemonId, string>([
  [A, 'Mac'],
  [B, 'Box'],
  [C, 'Pi'],
]);

const source = (daemonId: DaemonId): MachineSource => ({
  daemonId,
  name: NAMES.get(daemonId) ?? String(daemonId),
  reach: 'online',
  projects: [],
  slice: { sessions: [], byId: new Map(), status: 'ready', error: null },
});
const viewOf = (...machines: DaemonId[]): AllMachinesView => allMachinesView(machines.map(source));

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  for (const menu of document.querySelectorAll('[role="menu"]')) menu.remove();
});

type Move = readonly [string, string, string];

interface Rig {
  readonly moves: Move[];
  readonly list: HTMLElement;
  readonly groups: () => HTMLElement[];
  readonly grip: (id: DaemonId) => HTMLElement;
  readonly order: () => string[];
  readonly live: () => string;
}

const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top });

const bar = (view: AllMachinesView, moves: Move[], movable = true, list = true) => {
  const body = (
    <SessionsBarMachines
      activeSessionId={null}
      daemonId={A}
      now={0}
      onNavigate={() => undefined}
      view={view}
      {...(movable ? { onMoveMachine: (id, target, edge) => moves.push([id, target, edge]) } : {})}
    />
  );
  return list ? <div className="fy-sbar__list">{body}</div> : body;
};

const open = async (view: AllMachinesView = viewOf(A, B, C), movable = true, list = true): Promise<Rig> => {
  const moves: Move[] = [];
  mounted = await mount(bar(view, moves, movable, list));
  const root = mounted.container;
  const listEl = must(root.querySelector<HTMLElement>('.fy-sbar__list') ?? root, 'the list');
  const groups = () => [...root.querySelectorAll<HTMLElement>('[data-sbar-machine-group]')];
  // Three headings 100px tall, stacked from 0, as a layout engine would give them.
  const stack = () => {
    groups().forEach((group, index) => {
      group.getBoundingClientRect = () => rect(index * 100, index * 100 + 100) as DOMRect;
    });
    listEl.getBoundingClientRect = () => rect(0, 300) as DOMRect;
  };
  stack();
  return {
    moves,
    list: listEl,
    groups,
    grip: id => must(root.querySelector<HTMLElement>(`[data-machine-grip="${id}"]`), `the grip for ${id}`),
    order: () => groups().map(group => group.dataset.sbarMachineGroup ?? ''),
    live: () => root.querySelector('[role="status"]')?.textContent ?? '',
  };
};

const pointer = (type: string, init: PointerEventInit & { clientX?: number; clientY?: number }): PointerEvent =>
  new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', ...init });

const down = (grip: HTMLElement, init: PointerEventInit = {}) =>
  interact(() => grip.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 150, ...init })));
const moveTo = (y: number, x = 10) =>
  interact(() => window.dispatchEvent(pointer('pointermove', { clientX: x, clientY: y })));
const release = () => interact(() => window.dispatchEvent(pointer('pointerup', {})));
const wait = (ms: number) => interact(() => new Promise(resolve => setTimeout(resolve, ms)));

describe('the grips', () => {
  test('sit on every machine heading, with a menu beside each', async () => {
    const rig = await open();
    expect(rig.groups().map(group => group.querySelector('[data-machine-grip]') !== null)).toEqual([true, true, true]);
    expect(rig.grip(A).getAttribute('aria-label')).toBe('Reorder Mac');
    expect(rig.grip(A).getAttribute('aria-pressed')).toBe('false');
    expect(mounted?.container.querySelector('[aria-label="More for Pi"]')).not.toBeNull();
  });

  test('are absent for one machine, or when nothing can reorder', async () => {
    expect((await open(viewOf(A))).groups()[0]?.querySelector('[data-machine-grip]')).toBeNull();
    await mounted?.unmount();
    expect((await open(viewOf(A, B), false)).groups()[0]?.querySelector('[data-machine-grip]')).toBeNull();
  });
});

describe('dragging with a mouse', () => {
  test('shows where it lands, changes nothing on screen, and moves once on release', async () => {
    const rig = await open();
    await down(rig.grip(A));
    await moveTo(250);
    expect(rig.groups()[0]?.hasAttribute('data-dragging')).toBe(true);
    expect(rig.groups()[2]?.getAttribute('data-drop-edge')).toBe('after');
    expect(rig.order()).toEqual([A, B, C]);
    await moveTo(120);
    expect(rig.groups()[1]?.getAttribute('data-drop-edge')).toBe('before');
    expect(rig.groups()[2]?.hasAttribute('data-drop-edge')).toBe(false);
    await moveTo(290);
    await release();
    expect(rig.moves).toEqual([[A, C, 'after']]);
    expect(
      rig.groups().some(group => group.hasAttribute('data-dragging') || group.hasAttribute('data-drop-edge')),
    ).toBe(false);
  });

  test('never reorders on a click, or on a wobble inside the slop', async () => {
    const rig = await open();
    await down(rig.grip(B));
    await moveTo(153, 12);
    await release();
    await interact(() => rig.grip(B).click());
    expect(rig.moves).toEqual([]);
    expect(rig.groups().some(group => group.hasAttribute('data-dragging'))).toBe(false);
  });

  test('ignores a secondary button', async () => {
    const rig = await open();
    await down(rig.grip(A), { button: 2 });
    await moveTo(250);
    expect(rig.groups()[0]?.hasAttribute('data-dragging')).toBe(false);
  });

  test('is cancelled by Escape or by the browser taking the pointer', async () => {
    const rig = await open();
    await down(rig.grip(A));
    await moveTo(250);
    await interact(() => pressKey(window, 'Escape'));
    await release();
    expect(rig.moves).toEqual([]);
    expect(rig.groups()[0]?.hasAttribute('data-dragging')).toBe(false);
    await down(rig.grip(A));
    await moveTo(250);
    await interact(() => window.dispatchEvent(pointer('pointercancel', {})));
    await release();
    await interact(() => pressKey(window, 'a'));
    expect(rig.moves).toEqual([]);
  });

  test('a second press replaces an unfinished one', async () => {
    const rig = await open();
    await down(rig.grip(A));
    await down(rig.grip(B));
    await moveTo(5);
    await release();
    expect(rig.moves).toEqual([[B, A, 'before']]);
  });

  test('scrolls the list while the pointer holds near its edge, and re-aims', async () => {
    const rig = await open();
    await down(rig.grip(A));
    await moveTo(298);
    await wait(60);
    expect(rig.list.scrollTop).toBeGreaterThan(0);
    await release();
  });

  test('stops its frame loop when the machines unmount mid-drag', async () => {
    const rig = await open();
    await down(rig.grip(A));
    await moveTo(100);
    await mounted?.unmount();
    mounted = null;
    expect(rig.moves).toEqual([]);
  });

  test('without a scroll list around it, finds no target and moves nothing', async () => {
    const rig = await open(viewOf(A, B, C), true, false);
    await down(rig.grip(A));
    await moveTo(250);
    await wait(40);
    await release();
    expect(rig.moves).toEqual([]);
  });
});

describe('dragging with a finger', () => {
  test('lifts after a rest on the grip and then follows the finger', async () => {
    const rig = await open();
    await down(rig.grip(C), { pointerType: 'touch' });
    expect(rig.groups()[2]?.hasAttribute('data-dragging')).toBe(false);
    await wait(LIFT_MS + 50);
    expect(rig.groups()[2]?.hasAttribute('data-dragging')).toBe(true);
    await moveTo(20);
    await release();
    expect(rig.moves).toEqual([[C, A, 'before']]);
  });

  test('is a scroll, not a lift, when the finger moves before the rest is over', async () => {
    const rig = await open();
    await down(rig.grip(C), { pointerType: 'touch' });
    await moveTo(60);
    await wait(LIFT_MS + 50);
    expect(rig.groups()[2]?.hasAttribute('data-dragging')).toBe(false);
    await release();
    expect(rig.moves).toEqual([]);
  });

  test('is nothing when the finger lifts before the rest is over', async () => {
    const rig = await open();
    await down(rig.grip(C), { pointerType: 'touch' });
    await release();
    await wait(LIFT_MS + 50);
    expect(rig.groups()[2]?.hasAttribute('data-dragging')).toBe(false);
    expect(rig.moves).toEqual([]);
  });
});

describe('the keyboard', () => {
  test('picks up with Space, moves with the arrows, drops with Space — and says each step', async () => {
    const rig = await open();
    rig.grip(A).focus();
    await interact(() => pressKey(rig.grip(A), ' '));
    expect(rig.grip(A).getAttribute('aria-pressed')).toBe('true');
    expect(rig.live()).toContain('Picked up Mac, position 1 of 3.');
    await interact(() => pressKey(rig.grip(A), 'ArrowDown'));
    expect(rig.order()).toEqual([B, A, C]);
    expect(rig.live()).toBe('Mac moved to position 2 of 3.');
    expect(document.activeElement).toBe(rig.grip(A));
    await interact(() => pressKey(rig.grip(A), 'ArrowDown'));
    await interact(() => pressKey(rig.grip(A), 'ArrowDown'));
    expect(rig.live()).toBe('Mac moved to position 3 of 3.');
    expect(rig.order()).toEqual([B, C, A]);
    await interact(() => pressKey(rig.grip(A), 'ArrowUp'));
    expect(rig.order()).toEqual([B, A, C]);
    await interact(() => pressKey(rig.grip(A), ' '));
    expect(rig.moves).toEqual([[A, B, 'after']]);
    expect(rig.live()).toBe('Dropped Mac at position 2 of 3.');
    expect(rig.grip(A).getAttribute('aria-pressed')).toBe('false');
  });

  test('drops at the very top as "before the next machine"', async () => {
    const rig = await open();
    rig.grip(C).focus();
    await interact(() => pressKey(rig.grip(C), ' '));
    await interact(() => pressKey(rig.grip(C), 'ArrowUp'));
    await interact(() => pressKey(rig.grip(C), 'ArrowUp'));
    await interact(() => pressKey(rig.grip(C), 'ArrowUp'));
    expect(rig.live()).toBe('Pi moved to position 1 of 3.');
    await interact(() => pressKey(rig.grip(C), ' '));
    expect(rig.moves).toEqual([[C, A, 'before']]);
  });

  test('Escape puts it back and says so; so does leaving the grip', async () => {
    const rig = await open();
    rig.grip(B).focus();
    await interact(() => pressKey(rig.grip(B), ' '));
    await interact(() => pressKey(rig.grip(B), 'ArrowDown'));
    await interact(() => pressKey(rig.grip(B), 'Escape'));
    expect(rig.order()).toEqual([A, B, C]);
    expect(rig.live()).toBe('Reorder cancelled. Box is back at position 2 of 3.');
    await interact(() => pressKey(rig.grip(B), ' '));
    await interact(() => rig.grip(B).dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(rig.grip(B).getAttribute('aria-pressed')).toBe('false');
    expect(rig.moves).toEqual([]);
  });

  test('drops where it started without moving anything', async () => {
    const rig = await open();
    rig.grip(B).focus();
    await interact(() => pressKey(rig.grip(B), ' '));
    await interact(() => pressKey(rig.grip(B), ' '));
    expect(rig.moves).toEqual([]);
    expect(rig.live()).toBe('Dropped Box at position 2 of 3.');
  });

  test('ignores other keys, and a blur that is not the held machine', async () => {
    const rig = await open();
    rig.grip(B).focus();
    await interact(() => pressKey(rig.grip(B), 'a'));
    expect(rig.grip(B).getAttribute('aria-pressed')).toBe('false');
    await interact(() => pressKey(rig.grip(B), ' '));
    await interact(() => pressKey(rig.grip(B), 'a'));
    await interact(() => rig.grip(A).dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(rig.grip(B).getAttribute('aria-pressed')).toBe('true');
  });

  test('survives the machine it holds going away', async () => {
    const rig = await open();
    rig.grip(B).focus();
    await interact(() => pressKey(rig.grip(B), ' '));
    await mounted?.render(bar(viewOf(A, C), rig.moves));
    expect(rig.groups().map(group => group.dataset.sbarMachineGroup)).toEqual([A, C]);
  });
});

describe('the heading menu', () => {
  const openMenu = async (name: string) => {
    const more = must(
      mounted?.container.querySelector<HTMLElement>(`[aria-label="More for ${name}"]`),
      'the menu button',
    );
    await interact(() => more.click());
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  };

  test('moves a machine up or down and says where it went', async () => {
    const rig = await open();
    const items = await openMenu('Box');
    expect(items.map(item => item.textContent)).toEqual(['Move up', 'Move down']);
    await interact(() => items[1]?.click());
    expect(rig.moves).toEqual([[B, C, 'after']]);
    expect(rig.live()).toBe('Box moved to position 3 of 3.');
    const again = await openMenu('Box');
    await interact(() => again[0]?.click());
    expect(rig.moves.at(-1)).toEqual([B, A, 'before']);
  });

  test('cannot move the first machine up nor the last down', async () => {
    const rig = await open();
    const first = await openMenu('Mac');
    expect(first.map(item => item.getAttribute('aria-disabled') ?? item.hasAttribute('disabled'))).toEqual([
      true,
      false,
    ]);
    await interact(() => first[0]?.click());
    await interact(() => pressKey(document, 'Escape'));
    const last = await openMenu('Pi');
    expect(last.map(item => item.getAttribute('aria-disabled') ?? item.hasAttribute('disabled'))).toEqual([
      false,
      true,
    ]);
    await interact(() => last[1]?.click());
    expect(rig.moves).toEqual([]);
  });
});
