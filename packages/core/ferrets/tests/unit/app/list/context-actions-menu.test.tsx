import { afterEach, describe, expect, it } from 'bun:test';
import { Copy, Pencil, Square } from 'lucide-react';
import { ContextActionsMenu } from '../../../../app/features/list/context-actions-menu.tsx';
import type { FerretActionFormHost, FerretActionSection } from '../../../../app/features/header/registry.ts';
import { interact, type Mounted, mount, must, pressKey } from '../support/dom.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

interface Seen {
  readonly ran: string[];
  readonly closes: boolean[];
  readonly failures: string[];
  readonly notices: string[];
}

const sections = (seen: Seen): FerretActionSection[] => [
  {
    group: 'ferret',
    label: 'Ferret',
    entries: [
      { kind: 'run', id: 'copy', label: 'Copy', icon: Copy, run: () => void seen.ran.push('copy') },
      {
        kind: 'run',
        id: 'boom',
        label: 'Boom…',
        icon: Copy,
        run: () => {
          throw new Error('nope');
        },
      },
      {
        kind: 'form',
        id: 'rename',
        label: 'Rename…',
        title: 'Rename Hadi',
        icon: Pencil,
        render: (host: FerretActionFormHost) => (
          <div data-form="rename">
            <span data-compact>{String(host.compact)}</span>
            <button data-notify="" onClick={() => host.notify('Renamed')} type="button">
              Notify
            </button>
            <button data-other="" onClick={() => host.open('other')} type="button">
              Other
            </button>
            <button data-done="" onClick={host.close} type="button">
              Done
            </button>
          </div>
        ),
      },
      {
        kind: 'form',
        id: 'other',
        label: 'Other…',
        title: 'Other form',
        icon: Pencil,
        render: () => <div data-form="other">other</div>,
      },
    ],
  },
  {
    group: 'danger',
    label: 'Danger',
    entries: [
      {
        kind: 'confirm',
        id: 'stop',
        label: 'Stop ferret…',
        icon: Square,
        danger: true,
        question: 'Stop Hadi?',
        consequence: 'It ends.',
        confirmLabel: 'Stop ferret',
        run: () => void seen.ran.push('stop'),
      },
    ],
  },
];

const mountMenu = async (
  options: { touch?: boolean; anchor?: { x: number; y: number } } = {},
): Promise<{ seen: Seen; root: HTMLElement }> => {
  const seen: Seen = { ran: [], closes: [], failures: [], notices: [] };
  mounted = await mount(
    <ContextActionsMenu
      anchor={options.anchor ?? { x: 40, y: 50 }}
      name="Hadi"
      onClose={restore => seen.closes.push(restore)}
      onFailure={sentence => seen.failures.push(sentence)}
      onNotice={sentence => seen.notices.push(sentence)}
      sections={sections(seen)}
      touch={options.touch ?? false}
    />,
  );
  return { seen, root: document.body };
};

const click = async (selector: string): Promise<void> => {
  await interact(() => must(document.body.querySelector<HTMLElement>(selector), selector).click());
};
const fire = (target: EventTarget, type: string): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

describe('the row menu at the pointer (mouse and keyboard)', () => {
  it('is a labelled menu at the press, with the same groups and rows as Actions ▾', async () => {
    await mountMenu();
    const menu = must(document.body.querySelector<HTMLElement>('[data-ferret-row-menu]'), 'the menu');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.getAttribute('aria-label')).toBe('Hadi actions');
    expect(menu.style.left).toBe('40px');
    expect(menu.style.top).toBe('50px');
    expect([...menu.querySelectorAll('[role="group"]')].map(group => group.getAttribute('aria-label'))).toEqual([
      'Ferret',
      'Danger',
    ]);
    expect(document.activeElement?.getAttribute('data-ferret-action-item')).toBe('copy');
  });

  it('never hangs off the screen', async () => {
    await mountMenu({ anchor: { x: 5_000, y: 5_000 } });
    const menu = must(document.body.querySelector<HTMLElement>('[data-ferret-row-menu]'), 'the menu');
    expect(Number.parseInt(menu.style.left, 10)).toBeLessThanOrEqual(window.innerWidth);
    expect(Number.parseInt(menu.style.top, 10)).toBeLessThanOrEqual(window.innerHeight);
  });

  it('a chosen row runs and closes the menu, handing focus back to the row', async () => {
    const { seen } = await mountMenu();
    await click('[data-ferret-action-item="copy"]');
    expect(seen.ran).toEqual(['copy']);
    expect(seen.closes).toEqual([true]);
  });

  it('a row that fails says so in the host’s one alert', async () => {
    const { seen } = await mountMenu();
    await click('[data-ferret-action-item="boom"]');
    expect(seen.failures).toEqual(['Boom failed: nope']);
  });

  it('a destructive row asks inside the menu first, and Escape cancels the question before the menu', async () => {
    const { seen } = await mountMenu();
    await click('[data-ferret-action-item="stop"]');
    expect(document.body.querySelector('[data-menu-confirm="stop"]')).not.toBeNull();
    expect(seen.ran).toEqual([]);
    await interact(() => pressKey(document, 'Escape'));
    expect(document.body.querySelector('[data-menu-confirm="stop"]')).toBeNull();
    expect(seen.closes).toEqual([]);
    await click('[data-ferret-action-item="stop"]');
    const cancel = [...document.body.querySelectorAll<HTMLElement>('[data-menu-confirm] button')].find(
      button => button.textContent === 'Cancel',
    );
    await interact(() => must(cancel, 'the Cancel button').click());
    expect(document.body.querySelector('[data-menu-confirm="stop"]')).toBeNull();
    expect(seen.ran).toEqual([]);
    await click('[data-ferret-action-item="stop"]');
    await click('[data-menu-confirm-yes]');
    expect(seen.ran).toEqual(['stop']);
    expect(seen.closes).toEqual([true]);
  });

  it('Escape closes it with focus handed back; Tab and an outside press close it without', async () => {
    const { seen } = await mountMenu();
    await interact(() => pressKey(document, 'Escape'));
    expect(seen.closes).toEqual([true]);
    const menu = must(document.body.querySelector<HTMLElement>('[data-ferret-row-menu]'), 'the menu');
    await interact(() => pressKey(menu, 'Tab'));
    expect(seen.closes).toEqual([true, false]);
    await interact(() => fire(document.body, 'pointerdown'));
    expect(seen.closes).toEqual([true, false, false]);
  });

  it('a “…” row opens its form in a popover at the press, which takes Escape, notifies and can open another form', async () => {
    const { seen } = await mountMenu();
    await click('[data-ferret-action-item="rename"]');
    expect(document.body.querySelector('[data-ferret-row-menu]')).toBeNull();
    const popover = must(document.body.querySelector<HTMLElement>('[data-ferret-row-popover]'), 'the popover');
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Rename Hadi');
    expect(popover.style.left).toBe('40px');
    expect(popover.querySelector('[data-compact]')?.textContent).toBe('false');

    await click('[data-notify]');
    expect(seen.notices).toEqual(['Renamed']);
    await click('[data-other]');
    expect(document.body.querySelector('[data-form="other"]')).not.toBeNull();
    expect(document.body.querySelector('[data-form="rename"]')).toBeNull();
    await interact(() =>
      pressKey(must(document.body.querySelector<HTMLElement>('[data-ferret-row-popover]'), 'it'), 'Escape'),
    );
    expect(seen.closes).toEqual([true]);
  });
});

describe('the row menu as a sheet (after a touch)', () => {
  it('is the app’s bottom sheet with 44px rows, not a menu at a point', async () => {
    await mountMenu({ touch: true });
    const menu = must(document.body.querySelector<HTMLElement>('[data-ferret-row-menu]'), 'the menu');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.hasAttribute('data-compact')).toBe(true);
    expect(menu.className).toContain('fy-actions-menu--sheet');
    expect(menu.closest('[role="dialog"]')).not.toBeNull();
    expect(menu.style.left).toBe('');
  });

  it('swallows the click that lifts the opening finger once, and not a fresh press’s', async () => {
    await mountMenu({ touch: true });
    expect(fire(document.body, 'click').defaultPrevented).toBe(true);
    expect(fire(document.body, 'click').defaultPrevented).toBe(false);
  });

  it('a new press before the lift is a deliberate tap, so its click is not swallowed', async () => {
    await mountMenu({ touch: true });
    fire(document.body, 'pointerdown');
    expect(fire(document.body, 'click').defaultPrevented).toBe(false);
  });

  it('a press outside does not dismiss a sheet; its own close does, with focus handed back', async () => {
    const { seen } = await mountMenu({ touch: true });
    await interact(() => fire(document.body, 'pointerdown'));
    expect(seen.closes).toEqual([]);
    const close = must(document.body.querySelector<HTMLElement>('[aria-label="Close actions"]'), 'close');
    await interact(() => close.click());
    expect(seen.closes).toEqual([true]);
  });

  it('a “…” row opens its form in the sheet, compact', async () => {
    const { seen } = await mountMenu({ touch: true });
    // A real tap begins with a press; without one the first click is the opening finger's lift and is swallowed.
    fire(document.body, 'pointerdown');
    await click('[data-ferret-action-item="rename"]');
    // The app's sheet animates in and out, so the swap settles a moment later.
    await interact(() => new Promise(resolve => setTimeout(resolve, 400)));
    expect(document.body.querySelector('[data-ferret-row-menu]')).toBeNull();
    expect(document.body.querySelector('[data-ferret-action-sheet] [data-form="rename"]')).not.toBeNull();
    expect(document.body.querySelector('[data-compact]')?.textContent).toBe('true');
    await click('[data-done]');
    expect(seen.closes).toEqual([true]);
  });
});
