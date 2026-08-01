import { describe, expect, test } from 'bun:test';
import type { ModeFilter } from '../../src/lib/controls.ts';
import type { ModeCounts } from '../../src/lib/fleet-grouping.ts';
import {
  FleetFilters,
  type FleetFilterValues,
  MODE_SEGMENT_ORDER,
  ModeSegment,
  modeSegmentTitle,
} from '../../src/shell/fleet-filters.tsx';
import { interact, mount, must, pressKey } from '../support/dom.ts';

const counts: ModeCounts = { all: 7, auto: 5, interactive: 2 };

const values: FleetFilterValues = { query: '', mode: 'all', rcOnly: false, includeFinished: false };

const buttonsOf = (container: HTMLElement) => [...container.querySelectorAll('button')];
const byText = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    buttonsOf(container).find(button => (button.textContent ?? '').includes(text)),
    `a button reading ${text}`,
  );
const searchOf = (container: HTMLElement): HTMLInputElement =>
  must(container.querySelector('input[type="text"]'), 'the search box');

const typeInto = async (input: HTMLInputElement, value: string): Promise<void> => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await interact(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('modeSegmentTitle', () => {
  test('says a count is what the OTHER filters would still allow, not a fleet total', () => {
    expect(modeSegmentTitle('all', counts)).toBe('every session matching the current search and filters (7)');
    expect(modeSegmentTitle('auto', counts)).toContain('5 match the current search and filters');
    expect(modeSegmentTitle('interactive', counts)).toContain('2 match the current search and filters');
  });
});

describe('ModeSegment', () => {
  test('offers the three modes in order, each with its count', async () => {
    const screen = await mount(<ModeSegment counts={counts} onChange={() => undefined} value="auto" />);
    const buttons = buttonsOf(screen.container);
    expect(buttons.map(button => button.textContent)).toEqual(['All7', 'Auto5', 'Interactive2']);
    expect(MODE_SEGMENT_ORDER).toEqual(['all', 'auto', 'interactive']);
    await screen.unmount();
  });

  test('is a labelled toolbar of pressed toggles, not a tablist that arrows cannot drive', async () => {
    const screen = await mount(<ModeSegment counts={counts} onChange={() => undefined} value="auto" />);
    const toolbar = must(screen.container.querySelector('[role="toolbar"]'), 'the segment');
    expect(toolbar.getAttribute('aria-label')).toBe('Filter by mode');
    expect(byText(screen.container, 'Auto').getAttribute('aria-pressed')).toBe('true');
    expect(byText(screen.container, 'All').getAttribute('aria-pressed')).toBe('false');
    await screen.unmount();
  });

  test('reports the mode that was pressed', async () => {
    const picked: ModeFilter[] = [];
    const screen = await mount(<ModeSegment counts={counts} onChange={mode => picked.push(mode)} value="all" />);
    await interact(() => byText(screen.container, 'Interactive').dispatchEvent(new Event('click', { bubbles: true })));
    expect(picked).toEqual(['interactive']);
    await screen.unmount();
  });

  test('renders the caller’s glyphs without importing a second icon set', async () => {
    const screen = await mount(
      <ModeSegment
        counts={counts}
        iconFor={mode => (mode === 'auto' ? <span data-glyph="cpu" /> : null)}
        onChange={() => undefined}
        value="all"
      />,
    );
    expect(screen.container.querySelectorAll('[data-glyph="cpu"]').length).toBe(1);
    await screen.unmount();
  });
});

describe('FleetFilters', () => {
  const render = async (overrides: Partial<Parameters<typeof FleetFilters>[0]> = {}) =>
    mount(<FleetFilters counts={counts} onChange={() => undefined} values={values} {...overrides} />);

  test('says the box does two things, and never becomes a WebKit search input', async () => {
    const screen = await render();
    const input = searchOf(screen.container);
    expect(input.getAttribute('aria-label')).toBe('Search sessions — Enter also searches transcripts');
    expect(input.type).toBe('text');
    await screen.unmount();
  });

  test('narrows the fleet as the reader types', async () => {
    const patches: Partial<FleetFilterValues>[] = [];
    const screen = await render({ onChange: patch => patches.push(patch) });
    await typeInto(searchOf(screen.container), 'scroll');
    expect(patches).toEqual([{ query: 'scroll' }]);
    await screen.unmount();
  });

  test('Enter runs the daemon-side transcript search the instant filter is not', async () => {
    const searched: string[] = [];
    const screen = await render({
      onSearchSubmit: query => searched.push(query),
      values: { ...values, query: 'boot' },
    });
    await interact(() => pressKey(searchOf(screen.container), 'Enter'));
    expect(searched).toEqual(['boot']);
    await screen.unmount();
  });

  test('Escape clears the box and the daemon-side results together', async () => {
    const patches: Partial<FleetFilterValues>[] = [];
    const cleared: string[] = [];
    const screen = await render({
      onChange: patch => patches.push(patch),
      onSearchClear: () => cleared.push('cleared'),
      values: { ...values, query: 'boot' },
    });
    await interact(() => pressKey(searchOf(screen.container), 'Escape'));
    expect(patches).toEqual([{ query: '' }]);
    expect(cleared).toEqual(['cleared']);
    await screen.unmount();
  });

  test('ignores every other key', async () => {
    const searched: string[] = [];
    const screen = await render({ onSearchSubmit: query => searched.push(query) });
    await interact(() => pressKey(searchOf(screen.container), 'a'));
    expect(searched).toEqual([]);
    await screen.unmount();
  });

  test('offers a clear button only while there is something to clear', async () => {
    const empty = await render();
    expect(empty.container.querySelector('[aria-label="Clear search"]')).toBeNull();
    await empty.unmount();

    const patches: Partial<FleetFilterValues>[] = [];
    const cleared: string[] = [];
    const filled = await render({
      onChange: patch => patches.push(patch),
      onSearchClear: () => cleared.push('cleared'),
      values: { ...values, query: 'boot' },
    });
    await interact(() =>
      must(filled.container.querySelector('[aria-label="Clear search"]'), 'the clear button').dispatchEvent(
        new Event('click', { bubbles: true }),
      ),
    );
    expect(patches).toEqual([{ query: '' }]);
    expect(cleared).toEqual(['cleared']);
    await filled.unmount();
  });

  test('toggles the RC filter and include-finished through the same patch channel', async () => {
    const patches: Partial<FleetFilterValues>[] = [];
    const screen = await render({ onChange: patch => patches.push(patch) });
    await interact(() => byText(screen.container, 'rc only').dispatchEvent(new Event('click', { bubbles: true })));

    const checkbox = must(screen.container.querySelector('input[type="checkbox"]'), 'the finished checkbox');
    const checkedSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    await interact(() => {
      checkedSetter?.call(checkbox, true);
      checkbox.dispatchEvent(new Event('click', { bubbles: true }));
    });

    expect(patches).toEqual([{ rcOnly: true }, { includeFinished: true }]);
    await screen.unmount();
  });

  test('shows the RC filter as pressed when it is on', async () => {
    const screen = await render({ values: { ...values, rcOnly: true } });
    expect(byText(screen.container, 'rc only').getAttribute('aria-pressed')).toBe('true');
    await screen.unmount();
  });

  test('changes the mode from the segment', async () => {
    const patches: Partial<FleetFilterValues>[] = [];
    const screen = await render({ onChange: patch => patches.push(patch) });
    await interact(() => byText(screen.container, 'Auto').dispatchEvent(new Event('click', { bubbles: true })));
    expect(patches).toEqual([{ mode: 'auto' }]);
    await screen.unmount();
  });

  test('“/” from anywhere focuses the box, but never while typing elsewhere', async () => {
    const screen = await render();
    const input = searchOf(screen.container);
    const elsewhere = document.createElement('textarea');
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    await interact(() => pressKey(elsewhere, '/'));
    expect(document.activeElement).toBe(elsewhere);

    await interact(() => pressKey(document.body, '/'));
    expect(document.activeElement).toBe(input);

    elsewhere.remove();
    await screen.unmount();
  });

  test('leaves a modified “/” to the browser', async () => {
    const screen = await render();
    await interact(() => pressKey(document.body, '/', { metaKey: true }));
    expect(document.activeElement).not.toBe(searchOf(screen.container));
    await screen.unmount();
  });

  test('focuses the box on mount only when the host asked for it', async () => {
    const quiet = await render();
    expect(document.activeElement).not.toBe(searchOf(quiet.container));
    await quiet.unmount();

    const eager = await render({ autoFocusSearch: true });
    expect(document.activeElement).toBe(searchOf(eager.container));
    await eager.unmount();
  });
});
