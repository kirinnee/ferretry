import { describe, expect, it } from 'bun:test';
import { AgendaSnoozeMenu } from '../../../src/features/agenda/agenda-snooze-menu.tsx';
import { snoozeChoices } from '../../../src/lib/agenda-snooze.ts';
import { interact, mount, must, pressKey } from '../../support/dom.ts';
import { typeInto } from '../../support/learning-dom.ts';

const NOW = new Date(2026, 9, 30, 15, 20).getTime();

const open = async (props: Partial<Parameters<typeof AgendaSnoozeMenu>[0]> = {}) => {
  const picked: string[] = [];
  const view = await mount(
    <AgendaSnoozeMenu now={NOW} onSnooze={until => picked.push(until)} triggerClass="trigger" {...props} />,
  );
  const trigger = must(view.container.querySelector<HTMLButtonElement>('[data-agenda-snooze]'), 'the clock button');
  const items = (): HTMLElement[] => [...view.container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const form = (): HTMLFormElement | null => view.container.querySelector<HTMLFormElement>('[data-snooze-custom]');
  const field = (): HTMLInputElement => must(form()?.querySelector<HTMLInputElement>('input') ?? null, 'the field');
  const submit = async () =>
    interact(() => form()?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  return { view, trigger, items, form, field, submit, picked };
};

describe('AgendaSnoozeMenu', () => {
  it('is a labelled clock button that starts closed', async () => {
    const { view, trigger } = await open();
    expect(trigger.getAttribute('aria-label')).toBe('Snooze this agenda item');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.className).toBe('trigger');
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
    await view.unmount();
  });

  it('opens a menu of the three times and Custom…, focusing the first', async () => {
    const { view, trigger, items } = await open();
    await interact(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(items().map(item => item.textContent)).toEqual(['1 hour', '4 hours', 'Tomorrow 9:00', 'Custom…']);
    expect(document.activeElement).toBe(items()[0] ?? null);
    await interact(() => trigger.click());
    expect(items()).toEqual([]);
    await view.unmount();
  });

  it('snoozes until the chosen time and closes', async () => {
    const { view, trigger, items, picked } = await open();
    await interact(() => trigger.click());
    await interact(() => must(items()[1], 'the 4 hours item').click());
    expect(picked).toEqual([snoozeChoices(NOW)[1]?.until ?? '']);
    expect(items()).toEqual([]);
    await view.unmount();
  });

  it('reads the clock itself when it is given no time', async () => {
    const { view, trigger, items, picked } = await open({ now: undefined });
    await interact(() => trigger.click());
    await interact(() => must(items()[0], 'the 1 hour item').click());
    const ahead = Date.parse(picked[0] ?? '') - Date.now();
    expect(ahead).toBeGreaterThan(3_500_000);
    expect(ahead).toBeLessThanOrEqual(3_600_000);
    await view.unmount();
  });

  it('shows and hides the custom form from Custom…', async () => {
    const { view, trigger, items, form } = await open();
    await interact(() => trigger.click());
    const custom = must(items()[3], 'Custom…');
    expect(custom.getAttribute('aria-expanded')).toBe('false');
    await interact(() => custom.click());
    expect(custom.getAttribute('aria-expanded')).toBe('true');
    expect(form()).not.toBeNull();
    await interact(() => custom.click());
    expect(form()).toBeNull();
    await view.unmount();
  });

  it('starts the custom field an hour on, with nothing earlier than now allowed', async () => {
    const { view, trigger, items, field } = await open();
    await interact(() => trigger.click());
    await interact(() => must(items()[3], 'Custom…').click());
    expect(field().value).toBe('2026-10-30T16:20');
    expect(field().min).toBe('2026-10-30T15:20');
    await view.unmount();
  });

  it('snoozes until a later time typed into the custom field', async () => {
    const { view, trigger, items, field, submit, picked } = await open();
    await interact(() => trigger.click());
    await interact(() => must(items()[3], 'Custom…').click());
    await typeInto(field(), '2099-01-01T09:00');
    await submit();
    expect(picked).toEqual([new Date(2099, 0, 1, 9).toISOString()]);
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
    await view.unmount();
  });

  it('refuses a time that has passed, says so, and clears the problem on the next edit', async () => {
    const { view, trigger, items, field, submit, picked } = await open();
    await interact(() => trigger.click());
    await interact(() => must(items()[3], 'Custom…').click());
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(field().getAttribute('aria-invalid')).toBeNull();
    await typeInto(field(), '2000-01-01T09:00');
    await submit();
    const problem = must(view.container.querySelector<HTMLElement>('[role="alert"]'), 'the problem');
    expect(problem.textContent).toBe('That time has passed — pick a later one.');
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(field().getAttribute('aria-describedby')).toBe(problem.id);
    expect(picked).toEqual([]);
    await typeInto(field(), '2099-01-01T09:00');
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    await view.unmount();
  });

  it('asks for a date when the field is empty', async () => {
    const { view, trigger, items, field, submit, picked } = await open();
    await interact(() => trigger.click());
    await interact(() => must(items()[3], 'Custom…').click());
    await typeInto(field(), '');
    await submit();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('Pick a date and a time.');
    expect(picked).toEqual([]);
    await view.unmount();
  });

  it('closes on Esc with focus back on the clock button, and the form with it', async () => {
    const { view, trigger, items, form } = await open();
    await interact(() => trigger.click());
    await interact(() => must(items()[3], 'Custom…').click());
    await interact(() => pressKey(must(items()[0], 'item'), 'Escape'));
    expect(items()).toEqual([]);
    expect(form()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await view.unmount();
  });

  it('ignores Esc and the arrows while closed', async () => {
    const { view, trigger, items } = await open();
    await interact(() => pressKey(trigger, 'Escape'));
    await interact(() => pressKey(trigger, 'ArrowDown'));
    expect(items()).toEqual([]);
    await view.unmount();
  });

  it('walks the choices with the arrow keys, wrapping round', async () => {
    const { view, trigger, items } = await open();
    await interact(() => trigger.click());
    await interact(() => pressKey(must(items()[0], 'first'), 'ArrowUp'));
    expect(document.activeElement).toBe(items()[3] ?? null);
    await interact(() => pressKey(must(items()[3], 'last'), 'ArrowDown'));
    expect(document.activeElement).toBe(items()[0] ?? null);
    await interact(() => pressKey(must(items()[0], 'first'), 'ArrowDown'));
    expect(document.activeElement).toBe(items()[1] ?? null);
    await view.unmount();
  });

  it('leaves other keys alone, and arrows pressed outside the choices', async () => {
    const { view, trigger, items } = await open();
    await interact(() => trigger.click());
    await interact(() => pressKey(must(items()[0], 'first'), 'a'));
    expect(document.activeElement).toBe(items()[0] ?? null);
    await interact(() => must(items()[3], 'Custom…').click());
    const field = must(view.container.querySelector<HTMLInputElement>('input'), 'the field');
    field.focus();
    await interact(() => pressKey(field, 'ArrowDown'));
    expect(document.activeElement).toBe(field);
    await view.unmount();
  });

  it('closes on a press outside, and stays open for a press inside', async () => {
    const { view, trigger, items } = await open();
    await interact(() => trigger.click());
    await interact(() => must(items()[0], 'first').dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(items()).toHaveLength(4);
    await interact(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(items()).toEqual([]);
    await view.unmount();
  });

  it('cannot be opened while disabled', async () => {
    const { view, trigger } = await open({ disabled: true });
    expect(trigger.disabled).toBe(true);
    await view.unmount();
  });
});
