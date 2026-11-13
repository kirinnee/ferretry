import { afterEach, describe, expect, test } from 'bun:test';
import { useState } from 'react';
import { AgendaItemMenu, MenuGroup } from '../../../../app/features/agenda/agenda-item-menu.tsx';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';

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
