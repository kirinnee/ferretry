import { afterEach, describe, expect, it } from 'bun:test';
import { Copy, Plug, RotateCw, Server } from 'lucide-react';
import { ContextActionsMenu } from '../../../../src/features/session-actions/context-actions-menu.tsx';
import type { SessionActionFormHost, SessionActionSection } from '../../../../src/features/session-actions/registry.ts';
import { interact, type Mounted, mount, must, pressKey } from '../../../support/dom.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

interface Log {
  readonly ran: string[];
  readonly closes: boolean[];
  readonly failures: string[];
  readonly notices: string[];
}

const form = (host: SessionActionFormHost) => (
  <div data-form="A">
    <p>{`Compact: ${host.compact}`}</p>
    <button data-notify="" onClick={() => host.notify('A settled')} type="button">
      Notify
    </button>
    <button data-reopen="" onClick={() => host.open('formA')} type="button">
      Reopen
    </button>
    <button data-done="" onClick={host.close} type="button">
      Done
    </button>
  </div>
);

const sections = (log: Log): SessionActionSection[] => [
  {
    group: 'session',
    label: 'Session',
    entries: [
      { kind: 'run', id: 'open', label: 'Open', icon: Copy, run: () => void log.ran.push('open') },
      {
        kind: 'run',
        id: 'boom',
        label: 'Boom',
        icon: Copy,
        run: () => {
          throw new Error('kaboom');
        },
      },
      { kind: 'form', id: 'formA', label: 'Rename…', title: 'Rename Hadi', icon: Plug, render: form },
      {
        kind: 'form',
        id: 'listB',
        label: '7 resolved',
        title: 'Resolved Attention',
        heading: 'Resolved · 7',
        presentation: 'drawer',
        icon: Plug,
        render: form,
      },
    ],
  },
  {
    group: 'move',
    label: 'Move',
    entries: [
      {
        kind: 'run',
        id: 'later',
        label: 'Later',
        icon: Server,
        unavailable: 'later',
        run: () => void log.ran.push('later'),
      },
    ],
  },
  {
    group: 'danger',
    label: 'Danger',
    entries: [
      {
        kind: 'confirm',
        id: 'restart',
        label: 'Restart CLI',
        icon: RotateCw,
        question: 'Restart Hadi’s CLI?',
        consequence: 'It relaunches.',
        confirmLabel: 'Restart',
        run: () => void log.ran.push('restart'),
      },
    ],
  },
];

const show = async (options: { touch?: boolean; x?: number; y?: number } = {}) => {
  const log: Log = { ran: [], closes: [], failures: [], notices: [] };
  mounted = await mount(
    <ContextActionsMenu
      anchor={{ x: options.x ?? 120, y: options.y ?? 80 }}
      name="Hadi"
      onClose={restore => log.closes.push(restore)}
      onFailure={sentence => log.failures.push(sentence)}
      onNotice={sentence => log.notices.push(sentence)}
      sections={sections(log)}
      touch={options.touch ?? false}
    />,
  );
  return { log, root: mounted.container };
};

/** A real tap begins with a press; the sheet swallows only the click of the finger that opened it. */
const tap = async (target: HTMLElement): Promise<void> => {
  await interact(() => target.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  await interact(() => target.click());
};

const menu = (root: HTMLElement): HTMLElement => must(root.querySelector('[role="menu"]'), 'menu');
const row = (root: HTMLElement, id: string): HTMLElement =>
  must(root.querySelector(`[data-session-action-item="${id}"]`), `row ${id}`);

describe('ContextActionsMenu — on a desktop', () => {
  it('is a role=menu named for the ferret, with a labelled group per section and menuitems in it', async () => {
    const { root } = await show();
    expect(menu(root).getAttribute('aria-label')).toBe('Hadi actions');
    expect([...root.querySelectorAll('[role="group"]')].map(group => group.getAttribute('aria-label'))).toEqual([
      'Session',
      'Move',
      'Danger',
    ]);
    expect(root.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(3);
  });

  it('sits at the pointer, clamped inside the viewport', async () => {
    const { root } = await show({ x: 120, y: 80 });
    expect(menu(root).style.left).toBe('120px');
    expect(menu(root).style.top).toBe('80px');
    expect(menu(root).style.opacity).toBe('1');
    await mounted?.unmount();
    mounted = undefined;
    const far = await show({ x: 99_999, y: 99_999 });
    expect(Number.parseInt(menu(far.root).style.left, 10)).toBeLessThan(window.innerWidth);
    expect(Number.parseInt(menu(far.root).style.top, 10)).toBeLessThan(window.innerHeight);
  });

  it('focuses the first row and moves with the arrow keys, skipping a dimmed row', async () => {
    const { root } = await show();
    const theMenu = menu(root);
    expect(document.activeElement).toBe(row(root, 'open'));
    await interact(() => pressKey(theMenu, 'ArrowDown'));
    expect(document.activeElement).toBe(row(root, 'boom'));
    await interact(() => pressKey(theMenu, 'End'));
    expect(document.activeElement).toBe(row(root, 'restart'));
    await interact(() => pressKey(theMenu, 'ArrowDown'));
    expect(document.activeElement).toBe(row(root, 'open'));
    await interact(() => pressKey(theMenu, 'ArrowUp'));
    expect(document.activeElement).toBe(row(root, 'restart'));
    await interact(() => pressKey(theMenu, 'Home'));
    expect(document.activeElement).toBe(row(root, 'open'));
  });

  it('dims an unavailable row with its reason and does nothing when it is chosen', async () => {
    const { root, log } = await show();
    const later = row(root, 'later');
    expect(later.getAttribute('aria-disabled')).toBe('true');
    expect(later.getAttribute('title')).toBe('later');
    await interact(() => later.click());
    expect(log.ran).toEqual([]);
    expect(log.closes).toEqual([]);
  });

  it('runs a row and closes, handing focus back', async () => {
    const { root, log } = await show();
    await interact(() => row(root, 'open').click());
    expect(log.ran).toEqual(['open']);
    expect(log.closes).toEqual([true]);
  });

  it('says a failed run in one sentence', async () => {
    const { root, log } = await show();
    await interact(() => row(root, 'boom').click());
    expect(log.failures).toEqual(['Boom failed: kaboom']);
  });

  it('asks inside the menu before a destructive row, and only runs it on yes', async () => {
    const { root, log } = await show();
    await interact(() => row(root, 'restart').click());
    const confirm = must(root.querySelector('[data-menu-confirm="restart"]'), 'confirm');
    expect(confirm.textContent).toContain('Restart Hadi’s CLI?');
    await interact(() => pressKey(document, 'Escape'));
    expect(root.querySelector('[data-menu-confirm="restart"]')).toBeNull();
    expect(log.closes).toEqual([]);
    await interact(() => row(root, 'restart').click());
    await interact(() => must(root.querySelector<HTMLElement>('[data-menu-confirm-yes]'), 'yes').click());
    expect(log.ran).toEqual(['restart']);
    expect(log.closes).toEqual([true]);
  });

  it('closes on Escape (focus back), on Tab and on an outside press or resize (focus left alone)', async () => {
    const first = await show();
    await interact(() => pressKey(document, 'Escape'));
    expect(first.log.closes).toEqual([true]);
    await mounted?.unmount();

    const tab = await show();
    await interact(() => pressKey(menu(tab.root), 'Tab'));
    expect(tab.log.closes).toEqual([false]);
    await mounted?.unmount();

    const outside = await show();
    await interact(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(outside.log.closes).toEqual([false]);
    await mounted?.unmount();

    const resize = await show();
    await interact(() => window.dispatchEvent(new Event('resize')));
    expect(resize.log.closes).toEqual([false]);
  });

  it('opens a form row in a popover at the press, and closes it with focus handed back', async () => {
    const { root, log } = await show();
    await interact(() => row(root, 'formA').click());
    expect(root.querySelector('[role="menu"]')).toBeNull();
    const popover = must(root.querySelector('[data-session-action-popover]'), 'popover');
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Rename Hadi');
    expect(popover.textContent).toContain('Compact: false');
    await interact(() => must(root.querySelector<HTMLElement>('[data-notify]'), 'notify').click());
    expect(log.notices).toEqual(['A settled']);
    await interact(() => must(root.querySelector<HTMLElement>('[data-reopen]'), 'reopen').click());
    expect(root.querySelector('[data-form="A"]')).not.toBeNull();
    await interact(() => must(root.querySelector<HTMLElement>('[data-done]'), 'done').click());
    expect(log.closes).toEqual([true]);
  });

  it('closes the popover on Escape, handing focus back', async () => {
    const { root, log } = await show();
    await interact(() => row(root, 'formA').click());
    await interact(() => pressKey(must(root.querySelector('[data-session-action-popover]'), 'popover'), 'Escape'));
    expect(log.closes).toEqual([true]);
  });
});

describe('ContextActionsMenu — under a thumb', () => {
  it('is the app’s bottom sheet holding the same role=menu, at the 44px touch size', async () => {
    const { root } = await show({ touch: true });
    const dialog = must(root.querySelector('[role="dialog"]'), 'sheet');
    expect(dialog.getAttribute('aria-label')).toBe('Hadi actions');
    expect(menu(root).hasAttribute('data-compact')).toBe(true);
    expect(root.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(3);
    expect(root.querySelector('button[aria-label="Close actions"]')).not.toBeNull();
  });

  it('does not close on a press outside it — the sheet closes itself — and runs a row', async () => {
    const { root, log } = await show({ touch: true });
    await interact(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(log.closes).toEqual([]);
    await tap(row(root, 'open'));
    expect(log.ran).toEqual(['open']);
  });

  it('closes from the sheet’s own close button once a new press has begun', async () => {
    const { root, log } = await show({ touch: true });
    await interact(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    await interact(() => must(root.querySelector<HTMLElement>('button[aria-label="Close actions"]'), 'close').click());
    expect(log.closes).toEqual([true]);
  });

  it('swallows the click the opening finger’s lift produces, so the sheet is not closed under it', async () => {
    const { root, log } = await show({ touch: true });
    const close = () => must(root.querySelector<HTMLElement>('button[aria-label="Close actions"]'), 'close');
    await interact(() => close().click());
    expect(log.closes).toEqual([]);
    await interact(() => close().click());
    expect(log.closes).toEqual([true]);
  });

  it('opens a form row in the sheet, told it is compact', async () => {
    const { root, log } = await show({ touch: true });
    await tap(row(root, 'formA'));
    expect(root.querySelector('[data-session-action-popover]')).toBeNull();
    expect(must(root.querySelector('[data-session-action-sheet]'), 'form sheet').textContent).toContain(
      'Compact: true',
    );
    expect(root.querySelector('button[aria-label="Close Rename Hadi"]')).not.toBeNull();
    await tap(must(root.querySelector<HTMLElement>('[data-done]'), 'done'));
    expect(log.closes).toEqual([true]);
  });
});

describe('ContextActionsMenu — a list form', () => {
  it('opens in the drawer on a desktop, with its heading, and closes from the ✕ with focus handed back', async () => {
    const { root, log } = await show();
    await interact(() => row(root, 'listB').click());
    expect(root.querySelector('[data-session-action-popover]')).toBeNull();
    const drawer = must(root.querySelector('[data-session-action-drawer]'), 'drawer');
    expect(drawer.hasAttribute('data-compact')).toBe(false);
    expect(drawer.textContent).toContain('Resolved · 7');
    expect(drawer.textContent).toContain('Compact: false');
    await interact(() => must(root.querySelector<HTMLElement>('[data-session-action-drawer-close]'), 'close').click());
    expect(log.closes).toEqual([true]);
  });

  it('opens full screen under a thumb, told it is compact', async () => {
    const { root } = await show({ touch: true });
    await tap(row(root, 'listB'));
    expect(root.querySelector('[data-session-action-sheet]')).toBeNull();
    const drawer = must(root.querySelector('[data-session-action-drawer]'), 'drawer');
    expect(drawer.hasAttribute('data-compact')).toBe(true);
    expect(drawer.textContent).toContain('Compact: true');
  });
});
