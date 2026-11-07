import { describe, expect, test } from 'bun:test';
import { InstantSchema } from '@ferretry/std';
import type { PackRow } from '../../../contract/index.ts';
import { helperLive, helperModel, helperName, helperState, helpersOf } from '../../../app/lib/helper-state.ts';

const row = (id: string, overrides: Partial<PackRow> = {}): PackRow => ({
  id,
  name: id,
  parent: 'lead',
  depth: 1,
  model: 'claude-opus-5-5',
  state: 'running',
  ferretState: 'working',
  ...overrides,
});

const last = (text: string): PackRow['last'] => ({
  at: InstantSchema.parse('2026-10-20T00:00:00.000Z'),
  source: 'note',
  text,
});

describe('helperState', () => {
  test('reads every row state as one of the lead reader’s words, with the reason when there is one', () => {
    const cases: Array<[PackRow, string, string | undefined]> = [
      [row('c', { ferretState: 'starting' }), 'Starting', undefined],
      [row('c'), 'Working', undefined],
      [row('c', { state: 'waiting', ferretState: 'idle' }), 'Waiting', undefined],
      [row('c', { state: 'needs-you', last: last('  Which branch?  ') }), 'Needs you', 'Which branch?'],
      [row('c', { state: 'needs-you' }), 'Needs you', undefined],
      [row('c', { state: 'ended', ferretState: 'stopped', last: last('out of quota') }), 'Ended', 'out of quota'],
      [row('c', { state: 'ended', ferretState: 'stopped' }), 'Ended', undefined],
    ];
    for (const [input, word, reason] of cases) {
      const reading = helperState(input);
      expect([reading.word, reading.reason]).toEqual([word, reason]);
    }
  });

  test('only an ended helper is not live', () => {
    expect(helperLive(helperState(row('c')))).toBe(true);
    expect(helperLive(helperState(row('c', { state: 'waiting' })))).toBe(true);
    expect(helperLive(helperState(row('c', { state: 'needs-you' })))).toBe(true);
    expect(helperLive(helperState(row('c', { state: 'ended', ferretState: 'stopped' })))).toBe(false);
  });
});

describe('a helper as its lead lists it', () => {
  test('is named and modelled as the daemon’s table says', () => {
    expect(helperName(row('c', { name: 'nadia' }))).toBe('nadia');
    expect(helperModel(row('c', { model: 'opus[1m]' }))).toBe('opus[1m]');
  });

  test('a lead’s helpers are its own children in tree order, never itself or a grandchild’s row of another lead', () => {
    const rows = [
      row('lead', { parent: undefined, depth: 1 }),
      row('b', { parent: 'lead' }),
      row('b1', { parent: 'b', depth: 2 }),
      row('a', { parent: 'lead' }),
    ];
    expect(helpersOf('lead', rows).map(each => each.id)).toEqual(['b', 'a']);
    expect(helpersOf('b', rows).map(each => each.id)).toEqual(['b1']);
  });
});
