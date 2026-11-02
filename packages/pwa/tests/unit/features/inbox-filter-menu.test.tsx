import { describe, expect, it } from 'bun:test';
import { FilterMenu, FindBox, FindToggle } from '../../../src/features/agenda/inbox-filter-menu.tsx';
import { interact, mount, must, pressKey } from '../../support/dom.ts';

const CHOICES = [
  { value: 'open', label: 'Open' },
  { value: 'snoozed', label: 'Snoozed (18)' },
  { value: 'resolved', label: 'Resolved' },
] as const;

const menu = async (value: 'open' | 'snoozed' | 'resolved' = 'open') => {
  const chosen: string[] = [];
  const view = await mount(
    <FilterMenu
      choiceHook="data-agenda-filter-option"
      choices={CHOICES}
      hook="data-agenda-filter"
      icon={<span data-icon="" />}
      name="Show"
      onChange={next => chosen.push(next)}
      value={value}
    />,
  );
  const trigger = must(view.container.querySelector<HTMLButtonElement>('button'), 'the trigger');
  const items = (): HTMLElement[] => [...view.container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  return { view, trigger, items, chosen };
};

describe('FilterMenu', () => {
  it('is a button that says the choice, closed until pressed', async () => {
    const { view, trigger, items } = await menu('snoozed');
    expect(trigger.textContent).toBe('Snoozed (18)');
    expect(trigger.getAttribute('aria-label')).toBe('Show: Snoozed (18)');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('[data-icon]')).not.toBeNull();
    expect(items()).toEqual([]);
    await view.unmount();
  });

  it('lists every choice with its count, focusing the chosen one', async () => {
    const { view, trigger, items } = await menu('snoozed');
    await interact(() => trigger.click());
    expect(items().map(item => item.textContent)).toEqual(['Open', 'Snoozed (18)', 'Resolved']);
    expect(items().map(item => item.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(items()[1]?.getAttribute('data-agenda-filter-option')).toBe('snoozed');
    expect(document.activeElement).toBe(items()[1] ?? null);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await interact(() => trigger.click());
    expect(items()).toEqual([]);
    await view.unmount();
  });

  it('chooses one, closes and hands the focus back', async () => {
    const { view, trigger, items, chosen } = await menu();
    await interact(() => trigger.click());
    await interact(() => must(items()[2], 'Resolved').click());
    expect(chosen).toEqual(['resolved']);
    expect(items()).toEqual([]);
    expect(document.activeElement).toBe(trigger);
    await view.unmount();
  });

  it('walks with the arrows (round and round), closes on Esc, and ignores keys while closed', async () => {
    const { view, trigger, items } = await menu();
    await interact(() => pressKey(trigger, 'ArrowDown'));
    await interact(() => trigger.click());
    expect(document.activeElement).toBe(items()[0] ?? null);
    await interact(() => pressKey(items()[0] as HTMLElement, 'ArrowUp'));
    expect(document.activeElement).toBe(items()[2] ?? null);
    await interact(() => pressKey(items()[2] as HTMLElement, 'ArrowDown'));
    expect(document.activeElement).toBe(items()[0] ?? null);
    await interact(() => pressKey(items()[0] as HTMLElement, 'a'));
    expect(items().length).toBe(3);
    await interact(() => pressKey(items()[0] as HTMLElement, 'Escape'));
    expect(items()).toEqual([]);
    expect(document.activeElement).toBe(trigger);
    await view.unmount();
  });

  it('closes on a press outside it, not inside', async () => {
    const { view, trigger, items } = await menu();
    await interact(() => trigger.click());
    await interact(() => items()[0]?.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(items().length).toBe(3);
    await interact(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(items()).toEqual([]);
    await view.unmount();
  });
});

describe('FindBox and FindToggle', () => {
  it('clears on Escape, and says nothing to Escape on an empty box', async () => {
    const typed: string[] = [];
    const view = await mount(<FindBox onChange={next => typed.push(next)} query="pair" />);
    const input = must(view.container.querySelector<HTMLInputElement>('input'), 'the box');
    await interact(() => pressKey(input, 'Escape'));
    expect(typed).toEqual(['']);
    await view.unmount();
    const empty = await mount(<FindBox onChange={next => typed.push(next)} query="" />);
    await interact(() => pressKey(must(empty.container.querySelector('input'), 'the box'), 'Escape'));
    expect(typed).toEqual(['']);
    await empty.unmount();
  });

  it('takes the keyboard when asked, and not otherwise', async () => {
    const focused = await mount(<FindBox focus onChange={() => undefined} query="" />);
    expect(document.activeElement).toBe(focused.container.querySelector('input'));
    await focused.unmount();
    const idle = await mount(<FindBox onChange={() => undefined} query="" />);
    expect(document.activeElement).not.toBe(idle.container.querySelector('input'));
    await idle.unmount();
  });

  it('is a search icon; it opens the box, and closing clears what was typed', async () => {
    const typed: string[] = [];
    const view = await mount(<FindToggle onChange={next => typed.push(next)} query="" />);
    expect(view.container.querySelector('input')).toBeNull();
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-agenda-find-open]'), 'the icon').click(),
    );
    expect(view.container.querySelector('input')).not.toBeNull();
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-agenda-find-close]'), 'close').click(),
    );
    expect(typed).toEqual(['']);
    expect(view.container.querySelector('input')).toBeNull();
    await view.unmount();
  });

  it('stays open while something is typed', async () => {
    const view = await mount(<FindToggle onChange={() => undefined} query="pair" />);
    expect(view.container.querySelector('input')?.value).toBe('pair');
    await view.unmount();
  });
});
