import { describe, expect, it } from 'bun:test';
import {
  clampPickerIndex,
  filterPickerOptions,
  type PickerOption,
  type PickerSource,
  pickerIdBase,
  pickerIds,
  pickerKeyAction,
  pickerList,
  pickerListOptions,
  pickerMatchRank,
  pickerOptionEnabled,
  pickerOptionId,
  pickerStaleReason,
  pickerStatusLabel,
  stepPickerIndex,
} from '../../src/shell/picker-model.ts';

const option = (value: string, overrides: Partial<PickerOption> = {}): PickerOption => ({
  value,
  label: value,
  search: value,
  ...overrides,
});

/** Three rows where only the middle one is unavailable. */
const withDisabledMiddle: readonly PickerOption[] = [
  option('one'),
  option('two', { disabled: true, disabledReason: 'no wrapper on PATH' }),
  option('three'),
];

const ready = (options: readonly PickerOption[]): PickerSource<PickerOption> => ({ kind: 'ready', options });

describe('pickerMatchRank', () => {
  it('offers every option under an empty query, at one shared tier', () => {
    expect(pickerMatchRank(option('claude-auto'), '')).toBe(2);
    expect(pickerMatchRank(option('codex-auto'), '   ')).toBe(2);
  });

  it('puts an exactly typed value first, however long the list is', () => {
    expect(pickerMatchRank(option('claude-auto'), 'claude-auto')).toBe(0);
  });

  it('matches the value case-insensitively, because a wrapper is typed by hand', () => {
    expect(pickerMatchRank(option('Claude-Auto'), 'claude-auto')).toBe(0);
  });

  it('ranks a prefix of the explicit match text above a mere substring', () => {
    // The order inside `search` is the consumer's lever: whatever it puts first
    // is what typing forward walks toward.
    const row = option('/work/ferretry', { search: 'ferretry /work/ferretry' });

    expect(pickerMatchRank(row, 'ferretry')).toBe(1);
    expect(pickerMatchRank(row, '/work')).toBe(2);
    expect(pickerMatchRank(row, 'retry')).toBe(2);
  });

  it('matches only the explicit search text, never the rendered label', () => {
    const row = option('a1', { label: 'Production laptop', search: 'a1' });

    expect(pickerMatchRank(row, 'laptop')).toBeNull();
  });

  it('answers null when nothing matches', () => {
    expect(pickerMatchRank(option('claude-auto'), 'zzz')).toBeNull();
  });
});

describe('filterPickerOptions', () => {
  it('keeps the caller order untouched under an empty query', () => {
    const options = [option('b'), option('a')];

    expect(filterPickerOptions(options, '').map(row => row.value)).toEqual(['b', 'a']);
  });

  it('leads with the exact match, then prefixes, then substrings', () => {
    const options = [
      option('claude-auto-loge', { search: 'claude-auto-loge' }),
      option('other', { search: 'holds claude somewhere' }),
      option('claude', { search: 'claude' }),
    ];

    expect(filterPickerOptions(options, 'claude').map(row => row.value)).toEqual([
      'claude',
      'claude-auto-loge',
      'other',
    ]);
  });

  it('preserves the caller order within one tier, so a provenance ordering holds', () => {
    const options = [
      option('/registered/ferretry', { search: '/registered/ferretry' }),
      option('/seen/ferretry', { search: '/seen/ferretry' }),
    ];

    expect(filterPickerOptions(options, 'ferretry').map(row => row.value)).toEqual([
      '/registered/ferretry',
      '/seen/ferretry',
    ]);
  });

  it('drops every row the query does not answer', () => {
    expect(filterPickerOptions([option('one'), option('two')], 'two').map(row => row.value)).toEqual(['two']);
  });
});

describe('pickerList', () => {
  it('passes a read still in flight straight through', () => {
    expect(pickerList({ kind: 'loading' }, 'anything')).toEqual({ kind: 'loading' });
  });

  it('passes a failed read straight through, keeping the daemon reason', () => {
    expect(pickerList({ kind: 'failed', reason: 'HTTP 403' }, 'anything')).toEqual({
      kind: 'failed',
      reason: 'HTTP 403',
    });
  });

  it('calls a host that published nothing empty, before any query can be blamed', () => {
    expect(pickerList(ready([]), 'claude')).toEqual({ kind: 'empty' });
  });

  it('distinguishes "published nothing" from "nothing matched what you typed"', () => {
    expect(pickerList(ready([option('claude')]), '  zzz  ')).toEqual({ kind: 'no-match', query: 'zzz' });
  });

  it('answers with the filtered rows when there are any', () => {
    const list = pickerList(ready([option('one'), option('two')]), 'two');

    expect(list.kind).toBe('options');
    expect(pickerListOptions(list).map(row => row.value)).toEqual(['two']);
  });

  it('carries a stale warning onto every state a settled read can produce', () => {
    const stale = (options: readonly PickerOption[]): PickerSource<PickerOption> => ({
      kind: 'ready',
      options,
      staleReason: 'the last refresh failed',
    });

    expect(pickerStaleReason(pickerList(stale([option('one')]), ''))).toBe('the last refresh failed');
    expect(pickerStaleReason(pickerList(stale([option('one')]), 'zzz'))).toBe('the last refresh failed');
    expect(pickerStaleReason(pickerList(stale([]), ''))).toBe('the last refresh failed');
  });

  it('keeps rows usable while they are stale, rather than hiding them behind the failure', () => {
    const list = pickerList({ kind: 'ready', options: [option('one')], staleReason: 'HTTP 500' }, '');

    expect(list.kind).toBe('options');
    expect(pickerListOptions(list).map(row => row.value)).toEqual(['one']);
  });

  it('leaves a fresh read unmarked', () => {
    expect(pickerStaleReason(pickerList(ready([option('one')]), ''))).toBeUndefined();
  });
});

describe('pickerListOptions', () => {
  it('answers the rows for the one state that has any', () => {
    expect(pickerListOptions({ kind: 'options', options: [option('one')] }).map(row => row.value)).toEqual(['one']);
  });

  it('answers one shared empty identity for every other state, so nothing re-renders', () => {
    expect(pickerListOptions<PickerOption>({ kind: 'loading' })).toBe(
      pickerListOptions<PickerOption>({ kind: 'empty' }),
    );
  });
});

describe('pickerOptionEnabled', () => {
  it('treats an absent flag as pickable', () => {
    expect(pickerOptionEnabled(option('one'))).toBe(true);
    expect(pickerOptionEnabled(option('one', { disabled: false }))).toBe(true);
  });

  it('treats a declared unavailable row as unpickable', () => {
    expect(pickerOptionEnabled(option('one', { disabled: true }))).toBe(false);
  });
});

describe('stepPickerIndex', () => {
  it('answers null for an empty list rather than index zero', () => {
    expect(stepPickerIndex([], -1, 1)).toBeNull();
  });

  it('starts at the first row when walked forward from before the list', () => {
    expect(stepPickerIndex(withDisabledMiddle, -1, 1)).toBe(0);
  });

  it('starts at the last row when walked backward from past the list', () => {
    expect(stepPickerIndex(withDisabledMiddle, withDisabledMiddle.length, -1)).toBe(2);
  });

  it('steps over an unavailable row rather than landing on it', () => {
    expect(stepPickerIndex(withDisabledMiddle, 0, 1)).toBe(2);
    expect(stepPickerIndex(withDisabledMiddle, 2, -1)).toBe(0);
  });

  it('wraps in both directions, so a short list returns to the other end', () => {
    expect(stepPickerIndex(withDisabledMiddle, 2, 1)).toBe(0);
    expect(stepPickerIndex(withDisabledMiddle, 0, -1)).toBe(2);
  });

  it('answers null when every row is unavailable', () => {
    const allDisabled = [option('one', { disabled: true }), option('two', { disabled: true })];

    expect(stepPickerIndex(allDisabled, -1, 1)).toBeNull();
  });
});

describe('clampPickerIndex', () => {
  it('keeps a cursor that is still on a pickable row', () => {
    expect(clampPickerIndex(withDisabledMiddle, 2)).toBe(2);
  });

  it('recovers to the first pickable row when the cursor fell off the end', () => {
    expect(clampPickerIndex(withDisabledMiddle, 9)).toBe(0);
  });

  it('recovers when a re-filter left the cursor on a row that became unavailable', () => {
    expect(clampPickerIndex(withDisabledMiddle, 1)).toBe(0);
  });

  it('recovers from a negative cursor', () => {
    expect(clampPickerIndex(withDisabledMiddle, -1)).toBe(0);
  });

  it('answers -1 when there is nothing to point at', () => {
    expect(clampPickerIndex([], 0)).toBe(-1);
    expect(clampPickerIndex([option('one', { disabled: true })], 0)).toBe(-1);
  });
});

describe('pickerKeyAction', () => {
  const state = (overrides: Partial<Parameters<typeof pickerKeyAction>[1]> = {}) => ({
    open: true,
    options: withDisabledMiddle,
    activeIndex: 0,
    composing: false,
    ...overrides,
  });

  it('leaves every key alone while an IME candidate window is up', () => {
    expect(pickerKeyAction('ArrowDown', state({ composing: true }))).toEqual({ kind: 'ignore' });
    expect(pickerKeyAction('Enter', state({ composing: true }))).toEqual({ kind: 'ignore' });
  });

  it('closes an open list on Escape and ignores it otherwise', () => {
    expect(pickerKeyAction('Escape', state())).toEqual({ kind: 'close' });
    expect(pickerKeyAction('Escape', state({ open: false }))).toEqual({ kind: 'ignore' });
  });

  it('commits the active row on Enter', () => {
    expect(pickerKeyAction('Enter', state({ activeIndex: 2 }))).toEqual({ kind: 'accept', index: 2 });
  });

  it('leaves Enter to the surrounding form when the list is not showing', () => {
    expect(pickerKeyAction('Enter', state({ open: false }))).toEqual({ kind: 'ignore' });
  });

  it('refuses Enter on an unavailable row, so nothing is substituted for what was typed', () => {
    expect(pickerKeyAction('Enter', state({ activeIndex: 1 }))).toEqual({ kind: 'ignore' });
  });

  it('refuses Enter when there is no row under the cursor at all', () => {
    expect(pickerKeyAction('Enter', state({ activeIndex: -1 }))).toEqual({ kind: 'ignore' });
    expect(pickerKeyAction('Enter', state({ options: [], activeIndex: 0 }))).toEqual({ kind: 'ignore' });
  });

  it('reveals a closed list at its first row on ArrowDown', () => {
    expect(pickerKeyAction('ArrowDown', state({ open: false }))).toEqual({ kind: 'open', index: 0 });
  });

  it('reveals a closed list at its last row on ArrowUp', () => {
    expect(pickerKeyAction('ArrowUp', state({ open: false }))).toEqual({ kind: 'open', index: 2 });
  });

  it('moves within an open list, skipping unavailable rows and wrapping', () => {
    expect(pickerKeyAction('ArrowDown', state({ activeIndex: 0 }))).toEqual({ kind: 'move', index: 2 });
    expect(pickerKeyAction('ArrowDown', state({ activeIndex: 2 }))).toEqual({ kind: 'move', index: 0 });
    expect(pickerKeyAction('ArrowUp', state({ activeIndex: 0 }))).toEqual({ kind: 'move', index: 2 });
  });

  it('sends Home and End to the absolute ends, whether or not the list was showing', () => {
    expect(pickerKeyAction('Home', state({ activeIndex: 2 }))).toEqual({ kind: 'move', index: 0 });
    expect(pickerKeyAction('End', state({ activeIndex: 0 }))).toEqual({ kind: 'move', index: 2 });
    expect(pickerKeyAction('Home', state({ open: false }))).toEqual({ kind: 'open', index: 0 });
    expect(pickerKeyAction('End', state({ open: false }))).toEqual({ kind: 'open', index: 2 });
  });

  it('ignores a key this control does not answer to', () => {
    expect(pickerKeyAction('a', state())).toEqual({ kind: 'ignore' });
    expect(pickerKeyAction('Tab', state())).toEqual({ kind: 'ignore' });
  });

  it('ignores navigation when every row is unavailable', () => {
    const allDisabled = [option('one', { disabled: true })];

    expect(pickerKeyAction('ArrowDown', state({ options: allDisabled }))).toEqual({ kind: 'ignore' });
    expect(pickerKeyAction('End', state({ options: allDisabled }))).toEqual({ kind: 'ignore' });
  });
});

describe('pickerStatusLabel', () => {
  it('says a read is still running', () => {
    expect(pickerStatusLabel<PickerOption>({ kind: 'loading' })).toBe('Reading the available choices…');
  });

  it('names typing as the way out of a failed read', () => {
    expect(pickerStatusLabel<PickerOption>({ kind: 'failed', reason: 'HTTP 403' })).toBe(
      'The available choices could not be read. Type a value instead.',
    );
  });

  it('names typing as the way out of an empty catalogue', () => {
    expect(pickerStatusLabel<PickerOption>({ kind: 'empty' })).toBe(
      'Nothing is published to choose from. Type a value instead.',
    );
  });

  it('repeats the query back when nothing matched it', () => {
    expect(pickerStatusLabel<PickerOption>({ kind: 'no-match', query: 'zzz' })).toBe(
      'Nothing matches zzz. Type a value instead.',
    );
  });

  it('counts the offered rows, in the singular when there is one', () => {
    expect(pickerStatusLabel({ kind: 'options', options: [option('one')] })).toBe('1 choice available.');
    expect(pickerStatusLabel({ kind: 'options', options: [option('one'), option('two')] })).toBe(
      '2 choices available.',
    );
  });

  it('speaks staleness as well as showing it, on every state that displays rows', () => {
    const stale = ' These choices may be out of date.';

    expect(pickerStatusLabel({ kind: 'options', options: [option('one')], staleReason: 'refresh failed' })).toBe(
      `1 choice available.${stale}`,
    );
    expect(pickerStatusLabel<PickerOption>({ kind: 'no-match', query: 'zzz', staleReason: 'refresh failed' })).toBe(
      `Nothing matches zzz. Type a value instead.${stale}`,
    );
    expect(pickerStatusLabel<PickerOption>({ kind: 'empty', staleReason: 'refresh failed' })).toBe(
      `Nothing is published to choose from. Type a value instead.${stale}`,
    );
  });
});

describe('pickerStaleReason', () => {
  it('reports the one reason from whichever displaying state carries it', () => {
    expect(pickerStaleReason({ kind: 'options', options: [option('one')], staleReason: 'HTTP 500' })).toBe('HTTP 500');
    expect(pickerStaleReason<PickerOption>({ kind: 'no-match', query: 'z', staleReason: 'HTTP 500' })).toBe('HTTP 500');
    expect(pickerStaleReason<PickerOption>({ kind: 'empty', staleReason: 'HTTP 500' })).toBe('HTTP 500');
  });

  it('answers undefined for fresh rows and for the two states showing none', () => {
    expect(pickerStaleReason({ kind: 'options', options: [option('one')] })).toBeUndefined();
    expect(pickerStaleReason<PickerOption>({ kind: 'loading' })).toBeUndefined();
    // A read that never succeeded has no stale rows to warn about.
    expect(pickerStaleReason<PickerOption>({ kind: 'failed', reason: 'HTTP 403' })).toBeUndefined();
  });
});

describe('picker element ids', () => {
  it('strips the colons useId answers with, so a selector cannot throw on one', () => {
    expect(pickerIdBase(':r3:')).toBe('fy-picker-r3');
  });

  it('gives two instances on one page distinct bases', () => {
    expect(pickerIdBase(':r3:')).not.toBe(pickerIdBase(':r4:'));
  });

  it('derives every reference from the one base', () => {
    expect(pickerIds('fy-picker-r3')).toEqual({
      input: 'fy-picker-r3',
      listbox: 'fy-picker-r3-listbox',
      status: 'fy-picker-r3-status',
    });
  });

  it('names a row by position, which cannot collide however odd the value is', () => {
    expect(pickerOptionId('fy-picker-r3', 0)).toBe('fy-picker-r3-option-0');
    expect(pickerOptionId('fy-picker-r3', 11)).toBe('fy-picker-r3-option-11');
  });
});
