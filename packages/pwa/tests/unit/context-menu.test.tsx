import { describe, expect, it } from 'bun:test';
import {
  clampMenuPosition,
  ContextMenu,
  type ContextMenuItem,
  firstEnabledIndex,
  nextEnabledIndex,
} from '../../src/shell/context-menu.tsx';
import { interact, mount, pressKey } from '../support/dom.ts';

const VIEWPORT = { width: 360, height: 640 };

/** A pointer arriving on `target` from outside the menu. */
const hover = (target: HTMLElement): void => {
  const event = new Event('pointerover', { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, relatedTarget: document.body });
  target.dispatchEvent(event);
};

describe('clampMenuPosition', () => {
  it('opens at the anchor when the menu fits below and to the right', () => {
    expect(clampMenuPosition({ x: 40, y: 60 }, { width: 200, height: 180 }, VIEWPORT)).toEqual({ left: 40, top: 60 });
  });

  it('flips back toward the middle rather than running off the right or bottom edge', () => {
    expect(clampMenuPosition({ x: 340, y: 60 }, { width: 200, height: 180 }, VIEWPORT).left).toBe(140);
    expect(clampMenuPosition({ x: 40, y: 620 }, { width: 200, height: 180 }, VIEWPORT).top).toBe(440);
  });

  it('clamps to the margin as the final guarantee after a flip', () => {
    // A flip from a near-left anchor would land at a negative offset; the clamp
    // is what stops it.
    expect(clampMenuPosition({ x: 4, y: 4 }, { width: 200, height: 180 }, { width: 210, height: 190 })).toEqual({
      left: 8,
      top: 8,
    });
  });

  it('pins a menu larger than the viewport to the top-left margin instead of pushing it off the top', () => {
    expect(clampMenuPosition({ x: 100, y: 100 }, { width: 500, height: 900 }, VIEWPORT)).toEqual({ left: 8, top: 8 });
  });

  it('honours a caller-supplied margin', () => {
    expect(clampMenuPosition({ x: 0, y: 0 }, { width: 200, height: 180 }, VIEWPORT, 20)).toEqual({ left: 20, top: 20 });
  });
});

const items = (...flags: readonly boolean[]): ContextMenuItem[] =>
  flags.map((disabled, index) => ({
    key: `item-${index}`,
    label: `Item ${index}`,
    onSelect: () => {},
    disabled,
  }));

describe('nextEnabledIndex', () => {
  it('stays put when there is nothing to move to', () => {
    expect(nextEnabledIndex([], 0, 1)).toBe(0);
    expect(nextEnabledIndex(items(true, true, true), 1, 1)).toBe(1);
  });

  it('steps over disabled rows in both directions', () => {
    expect(nextEnabledIndex(items(false, true, false), 0, 1)).toBe(2);
    expect(nextEnabledIndex(items(false, true, false), 2, -1)).toBe(0);
  });

  it('wraps at both ends', () => {
    expect(nextEnabledIndex(items(false, false, false), 2, 1)).toBe(0);
    expect(nextEnabledIndex(items(false, false, false), 0, -1)).toBe(2);
  });
});

describe('firstEnabledIndex', () => {
  it('finds the first row a reader can actually choose', () => {
    expect(firstEnabledIndex(items(true, true, false))).toBe(2);
  });

  it('falls back to the top when every row is disabled', () => {
    expect(firstEnabledIndex(items(true, true))).toBe(0);
  });
});

interface Harness {
  readonly chosen: string[];
  readonly closes: number;
}

const menuItems = (harness: Harness, overrides: Partial<ContextMenuItem>[] = []): ContextMenuItem[] =>
  [
    { key: 'stop', label: 'Stop', onSelect: () => harness.chosen.push('stop') },
    { key: 'resume', label: 'Resume', onSelect: () => harness.chosen.push('resume') },
    { key: 'migrate', label: 'Migrate', danger: true, onSelect: () => harness.chosen.push('migrate') },
  ].map((item, index) => ({ ...item, ...overrides[index] }));

const openMenu = async (options: { items?: ContextMenuItem[]; touch?: boolean } = {}) => {
  const state = { chosen: [] as string[], closes: 0 };
  const harness: Harness = state as unknown as Harness;
  const trigger = document.createElement('button');
  document.body.appendChild(trigger);
  trigger.focus();

  const mounted = await mount(
    <ContextMenu
      open
      anchor={{ x: 20, y: 30 }}
      items={options.items ?? menuItems(harness)}
      onClose={() => {
        state.closes += 1;
      }}
      ariaLabel="Session actions"
      triggerRef={{ current: trigger }}
      touch={options.touch}
    />,
  );

  const menu = mounted.container.querySelector('[role="menu"]') as HTMLElement;
  const rows = () => Array.from(mounted.container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  return { ...mounted, menu, rows, state, trigger };
};

describe('ContextMenu', () => {
  it('renders nothing at all when closed', async () => {
    const mounted = await mount(
      <ContextMenu open={false} anchor={{ x: 0, y: 0 }} items={[]} onClose={() => {}} ariaLabel="Empty" />,
    );

    expect(mounted.container.innerHTML).toBe('');
    await mounted.unmount();
  });

  it('is a vertical menu that names itself, with one row per item', async () => {
    const menu = await openMenu();

    expect(menu.menu.getAttribute('aria-label')).toBe('Session actions');
    expect(menu.menu.getAttribute('aria-orientation')).toBe('vertical');
    expect(menu.rows().map(row => row.textContent)).toEqual(['Stop', 'Resume', 'Migrate']);
    await menu.unmount();
  });

  it('lands focus on the first enabled row and gives only it a tab stop', async () => {
    const menu = await openMenu({
      items: [
        { key: 'a', label: 'A', disabled: true, onSelect: () => {} },
        { key: 'b', label: 'B', onSelect: () => {} },
      ],
    });

    expect(document.activeElement).toBe(menu.rows()[1] as Element);
    expect(menu.rows().map(row => row.tabIndex)).toEqual([-1, 0]);
    await menu.unmount();
  });

  it('moves the roving focus with the arrow keys, Home and End', async () => {
    const menu = await openMenu();

    await interact(() => pressKey(menu.menu, 'ArrowDown'));
    expect(document.activeElement).toBe(menu.rows()[1] as Element);

    await interact(() => pressKey(menu.menu, 'End'));
    expect(document.activeElement).toBe(menu.rows()[2] as Element);

    await interact(() => pressKey(menu.menu, 'ArrowDown'));
    expect(document.activeElement).toBe(menu.rows()[0] as Element);

    await interact(() => pressKey(menu.menu, 'ArrowUp'));
    expect(document.activeElement).toBe(menu.rows()[2] as Element);

    await interact(() => pressKey(menu.menu, 'Home'));
    expect(document.activeElement).toBe(menu.rows()[0] as Element);
    await menu.unmount();
  });

  it('activates the focused row on Enter and on Space, and closes first', async () => {
    const menu = await openMenu();

    await interact(() => pressKey(menu.menu, 'Enter'));
    expect(menu.state.chosen).toEqual(['stop']);
    expect(menu.state.closes).toBe(1);

    await interact(() => pressKey(menu.menu, ' '));
    expect(menu.state.chosen).toEqual(['stop', 'stop']);
    await menu.unmount();
  });

  it('never activates a disabled row, by pointer or by key', async () => {
    const chosen: string[] = [];
    const menu = await openMenu({
      items: [{ key: 'a', label: 'A', disabled: true, onSelect: () => chosen.push('a') }],
    });

    await interact(() => menu.rows()[0]?.click());
    await interact(() => pressKey(menu.menu, 'Enter'));

    expect(chosen).toEqual([]);
    await menu.unmount();
  });

  it('activates a row on click and reports the choice after the close', async () => {
    const menu = await openMenu();

    await interact(() => menu.rows()[2]?.click());

    expect(menu.state.chosen).toEqual(['migrate']);
    expect(menu.state.closes).toBe(1);
    await menu.unmount();
  });

  it('follows the pointer with the roving focus, but not onto a disabled row', async () => {
    const menu = await openMenu({
      items: [
        { key: 'a', label: 'A', onSelect: () => {} },
        { key: 'b', label: 'B', disabled: true, onSelect: () => {} },
        { key: 'c', label: 'C', onSelect: () => {} },
      ],
    });

    // React synthesises pointerenter from a pointerover whose relatedTarget is
    // outside the row, so that is what a real hover looks like to the handler.
    await interact(() => hover(menu.rows()[2] as HTMLElement));
    expect(document.activeElement).toBe(menu.rows()[2] as Element);

    await interact(() => hover(menu.rows()[1] as HTMLElement));
    expect(document.activeElement).toBe(menu.rows()[2] as Element);
    await menu.unmount();
  });

  it('closes on Escape, on an outside pointer, on scroll, on resize and on a route change', async () => {
    const menu = await openMenu();

    await interact(() => pressKey(document, 'Escape'));
    expect(menu.state.closes).toBe(1);

    const backdrop = menu.container.querySelector('button[aria-label="Close menu"]') as HTMLElement;
    await interact(() => backdrop.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(menu.state.closes).toBe(2);

    await interact(() => window.dispatchEvent(new Event('scroll')));
    expect(menu.state.closes).toBe(3);

    await interact(() => window.dispatchEvent(new Event('resize')));
    expect(menu.state.closes).toBe(4);

    await interact(() => window.dispatchEvent(new Event('popstate')));
    expect(menu.state.closes).toBe(5);
    await menu.unmount();
  });

  it('closes rather than trapping Tab', async () => {
    const menu = await openMenu();

    await interact(() => pressKey(menu.menu, 'Tab'));

    expect(menu.state.closes).toBe(1);
    await menu.unmount();
  });

  it('ignores keys it does not own', async () => {
    const menu = await openMenu();

    await interact(() => pressKey(menu.menu, 'a'));

    expect(menu.state.closes).toBe(0);
    expect(menu.state.chosen).toEqual([]);
    await menu.unmount();
  });

  it('swallows the native menu on the dismiss surface rather than stacking two menus', async () => {
    const menu = await openMenu();
    const backdrop = menu.container.querySelector('button[aria-label="Close menu"]') as HTMLElement;
    const event = new Event('contextmenu', { bubbles: true, cancelable: true });

    await interact(() => backdrop.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(menu.state.closes).toBe(1);
    await menu.unmount();
  });

  it('returns focus to the trigger on a keyboard dismiss, and leaves it alone otherwise', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    const anchor = { x: 10, y: 10 };
    const props = (open: boolean) => (
      <ContextMenu
        open={open}
        anchor={anchor}
        items={[{ key: 'a', label: 'A', onSelect: () => {} }]}
        onClose={() => {}}
        ariaLabel="Actions"
        triggerRef={{ current: trigger }}
      />
    );

    const mounted = await mount(props(true));
    const menu = mounted.container.querySelector('[role="menu"]') as HTMLElement;
    await interact(() => pressKey(menu, 'Tab'));
    await mounted.render(props(false));
    expect(document.activeElement).toBe(trigger);

    // A pointer activation hands focus onward instead, so the close must not
    // yank it back to the trigger.
    trigger.blur();
    await mounted.render(props(true));
    const row = mounted.container.querySelector('[role="menuitem"]') as HTMLElement;
    await interact(() => row.click());
    await mounted.render(props(false));
    expect(document.activeElement).not.toBe(trigger);

    await mounted.unmount();
    trigger.remove();
  });

  it('takes the 44px touch floor only on a coarse pointer', async () => {
    const fine = await openMenu();
    expect(fine.rows()[0]?.className).toContain('min-h-[34px]');
    await fine.unmount();

    const coarse = await openMenu({ touch: true });
    expect(coarse.rows()[0]?.className).toContain('min-h-[44px]');
    await coarse.unmount();
  });

  it('marks a destructive row with tone as reinforcement, never as the only signal', async () => {
    const menu = await openMenu();

    expect(menu.rows()[2]?.className).toContain('text-err');
    expect(menu.rows()[2]?.textContent).toBe('Migrate');
    expect(menu.rows()[0]?.className).not.toContain('text-err');

    // Exclusive, not layered: carrying both inks let the emitted-CSS order
    // decide the colour, and the destructive tone lost.
    expect(menu.rows()[2]?.className).not.toContain('text-fg-soft');
    expect(menu.rows()[0]?.className).toContain('text-fg-soft');
    await menu.unmount();
  });

  it('renders an icon and a detail beside the label when the caller supplies them', async () => {
    const menu = await openMenu({
      items: [{ key: 'a', label: 'Stop', detail: '3 selected', icon: <i data-testid="icon" />, onSelect: () => {} }],
    });

    expect(menu.rows()[0]?.querySelector('[data-testid="icon"]')).not.toBeNull();
    expect(menu.rows()[0]?.textContent).toContain('3 selected');
    await menu.unmount();
  });

  it('stays hidden until it has been measured, so it never flashes off-edge', async () => {
    // happy-dom reports zero offsets, so the clamp lands the menu at the anchor
    // and the visibility flips to visible in the same commit.
    const menu = await openMenu();

    expect(menu.menu.style.visibility).toBe('visible');
    expect(menu.menu.style.left).toBe('20px');
    expect(menu.menu.style.top).toBe('30px');
    await menu.unmount();
  });
});
