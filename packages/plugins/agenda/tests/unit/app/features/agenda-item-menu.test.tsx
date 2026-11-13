import { afterEach, describe, expect, test } from 'bun:test';
import { useState } from 'react';
import { AgendaItemMenu, MenuGroup } from '../../../../app/features/agenda/agenda-item-menu.tsx';
import { ensureDom, interact, type Mounted, mount, must } from '@ferretry/app/testing';

// This file reads `window` as it loads: a lone run (one file per process) has no DOM until something mounts.
ensureDom();

/** On a phone (under 768px) the ⋯ menu is the app's bottom sheet; the width is a process-wide global, handed back. */
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
const setViewport = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
  });
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
  if (originalInnerWidth) Object.defineProperty(window, 'innerWidth', originalInnerWidth);
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'innerWidth');
});

function Harness({ closes }: { readonly closes: boolean[] }) {
  const [open, setOpen] = useState(false);
  return (
    <AgendaItemMenu
      onOpenChange={next => {
        if (!next) closes.push(true);
        setOpen(next);
      }}
      open={open}
    >
      <MenuGroup hook="actions" title="Actions">
        <button data-test-choice="" type="button">
          Not needed
        </button>
      </MenuGroup>
    </AgendaItemMenu>
  );
}

describe('the item’s ⋯ menu on a phone', () => {
  test('is the app’s bottom sheet, drawn on the page body under its title, and its close button closes it', async () => {
    setViewport(390);
    const closes: boolean[] = [];
    view = await mount(<Harness closes={closes} />);
    const toggle = must(view.container.querySelector<HTMLButtonElement>('[data-agenda-menu-toggle]'), 'the ⋯ button');
    expect(document.body.querySelector('[data-agenda-menu="popover"]')).toBeNull();
    await interact(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // On the body, not inside the item: the card's own transforms never move it.
    const sheet = must(document.body.querySelector<HTMLElement>('[data-agenda-menu="sheet"]'), 'the sheet');
    expect(view.container.contains(sheet)).toBe(false);
    expect(must(sheet.querySelector('.fy-item-menu__title'), 'title').textContent).toBe('Item options');
    expect(sheet.querySelector('[data-agenda-menu-group="actions"] [data-test-choice]')).not.toBeNull();
    const close = must(
      document.body.querySelector<HTMLButtonElement>('button[aria-label="Close the item options"]'),
      'the sheet’s close button',
    );
    await interact(() => close.click());
    expect(closes).toEqual([true]);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the item’s ⋯ menu on a wide screen', () => {
  /** happy-dom lays nothing out: the ⋯ button sits at a given place and the popover is 352×240, whatever its box. */
  const realRect = Element.prototype.getBoundingClientRect;
  const rectOf = (left: number, top: number, width: number, height: number): DOMRect =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  let toggleAt = { left: 388, top: 152, width: 32, height: 32 };
  const stubLayout = (): void => {
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if (this.matches('[data-agenda-menu-toggle]'))
        return rectOf(toggleAt.left, toggleAt.top, toggleAt.width, toggleAt.height);
      if (this.matches('[data-agenda-menu="popover"]')) return rectOf(0, 0, 352, 240);
      return realRect.call(this);
    };
  };
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect;
    toggleAt = { left: 388, top: 152, width: 32, height: 32 };
  });

  test('is drawn on the page body, fixed under ⋯ — so no card’s overflow clips it and no column hides it', async () => {
    setViewport(1_280);
    stubLayout();
    view = await mount(<Harness closes={[]} />);
    const toggle = must(view.container.querySelector<HTMLButtonElement>('[data-agenda-menu-toggle]'), 'the ⋯ button');
    await interact(() => toggle.click());
    const popover = must(document.body.querySelector<HTMLElement>('[data-agenda-menu="popover"]'), 'the popover');
    expect(view.container.contains(popover)).toBe(false);
    expect(popover.parentElement).toBe(document.body);
    // Its right edge on ⋯'s right edge (420), 4px under it.
    expect(popover.style.left).toBe(`${420 - 352}px`);
    expect(popover.style.top).toBe(`${152 + 32 + 4}px`);
  });

  test('never opens off the window: ⋯ near the left edge opens rightwards from the margin; near the bottom it flips above', async () => {
    setViewport(1_280);
    stubLayout();
    toggleAt = { left: 40, top: 700, width: 32, height: 32 };
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 760 });
    view = await mount(<Harness closes={[]} />);
    await interact(() =>
      must(view?.container.querySelector<HTMLButtonElement>('[data-agenda-menu-toggle]'), '⋯').click(),
    );
    const popover = must(document.body.querySelector<HTMLElement>('[data-agenda-menu="popover"]'), 'the popover');
    expect(popover.style.left).toBe('8px');
    expect(popover.style.top).toBe(`${700 - 4 - 240}px`);
  });

  test('a press inside the popover keeps it open; a press outside closes it', async () => {
    setViewport(1_280);
    stubLayout();
    const closes: boolean[] = [];
    view = await mount(<Harness closes={closes} />);
    await interact(() =>
      must(view?.container.querySelector<HTMLButtonElement>('[data-agenda-menu-toggle]'), '⋯').click(),
    );
    const choice = must(document.body.querySelector<HTMLElement>('[data-test-choice]'), 'a choice');
    await interact(() => void choice.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })));
    expect(closes).toEqual([]);
    await interact(() => void document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })));
    expect(closes).toEqual([true]);
  });
});

describe('the item’s ⋯ menu moves focus in, and only once it can take it', () => {
  test('focus goes to the first choice AFTER the popover is placed (never while it is still visibility:hidden)', async () => {
    setViewport(1_280);
    const realFocus = HTMLElement.prototype.focus;
    const seen: { readonly hidden: boolean }[] = [];
    HTMLElement.prototype.focus = function (this: HTMLElement, ...rest: Parameters<HTMLElement['focus']>): void {
      const popover = this.closest<HTMLElement>('[data-agenda-menu="popover"]');
      if (popover !== null) seen.push({ hidden: popover.style.visibility === 'hidden' });
      realFocus.apply(this, rest);
    };
    try {
      view = await mount(<Harness closes={[]} />);
      await interact(() =>
        must(view?.container.querySelector<HTMLButtonElement>('[data-agenda-menu-toggle]'), '⋯').click(),
      );
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every(call => !call.hidden)).toBe(true);
      expect(document.activeElement).toBe(must(document.body.querySelector('[data-test-choice]'), 'the first choice'));
    } finally {
      HTMLElement.prototype.focus = realFocus;
    }
  });

  test('Escape still closes it and returns focus to ⋯', async () => {
    setViewport(1_280);
    const closes: boolean[] = [];
    view = await mount(<Harness closes={closes} />);
    const toggle = must(view.container.querySelector<HTMLButtonElement>('[data-agenda-menu-toggle]'), '⋯');
    await interact(() => toggle.click());
    await interact(
      () =>
        void must(document.body.querySelector('[data-test-choice]'), 'choice').dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ),
    );
    expect(closes).toEqual([true]);
    expect(document.activeElement).toBe(toggle);
  });
});

describe('the item’s ⋯ menu sits under every dialog', () => {
  test('its stylesheet takes its layer from the app’s popover token, not a number of its own', async () => {
    const css = await Bun.file(new URL('../../../../app/features/agenda/agenda-item-card.css', import.meta.url)).text();
    const rule = /\.fy-item-menu__popover\s*\{[^}]*\}/u.exec(css)?.[0] ?? '';
    expect(rule).toContain('z-index: var(--z-popover)');
  });
});
