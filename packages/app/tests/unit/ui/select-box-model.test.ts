import { describe, expect, test } from 'bun:test';
import {
  filterOptions,
  firstEnabled,
  foldText,
  isSearchable,
  lastEnabled,
  type SelectOption,
  sectionOptions,
  startCursor,
  stepCursor,
  typeahead,
} from '../../../src/ui/select-box-model.ts';

const OPTIONS: readonly SelectOption[] = [
  { value: 'a', label: 'Automatic', hint: 'Ferretry picks' },
  { value: 'b', label: 'Café mode', group: 'Modes' },
  { value: 'c', label: 'Plan only', hint: 'reads, never writes', group: 'Modes', disabled: true },
  { value: 'd', label: 'Fast' },
  { value: 'e', label: 'Slow', group: 'Modes' },
];

describe('foldText', () => {
  test('drops accents and case', () => {
    expect(foldText('CAFÉ')).toBe('cafe');
    expect(foldText('Zoë')).toBe('zoe');
  });
});

describe('filterOptions', () => {
  test('leaves everything for an empty or blank query', () => {
    expect(filterOptions(OPTIONS, '')).toBe(OPTIONS);
    expect(filterOptions(OPTIONS, '   ')).toBe(OPTIONS);
  });
  test('matches the label without accents or case, and the hint, in list order', () => {
    expect(filterOptions(OPTIONS, 'CAFE').map(option => option.value)).toEqual(['b']);
    expect(filterOptions(OPTIONS, 'never writes').map(option => option.value)).toEqual(['c']);
    expect(filterOptions(OPTIONS, 'o').map(option => option.value)).toEqual(['a', 'b', 'c', 'e']);
  });
  test('needs every word, and can leave nothing', () => {
    expect(filterOptions(OPTIONS, 'plan fast')).toEqual([]);
  });
});

describe('sectionOptions', () => {
  test('cuts runs of one group in list order and keeps each option’s index', () => {
    const sections = sectionOptions(OPTIONS);
    expect(sections.map(section => [section.heading, section.items.map(item => item.index)])).toEqual([
      [undefined, [0]],
      ['Modes', [1, 2]],
      [undefined, [3]],
      ['Modes', [4]],
    ]);
  });
  test('is empty for no options', () => {
    expect(sectionOptions([])).toEqual([]);
  });
});

describe('isSearchable', () => {
  test('auto earns a search box past 7 options; always and never ignore the count', () => {
    expect(isSearchable('auto', 7)).toBe(false);
    expect(isSearchable('auto', 8)).toBe(true);
    expect(isSearchable('always', 1)).toBe(true);
    expect(isSearchable('never', 100)).toBe(false);
  });
});

describe('the cursor', () => {
  test('steps over a disabled option and stays at the end of the list', () => {
    expect(stepCursor(OPTIONS, 1, 1)).toBe(3);
    expect(stepCursor(OPTIONS, 3, -1)).toBe(1);
    expect(stepCursor(OPTIONS, 4, 1)).toBe(4);
    expect(stepCursor(OPTIONS, 0, -1)).toBe(0);
  });
  test('finds the first and last enabled option, or -1', () => {
    expect(firstEnabled(OPTIONS)).toBe(0);
    expect(lastEnabled(OPTIONS)).toBe(4);
    const none = [{ value: 'x', label: 'X', disabled: true }];
    expect(firstEnabled(none)).toBe(-1);
    expect(lastEnabled(none)).toBe(-1);
  });
  test('starts on the chosen option, else on the first enabled one', () => {
    expect(startCursor(OPTIONS, 'd')).toBe(3);
    expect(startCursor(OPTIONS, 'c')).toBe(0);
    expect(startCursor(OPTIONS, 'zzz')).toBe(0);
  });
});

describe('typeahead', () => {
  test('goes to the next enabled option that starts with the letter, wrapping, and stays when there is none', () => {
    expect(typeahead(OPTIONS, 0, 'f')).toBe(3);
    expect(typeahead(OPTIONS, 3, 'f')).toBe(3);
    expect(typeahead(OPTIONS, 1, 'a')).toBe(0);
    expect(typeahead(OPTIONS, 0, 'p')).toBe(0);
    expect(typeahead(OPTIONS, 0, 'c')).toBe(1);
    expect(typeahead(OPTIONS, 0, 'q')).toBe(0);
  });
});
