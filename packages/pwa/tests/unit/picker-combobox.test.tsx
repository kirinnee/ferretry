import { afterEach, describe, expect, it } from 'bun:test';
import { useState } from 'react';
import { defaultPickerRow, PickerCombobox, type PickerComboboxProps } from '../../src/shell/picker-combobox.tsx';
import type { PickerOption, PickerSource } from '../../src/shell/picker-model.ts';
import { interact, type Mounted, mount, must, pressKey } from '../support/dom.ts';

/** A consumer's own row shape: the primitive never learns what `badge` means. */
interface TestOption extends PickerOption {
  readonly badge?: string;
}

const accounts: readonly TestOption[] = [
  { value: 'claude-auto-loge', label: 'claude-auto-loge', search: 'claude-auto-loge claude', detail: '5h 12%' },
  {
    value: 'codex-auto-atomi',
    label: 'codex-auto-atomi',
    search: 'codex-auto-atomi codex',
    detail: 'account default',
    badge: 'quota',
  },
  {
    value: 'glm-mass',
    label: 'glm-mass',
    search: 'glm-mass glm',
    disabled: true,
    disabledReason: 'no wrapper on PATH',
  },
];

const ready: PickerSource<TestOption> = { kind: 'ready', options: accounts };

interface Harness {
  readonly mounted: Mounted;
  /** Every value the control pushed out, in order. */
  readonly values: string[];
  /** Every row that was CHOSEN rather than typed. */
  readonly selected: TestOption[];
}

let live: Mounted | undefined;

afterEach(async () => {
  await live?.unmount();
  live = undefined;
});

type Overrides = Partial<Omit<PickerComboboxProps<TestOption>, 'value' | 'onValueChange'>> & {
  readonly initialValue?: string;
};

/**
 * Mounts the control with a real value owner, because "the typed value is the
 * source of truth" is only testable against something that actually holds it.
 */
const picker = async (overrides: Overrides = {}): Promise<Harness> => {
  const { initialValue = '', ...props } = overrides;
  const values: string[] = [];
  const selected: TestOption[] = [];

  function Host() {
    const [value, setValue] = useState(initialValue);
    return (
      <PickerCombobox<TestOption>
        label="Account"
        onSelect={option => selected.push(option)}
        onValueChange={next => {
          values.push(next);
          setValue(next);
        }}
        source={ready}
        value={value}
        {...props}
      />
    );
  }

  const mounted = await mount(<Host />);
  live = mounted;
  return { mounted, values, selected };
};

const input = (): HTMLInputElement => {
  const element = document.querySelector('input[role="combobox"]');
  if (!(element instanceof HTMLInputElement)) throw new Error('the picker input is not mounted');
  return element;
};

const focus = async (): Promise<void> => {
  await interact(() => input().focus());
};

/** Focuses the control, which is what reveals the list. */
const open = async (overrides: Overrides = {}): Promise<Harness> => {
  const harness = await picker(overrides);
  await focus();
  return harness;
};

const type = async (value: string): Promise<void> => {
  const field = input();
  await interact(() => {
    // React listens for `input`, and the value has to be set before it fires.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const rowIds = (): string[] =>
  [...document.querySelectorAll('[role="option"]')].map(node => node.getAttribute('id') ?? '');

/** The id at one position, or a failure naming the gap rather than an undefined. */
const rowId = (index: number): string => {
  const ids = rowIds();
  const id = ids[index];
  if (id === undefined) throw new Error(`no row at index ${index} of ${ids.length}`);
  return id;
};

const listbox = (): Element | null => document.querySelector('[role="listbox"]');

/** The popover itself — the element `aria-expanded` is announcing. */
const panel = (): Element | null => document.querySelector('[data-picker-state]');

const panelState = (): string | null =>
  document.querySelector('[data-picker-state]')?.getAttribute('data-picker-state') ?? null;

const statusText = (): string => document.querySelector('[role="status"]')?.textContent ?? '';

const activeId = (): string | null => input().getAttribute('aria-activedescendant');

/** Presses a row the way a real pointer does: pointer-up after a matching down. */
const pressRow = async (index: number): Promise<void> => {
  const row = must(document.getElementById(rowId(index)), `row ${index}`);
  await interact(() => {
    for (const kind of ['pointerdown', 'pointerup']) {
      const event = new Event(kind, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 4 });
      row.dispatchEvent(event);
    }
  });
};

describe('the resting control', () => {
  it('is an editable combobox that says its list is closed', async () => {
    await picker();

    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(input().getAttribute('aria-autocomplete')).toBe('list');
    expect(input().getAttribute('aria-label')).toBe('Account');
    expect(input().hasAttribute('disabled')).toBe(false);
    expect(listbox()).toBeNull();
  });

  it('generates a collision-free id when the caller does not own one', async () => {
    await picker();

    expect(input().id).toMatch(/^fy-picker-/);
    // The generated base must survive a selector, which a raw useId value would not.
    expect(document.querySelector(`#${input().id}`)).toBe(input());
  });

  it('uses a caller-supplied id verbatim, so its own visible label still points here', async () => {
    await picker({ id: 'fy-new-session-agent' });

    expect(input().id).toBe('fy-new-session-agent');
  });

  it('passes the placeholder, description and extra classes through', async () => {
    await picker({ placeholder: 'claude-auto-loge', describedBy: 'agent-help', inputClassName: 'mono' });

    expect(input().getAttribute('placeholder')).toBe('claude-auto-loge');
    expect(input().getAttribute('aria-describedby')).toBe('agent-help');
    expect(input().className).toContain('mono');
  });
});

describe('the offered list', () => {
  it('reveals itself on focus and names itself after the field', async () => {
    await open();

    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(must(listbox(), 'the listbox').getAttribute('aria-label')).toBe('Account choices');
    expect(rowIds().length).toBe(3);
  });

  it('points the combobox at the first pickable row', async () => {
    await open();

    expect(activeId()).toBe(rowId(0));
    // The panel is the controlled popup in every state, so the reference does not
    // change target as the list comes and goes. The list itself lives inside it,
    // which is what keeps that reference meaningful.
    const controlled = must(panel(), 'the panel');
    expect(input().getAttribute('aria-controls')).toBe(controlled.getAttribute('id'));
    expect(controlled.contains(must(listbox(), 'the listbox'))).toBe(true);
  });

  it('marks exactly one row selected and the unavailable one disabled', async () => {
    await open();
    const options = [...document.querySelectorAll('[role="option"]')];

    expect(options.filter(node => node.getAttribute('aria-selected') === 'true').length).toBe(1);
    expect(options[2]?.getAttribute('aria-disabled')).toBe('true');
    expect(options[0]?.hasAttribute('aria-disabled')).toBe(false);
  });

  it('closes again when the field loses focus', async () => {
    await open();

    await interact(() => input().blur());

    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(listbox()).toBeNull();
  });

  it('filters as the reader types, and keeps every row reachable by keyboard', async () => {
    await open();

    await type('codex');

    expect(rowIds().length).toBe(1);
    expect(document.querySelector('[role="option"]')?.textContent).toContain('codex-auto-atomi');
  });
});

describe('keyboard navigation', () => {
  it('moves down, skipping the unavailable row, and wraps', async () => {
    await open();

    await interact(() => pressKey(input(), 'ArrowDown'));
    expect(activeId()).toBe(rowId(1));

    // Row three is unavailable, so the next press returns to the top.
    await interact(() => pressKey(input(), 'ArrowDown'));
    expect(activeId()).toBe(rowId(0));
  });

  it('moves up from the first row to the last pickable one', async () => {
    await open();

    await interact(() => pressKey(input(), 'ArrowUp'));

    expect(activeId()).toBe(rowId(1));
  });

  it('jumps to the ends with Home and End', async () => {
    await open();

    await interact(() => pressKey(input(), 'End'));
    expect(activeId()).toBe(rowId(1));

    await interact(() => pressKey(input(), 'Home'));
    expect(activeId()).toBe(rowId(0));
  });

  it('reveals a dismissed list again on ArrowDown, without a second keystroke', async () => {
    await open();

    await interact(() => pressKey(input(), 'Escape'));
    expect(listbox()).toBeNull();

    await interact(() => pressKey(input(), 'ArrowDown'));
    expect(listbox()).not.toBeNull();
    expect(activeId()).toBe(rowId(0));
  });

  it('leaves the caret in the field when Escape dismisses the list', async () => {
    await open();

    await interact(() => pressKey(input(), 'Escape'));

    expect(document.activeElement).toBe(input());
    expect(input().getAttribute('aria-expanded')).toBe('false');
  });

  it('commits the active row on Enter, and reports which row it was', async () => {
    const harness = await open();

    await interact(() => pressKey(input(), 'Enter'));

    expect(harness.values).toEqual(['claude-auto-loge']);
    expect(harness.selected.map(option => option.value)).toEqual(['claude-auto-loge']);
    expect(input().value).toBe('claude-auto-loge');
    // A completed answer gets out of the way, without ejecting the caret.
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(input());
  });

  it('refuses Enter on an unavailable row, so nothing replaces what was typed', async () => {
    const harness = await open({ initialValue: 'glm' });

    await interact(() => pressKey(input(), 'Enter'));

    expect(harness.values).toEqual([]);
    expect(input().value).toBe('glm');
  });

  it('leaves every key alone while an IME candidate window is up', async () => {
    await open();

    await interact(() => pressKey(input(), 'ArrowDown', { isComposing: true }));

    expect(activeId()).toBe(rowId(0));
  });

  it('ignores a key it does not answer to', async () => {
    const harness = await open();

    await interact(() => pressKey(input(), 'Tab'));

    expect(harness.values).toEqual([]);
    expect(activeId()).toBe(rowId(0));
  });
});

describe('the pointer', () => {
  it('commits a row on pointer-up', async () => {
    const harness = await open();

    await pressRow(1);

    expect(harness.values).toEqual(['codex-auto-atomi']);
    expect(harness.selected.map(option => option.value)).toEqual(['codex-auto-atomi']);
  });

  it('does nothing at all for an unavailable row, not even closing the list', async () => {
    const harness = await open();

    await pressRow(2);

    expect(harness.values).toEqual([]);
    expect(listbox()).not.toBeNull();
  });

  it('does not commit a row whose press was cancelled out from under it', async () => {
    const harness = await open();
    const row = must(document.getElementById(rowId(0)), 'the first row');

    await interact(() => {
      for (const kind of ['pointerdown', 'pointercancel', 'pointerup']) {
        const event = new Event(kind, { bubbles: true, cancelable: true });
        Object.assign(event, { pointerId: 4 });
        row.dispatchEvent(event);
      }
    });

    expect(harness.values).toEqual([]);
  });

  it('keeps the caret in the field by refusing the default pointer-down', async () => {
    await open();
    const row = must(document.getElementById(rowId(0)), 'the first row');
    const down = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(down, { pointerId: 4 });

    await interact(() => row.dispatchEvent(down));

    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());
  });

  it('makes a hovered row the active one, so the pointer and the keyboard agree', async () => {
    await open();
    const row = must(document.getElementById(rowId(1)), 'the second row');

    await interact(() => row.dispatchEvent(new Event('pointermove', { bubbles: true })));

    expect(activeId()).toBe(rowId(1));
  });

  it('commits without a selection listener, because the value is the output', async () => {
    const harness = await open({ onSelect: undefined });

    await pressRow(0);

    expect(harness.values).toEqual(['claude-auto-loge']);
    expect(harness.selected).toEqual([]);
  });
});

/**
 * `aria-expanded` announces that a popup is showing. `aria-controls` has to name
 * the popup that IS showing — and in four of the five open states that is a notice
 * rather than a listbox, so pointing at the listbox id would reference an element
 * absent from the document. A dangling reference is worse than none: it sends a
 * reader somewhere that does not exist.
 *
 * `aria-activedescendant` is the opposite case. It names a CURSOR, and only a real
 * list has one, so it must stay absent in every other state.
 */
describe('what aria-expanded promises, in every state', () => {
  const cases = [
    { what: 'loading', source: { kind: 'loading' } as PickerSource<TestOption>, list: false },
    {
      what: 'failed',
      source: { kind: 'failed', reason: 'the daemon refused the read' } as PickerSource<TestOption>,
      list: false,
    },
    { what: 'empty', source: { kind: 'ready', options: [] } as PickerSource<TestOption>, list: false },
    { what: 'options', source: ready, list: true },
  ] as const;

  for (const scenario of cases) {
    it(`points aria-controls at the mounted panel while ${scenario.what}`, async () => {
      await open({ source: scenario.source });

      const id = must(panel(), 'the panel').getAttribute('id');
      expect(id).not.toBeNull();
      expect(id).toMatch(/-panel$/u);
      expect(input().getAttribute('aria-expanded')).toBe('true');
      expect(input().getAttribute('aria-controls')).toBe(id);
      // The reference resolves: nothing here is announcing an element that is
      // not in the document.
      expect(document.getElementById(id as string)).not.toBeNull();
      // Only a real list has a cursor to point at.
      expect(input().getAttribute('aria-activedescendant') === null).toBe(!scenario.list);
    });
  }

  it('points aria-controls at the mounted panel with a query that matched nothing', async () => {
    await open();
    await type('nothing-matches-this');

    expect(panelState()).toBe('no-match');
    const id = must(panel(), 'the panel').getAttribute('id');
    expect(input().getAttribute('aria-controls')).toBe(id);
    expect(document.getElementById(id as string)).not.toBeNull();
    expect(input().getAttribute('aria-activedescendant')).toBeNull();
  });

  it('claims no popup and controls nothing while closed', async () => {
    await picker();

    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(panel()).toBeNull();
    expect(input().getAttribute('aria-controls')).toBeNull();
    expect(input().getAttribute('aria-activedescendant')).toBeNull();
  });

  it('gives two pickers on one page distinct panel ids', async () => {
    function Pair() {
      return (
        <>
          <PickerCombobox<TestOption> label="Account" onValueChange={() => undefined} source={ready} value="" />
          <PickerCombobox<TestOption> label="Project" onValueChange={() => undefined} source={ready} value="" />
        </>
      );
    }
    live = await mount(<Pair />);
    const fields = [...document.querySelectorAll('input[role="combobox"]')];
    await interact(() => (fields[0] as HTMLInputElement).focus());
    const first = must(panel(), 'the first panel').getAttribute('id');
    await interact(() => (fields[1] as HTMLInputElement).focus());
    const second = must(panel(), 'the second panel').getAttribute('id');

    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
  });
});

describe('the four states that are not a list', () => {
  it('says a read is still running, and keeps the field editable', async () => {
    await open({ source: { kind: 'loading' } });

    expect(panelState()).toBe('loading');
    expect(listbox()).toBeNull();
    // The popup that IS showing, rather than the list that is not: see the
    // aria-controls suite below for the whole table.
    expect(input().getAttribute('aria-controls')).toBe(must(panel(), 'the panel').getAttribute('id'));
    expect(input().getAttribute('aria-activedescendant')).toBeNull();
    expect(input().hasAttribute('disabled')).toBe(false);
    expect(statusText()).toBe('Reading the available choices…');
  });

  it('reports a failed read in the daemon words, as an alert rather than an empty list', async () => {
    await open({ source: { kind: 'failed', reason: 'the daemon refused this browser the fleet read' } });

    expect(panelState()).toBe('failed');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'the daemon refused this browser the fleet read',
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('still accepts a typed value');
    expect(statusText()).toBe('The available choices could not be read. Type a value instead.');
  });

  it('still accepts a typed value after a failed read', async () => {
    const harness = await open({ source: { kind: 'failed', reason: 'HTTP 500' } });

    await type('claude-typed-by-hand');

    expect(harness.values).toEqual(['claude-typed-by-hand']);
    expect(input().value).toBe('claude-typed-by-hand');
  });

  it('distinguishes a host that published nothing from a read that failed', async () => {
    await open({ source: { kind: 'ready', options: [] } });

    expect(panelState()).toBe('empty');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(statusText()).toBe('Nothing is published to choose from. Type a value instead.');
  });

  it('lets the consumer word the empty case, which is the only domain-specific one', async () => {
    await open({ source: { kind: 'ready', options: [] }, emptyNotice: 'This daemon publishes no accounts.' });

    expect(document.querySelector('[data-picker-state="empty"]')?.textContent).toContain(
      'This daemon publishes no accounts.',
    );
  });

  /**
   * A consumer that FILTERED its own options knows the list is empty because of
   * the filter rather than because of the host — a fact this control cannot see,
   * and one a screen-reader user needs as much as a sighted one.
   */
  it('lets the consumer word the SPOKEN empty case too, so both channels agree', async () => {
    await open({
      source: { kind: 'ready', options: [] },
      emptyNotice: 'This daemon publishes no Codex accounts.',
      emptyStatus: 'This daemon publishes no Codex accounts, though it publishes others.',
    });

    expect(statusText()).toBe('This daemon publishes no Codex accounts, though it publishes others.');
    expect(statusText()).not.toContain('Nothing is published');
  });

  it('keeps the model sentence spoken when only the visible half was overridden', async () => {
    await open({ source: { kind: 'ready', options: [] }, emptyNotice: 'no Codex accounts here' });

    expect(statusText()).toBe('Nothing is published to choose from. Type a value instead.');
  });

  it('never lets an overridden empty sentence swallow the staleness warning', async () => {
    await open({
      source: { kind: 'ready', options: [], staleReason: 'the last refresh failed' },
      emptyStatus: 'This daemon publishes no Codex accounts.',
    });

    expect(statusText()).toBe('This daemon publishes no Codex accounts. These choices may be out of date.');
  });

  it('speaks a consumer empty sentence only in the empty state', async () => {
    await open({ source: { kind: 'loading' }, emptyStatus: 'This daemon publishes no Codex accounts.' });

    expect(statusText()).toBe('Reading the available choices…');
  });

  it('falls back to generic wording when the consumer supplies none', async () => {
    await open({ source: { kind: 'ready', options: [] } });

    expect(document.querySelector('[data-picker-state="empty"]')?.textContent).toContain(
      'Nothing is published to choose from.',
    );
  });

  it('says a query matched nothing, and that it is submitted as typed anyway', async () => {
    await open();

    await type('zzz');

    expect(panelState()).toBe('no-match');
    expect(document.querySelector('[data-picker-state="no-match"]')?.textContent).toContain('zzz');
    expect(statusText()).toBe('Nothing matches zzz. Type a value instead.');
  });

  it('lets the consumer word the no-match case too', async () => {
    await open({ noMatchNotice: 'No registered project and no recent folder matches.' });

    await type('zzz');

    expect(document.querySelector('[data-picker-state="no-match"]')?.textContent).toContain(
      'No registered project and no recent folder matches.',
    );
    // The spoken wording is model-owned, so the query survives the override.
    expect(statusText()).toBe('Nothing matches zzz. Type a value instead.');
  });
});

describe('rows that are usable but stale', () => {
  const stale: PickerSource<TestOption> = {
    kind: 'ready',
    options: accounts,
    staleReason: 'the last refresh failed, so this roster may be out of date',
  };

  it('shows the warning ABOVE the rows rather than instead of them', async () => {
    await open({ source: stale });

    expect(panelState()).toBe('options');
    expect(rowIds().length).toBe(3);
    expect(must(document.querySelector('[data-picker-stale="true"]'), 'the stale strip').textContent).toContain(
      'the last refresh failed',
    );
  });

  it('leaves the rows pickable, because last-good rows are still worth using', async () => {
    const harness = await open({ source: stale });

    await pressRow(0);

    expect(harness.values).toEqual(['claude-auto-loge']);
  });

  it('is not an alert, because the list below is still usable', async () => {
    await open({ source: stale });

    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('speaks the staleness too, for a reader who cannot see the strip', async () => {
    await open({ source: stale });

    expect(statusText()).toBe('3 choices available. These choices may be out of date.');
  });

  it('keeps warning while a query narrows the stale roster to nothing', async () => {
    await open({ source: stale });

    await type('zzz');

    expect(panelState()).toBe('no-match');
    expect(document.querySelector('[data-picker-stale="true"]')).not.toBeNull();
  });

  it('draws no strip at all for a fresh read', async () => {
    await open();

    expect(document.querySelector('[data-picker-stale="true"]')).toBeNull();
  });
});

describe('the live region', () => {
  it('counts the offered rows for a reader who cannot see them', async () => {
    await open();

    expect(statusText()).toBe('3 choices available.');
  });

  it('follows the filter down to the singular', async () => {
    await open();

    await type('codex');

    expect(statusText()).toBe('1 choice available.');
  });

  it('is spoken politely and never shown', async () => {
    await open();
    const region = must(document.querySelector('[role="status"]'), 'the live region');

    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.className).toContain('sr-only');
  });
});

describe('row rendering', () => {
  it('draws the label, the detail line and the reason a row is unavailable', async () => {
    await open();
    const options = [...document.querySelectorAll('[role="option"]')];

    expect(options[0]?.textContent).toContain('claude-auto-loge');
    expect(options[0]?.textContent).toContain('5h 12%');
    expect(options[2]?.textContent).toContain('no wrapper on PATH');
  });

  it('omits the two optional lines when a row carries neither', async () => {
    await open({ source: { kind: 'ready', options: [{ value: 'bare', label: 'bare', search: 'bare' }] } });

    expect(document.querySelector('[role="option"]')?.textContent).toBe('bare');
  });

  it('hands rendering to the consumer, so quota and provenance stay out of the primitive', async () => {
    await open({
      renderOption: (option, state) => (
        <span data-row-active={state.active ? 'true' : 'false'}>
          {option.label}
          {option.badge === undefined ? '' : ` · ${option.badge}`}
        </span>
      ),
    });
    const options = [...document.querySelectorAll('[role="option"]')];

    expect(options[1]?.textContent).toBe('codex-auto-atomi · quota');
    expect(options[0]?.querySelector('[data-row-active="true"]')).not.toBeNull();
    expect(options[1]?.querySelector('[data-row-active="false"]')).not.toBeNull();
  });

  it('tells a row whether the box already holds its value, separately from the cursor', async () => {
    // The cursor is on row one; the committed value is row two's.
    await open({
      initialValue: 'codex-auto-atomi',
      renderOption: (option, state) => <span data-row-current={state.selected ? 'true' : 'false'}>{option.label}</span>,
    });
    const row = must(document.querySelector('[role="option"]'), 'the only matching row');

    expect(row.querySelector('[data-row-current="true"]')).not.toBeNull();
    // `aria-selected` stays the cursor, which is what ARIA reserves it for.
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(row.getAttribute('data-current')).toBe('true');
  });

  it('marks no row current when the typed value is nobody exactly', async () => {
    await open({ initialValue: 'codex' });

    expect(document.querySelector('[role="option"]')?.hasAttribute('data-current')).toBe(false);
  });

  it('exports its default row so a custom one can compose rather than restate it', () => {
    expect(defaultPickerRow({ value: 'one', label: 'one', search: 'one' })).not.toBeNull();
  });
});
