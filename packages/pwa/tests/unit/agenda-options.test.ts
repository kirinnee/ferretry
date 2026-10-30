import { describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import {
  itemOptions,
  letterOf,
  letteredOptions,
  needsOptionsSection,
  optionLetter,
  rowLettered,
  shortLabel,
} from '../../src/lib/agenda-options.ts';
import { agendaItem, choices } from '../support/agenda-inbox.tsx';

const options = [{ label: 'Keep both', description: 'One line.' }, { label: 'Replace the old one' }, { label: 'Skip' }];

describe('the letters of an item’s options', () => {
  test('are A, B, C… in ask order', () => {
    expect([0, 1, 2, 11].map(optionLetter)).toEqual(['A', 'B', 'C', 'L']);
    expect(letterOf(options, 'replace the old one')).toBe('B');
    expect(letterOf(options, 'Nothing')).toBeUndefined();
  });

  test('carry the item’s detail, falling back to the option’s own description, and mark the recommended one', () => {
    // Arrange
    const details = [{ label: 'skip', detail: 'Leave it **alone**.' }];
    // Act
    const lettered = letteredOptions(options, details, 'Replace the old one');
    // Assert
    expect(lettered.map(option => [option.letter, option.label, option.detail, option.recommended])).toEqual([
      ['A', 'Keep both', 'One line.', false],
      ['B', 'Replace the old one', undefined, true],
      ['C', 'Skip', 'Leave it **alone**.', false],
    ]);
    expect(letteredOptions(options, undefined, undefined).every(option => !option.recommended)).toBe(true);
  });

  test('are read from a choice ask or a lone question, and from nothing else', () => {
    expect(itemOptions(agendaItem('A1', { ask: choices('Yes', 'No') })).map(option => option.label)).toEqual([
      'Yes',
      'No',
    ]);
    const lone = agendaItem('A2', {
      ask: { kind: 'open-question' },
      questions: [{ question: 'Which?', options: [{ label: 'One' }] }],
    } as Partial<AgendaItem>);
    expect(itemOptions(lone).map(option => option.label)).toEqual(['One']);
    expect(itemOptions(agendaItem('A3', { ask: { kind: 'permission' } } as Partial<AgendaItem>))).toEqual([]);
  });
});

describe('a button’s short text', () => {
  test('is the label when it is one or two words, else the letter, else the whole label', () => {
    expect(shortLabel('Skip', 'C')).toBe('Skip');
    expect(shortLabel('Looks good', 'A')).toBe('Looks good');
    expect(shortLabel('Replace the old one', 'B')).toBe('B');
    expect(shortLabel('Replace the old one', undefined)).toBe('Replace the old one');
  });

  test('says when the Options section has to explain the letters or the details', () => {
    expect(needsOptionsSection(letteredOptions([{ label: 'Yes' }, { label: 'No' }], undefined, undefined))).toBe(false);
    expect(needsOptionsSection(letteredOptions(options, undefined, undefined))).toBe(true);
    expect(
      needsOptionsSection(letteredOptions([{ label: 'Yes' }], [{ label: 'Yes', detail: 'Why.' }], undefined)),
    ).toBe(true);
  });
});

describe('a row of quick replies', () => {
  test('reads one way: one long lettered label letters the whole row', () => {
    const row = [
      { label: 'Use SQLite', letter: 'A' },
      { label: 'Use Postgres', letter: 'B' },
      { label: 'Keep it in memory', letter: 'C' },
    ];
    expect(rowLettered(row)).toBe(true);
    expect(row.map(reply => shortLabel(reply.label, reply.letter, rowLettered(row)))).toEqual(['A', 'B', 'C']);
  });

  test('keeps short labels when every lettered one is short, and ignores replies with no letter', () => {
    expect(
      rowLettered([
        { label: 'Looks good', letter: 'A' },
        { label: 'Skip', letter: 'B' },
      ]),
    ).toBe(false);
    expect(rowLettered([{ label: 'Send more comments now', letter: undefined }])).toBe(false);
    expect(shortLabel('Looks good', 'A', false)).toBe('Looks good');
  });
});
