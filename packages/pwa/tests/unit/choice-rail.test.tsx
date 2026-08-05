import { describe, expect, it } from 'bun:test';

import { ChoiceRail, type ChoiceRailItem } from '../../src/shell/choice-rail.tsx';
import { interact, mount, must, pressKey } from '../support/dom.ts';

type PanelId = 'warden' | 'secrets' | 'doctor';

const items: readonly ChoiceRailItem<PanelId>[] = [
  { id: 'warden', label: 'Warden', detail: 'Supervision and policy for this daemon.' },
  { id: 'secrets', label: 'Secrets', icon: <svg aria-hidden="true" data-row-icon="secrets" /> },
  { id: 'doctor', label: 'Doctor', detail: 'Dependency and environment checks.' },
];

interface Calls {
  readonly selected: PanelId[];
}

const rows = (container: HTMLElement): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('[data-panel]'),
];

const row = (container: HTMLElement, id: PanelId): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>(`[data-panel="${id}"]`), `the ${id} row`);

const navigation = (calls: Calls, activeId: PanelId = 'warden', truncate = false) => (
  <ChoiceRail
    items={items}
    activeId={activeId}
    marker="data-panel"
    truncate={truncate}
    onSelect={id => calls.selected.push(id)}
  />
);

const tabs = (calls: Calls, activeId: PanelId = 'warden', list: readonly ChoiceRailItem<PanelId>[] = items) => (
  <ChoiceRail
    presentation="tabs"
    items={list}
    activeId={activeId}
    marker="data-panel"
    label="Alpha settings panels"
    tabIdPrefix="panel-tab-"
    panelIdPrefix="panel-body-"
    onSelect={id => calls.selected.push(id)}
  />
);

describe('ChoiceRail navigation presentation', () => {
  it('is a list of ordinary buttons that mark the active row without claiming a tab role', async () => {
    const view = await mount(navigation({ selected: [] }, 'secrets'));

    expect(view.container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(view.container.querySelector('[role="tablist"]')).toBeNull();
    expect(rows(view.container).map(button => button.getAttribute('data-panel'))).toEqual([
      'warden',
      'secrets',
      'doctor',
    ]);
    expect(rows(view.container).map(button => button.getAttribute('aria-current'))).toEqual([null, 'page', null]);
    // A navigation row is not a tab stop puzzle: every row is reachable.
    expect(rows(view.container).map(button => button.getAttribute('tabindex'))).toEqual([null, null, null]);
    expect(view.container.querySelectorAll('li')).toHaveLength(3);

    await view.unmount();
  });

  it('writes the caller’s data marker and reports the row that was clicked', async () => {
    const calls: Calls = { selected: [] };
    const view = await mount(navigation(calls));

    await interact(() => row(view.container, 'doctor').click());
    // An already-active navigation row still reports: a sheet closes on select.
    await interact(() => row(view.container, 'warden').click());

    expect(calls.selected).toEqual(['doctor', 'warden']);
    await view.unmount();
  });

  it('renders a second line only for a row that has one, and an icon before the label', async () => {
    const view = await mount(navigation({ selected: [] }));
    const warden = row(view.container, 'warden');
    const secrets = row(view.container, 'secrets');

    expect(warden.textContent).toContain('Supervision and policy for this daemon.');
    expect(secrets.querySelector('[data-row-icon="secrets"]')).not.toBeNull();
    expect(secrets.textContent).toBe('Secrets');
    expect(secrets.querySelectorAll('span span')).toHaveLength(1);

    await view.unmount();
  });

  it('clips both lines only when the caller asks for truncation', async () => {
    const wrapping = await mount(navigation({ selected: [] }));
    const wrappingLines = [...row(wrapping.container, 'warden').querySelectorAll('span span')];
    expect(wrappingLines.map(line => line.className.includes('truncate'))).toEqual([false, false]);
    await wrapping.unmount();

    const clipping = await mount(navigation({ selected: [] }, 'warden', true));
    const clippedLines = [...row(clipping.container, 'warden').querySelectorAll('span span')];
    expect(clippedLines.map(line => line.className.includes('truncate'))).toEqual([true, true]);
    await clipping.unmount();
  });
});

describe('ChoiceRail tabs presentation', () => {
  it('is a vertical tablist whose rows own stable ids and name the panel they control', async () => {
    const view = await mount(tabs({ selected: [] }, 'secrets'));
    const tablist = must(view.container.querySelector<HTMLElement>('[role="tablist"]'), 'the tablist');

    expect(tablist.getAttribute('aria-orientation')).toBe('vertical');
    expect(tablist.getAttribute('aria-label')).toBe('Alpha settings panels');
    expect(view.container.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(rows(view.container).map(tab => tab.id)).toEqual([
      'panel-tab-warden',
      'panel-tab-secrets',
      'panel-tab-doctor',
    ]);
    expect(rows(view.container).map(tab => tab.getAttribute('aria-controls'))).toEqual([
      'panel-body-warden',
      'panel-body-secrets',
      'panel-body-doctor',
    ]);
    expect(rows(view.container).map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    // Roving tabindex: one stop, on the selected tab.
    expect(rows(view.container).map(tab => tab.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(rows(view.container).every(tab => tab.getAttribute('aria-current') === null)).toBe(true);

    await view.unmount();
  });

  it('keeps one tab stop on the first row when the active id names no row at all', async () => {
    // A dynamically supplied panel can disappear. A rail with zero tab stops
    // would be unreachable from the keyboard, which is worse than a wrong one.
    const view = await mount(tabs({ selected: [] }, 'warden', [items[1] as ChoiceRailItem<PanelId>]));

    expect(rows(view.container).map(tab => tab.getAttribute('tabindex'))).toEqual(['0']);
    expect(rows(view.container).map(tab => tab.getAttribute('aria-selected'))).toEqual(['false']);
    await view.unmount();
  });

  it('selects an unselected tab on click and stays silent on the selected one', async () => {
    const calls: Calls = { selected: [] };
    const view = await mount(tabs(calls));

    await interact(() => row(view.container, 'doctor').click());
    await interact(() => row(view.container, 'warden').click());

    expect(calls.selected).toEqual(['doctor']);
    await view.unmount();
  });

  it('walks the rail with the vertical arrows, Home and End, wrapping at both ends', async () => {
    const calls: Calls = { selected: [] };
    const view = await mount(tabs(calls));

    await interact(() => pressKey(row(view.container, 'warden'), 'ArrowDown'));
    await interact(() => pressKey(row(view.container, 'warden'), 'ArrowUp'));
    await interact(() => pressKey(row(view.container, 'warden'), 'End'));
    await interact(() => pressKey(row(view.container, 'doctor'), 'Home'));
    // A vertical rail still answers the horizontal arrows: the ported policy is
    // one keyboard contract, and a reader who tries ArrowRight is not wrong.
    await interact(() => pressKey(row(view.container, 'warden'), 'ArrowRight'));
    await interact(() => pressKey(row(view.container, 'warden'), 'ArrowLeft'));

    expect(calls.selected).toEqual(['secrets', 'doctor', 'doctor', 'warden', 'secrets', 'doctor']);
    await view.unmount();
  });

  it('leaves every other key to the browser', async () => {
    const calls: Calls = { selected: [] };
    const view = await mount(tabs(calls));
    const warden = row(view.container, 'warden');

    const claimed = warden.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(claimed).toBe(true);
    expect(calls.selected).toEqual([]);
    await view.unmount();
  });

  it('claims the keys it handles so the settings scroller does not also move', async () => {
    const view = await mount(tabs({ selected: [] }));
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });

    await interact(() => row(view.container, 'warden').dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    await view.unmount();
  });

  it('moves focus onto the newly selected tab, but only while the rail already holds focus', async () => {
    const view = await mount(tabs({ selected: [] }));

    // Nothing in the rail is focused: a re-render must not steal focus from the
    // panel the reader is working in.
    await view.render(tabs({ selected: [] }, 'secrets'));
    expect(document.activeElement).not.toBe(row(view.container, 'secrets'));

    row(view.container, 'secrets').focus();
    await view.render(tabs({ selected: [] }, 'doctor'));
    expect(document.activeElement).toBe(row(view.container, 'doctor'));

    await view.unmount();
  });

  it('releases a row element when the row goes away', async () => {
    const view = await mount(tabs({ selected: [] }, 'secrets'));
    row(view.container, 'secrets').focus();

    // Dropping the focused row and re-selecting must not resurrect a detached
    // element: the ref map has to have let go of it.
    await view.render(
      tabs({ selected: [] }, 'doctor', [items[0] as ChoiceRailItem<PanelId>, items[2] as ChoiceRailItem<PanelId>]),
    );

    expect(rows(view.container).map(tab => tab.getAttribute('data-panel'))).toEqual(['warden', 'doctor']);
    expect(document.activeElement).toBe(document.body);
    await view.unmount();
  });
});
