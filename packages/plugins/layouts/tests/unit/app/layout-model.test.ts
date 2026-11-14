import { describe, expect, test } from 'bun:test';
import { COMPACT_LAYOUT, DEFAULT_LAYOUT, LayoutSchema } from '../../../contract/index.ts';
import {
  choiceOf,
  LAYOUT_ID,
  LAYOUT_SETTINGS,
  listOf,
  listText,
  parseListText,
  refusalSentence,
} from '../../../app/lib/layout-model.ts';
import { DaemonCallError } from '@ferretry/app';

describe('the layout settings', () => {
  test('every row names a key `fy layout set` takes, and every choice is a word the layout schema takes', () => {
    for (const setting of LAYOUT_SETTINGS) {
      if (setting.kind === 'list') {
        expect(listOf(DEFAULT_LAYOUT, setting.path).length).toBeGreaterThan(0);
        continue;
      }
      for (const option of setting.options) {
        const edited = structuredClone(DEFAULT_LAYOUT) as Record<string, unknown>;
        const [head, tail] = setting.path.split('.') as [string, string | undefined];
        if (tail === undefined) edited[head] = option.id;
        else edited[head] = { ...(edited[head] as object), [tail]: option.id };
        expect(LayoutSchema.safeParse(edited).success).toBe(true);
      }
      expect(setting.options.map(option => option.id)).toContain(choiceOf(DEFAULT_LAYOUT, setting.path));
    }
  });

  test('a choice and a list are read from the layout they are asked of', () => {
    expect(choiceOf(DEFAULT_LAYOUT, 'density')).toBe('comfortable');
    expect(choiceOf(COMPACT_LAYOUT, 'density')).toBe('compact');
    expect(choiceOf(COMPACT_LAYOUT, 'side.show')).toBe('never');
    expect(listOf(DEFAULT_LAYOUT, 'nav.items')).toEqual([
      'ferrets',
      'agenda',
      'board',
      'projects',
      'insights',
      'settings',
    ]);
    expect(listOf(COMPACT_LAYOUT, 'panels.ferret.side')).toEqual(['queue']);
    expect(listOf(LayoutSchema.parse({ id: 'bare', nav: { side: 'left', items: [] } }), 'panels.ferret.side')).toEqual(
      [],
    );
  });

  test('a list is shown with commas and typed back the way the daemon splits it', () => {
    expect(listText(['agenda', 'board'])).toBe('agenda, board');
    expect(parseListText(' agenda ,, board ,')).toEqual(['agenda', 'board']);
    expect(parseListText('')).toEqual([]);
  });

  test('a saved layout id is lowercase words joined by dashes', () => {
    expect(LAYOUT_ID.test('mine-2')).toBe(true);
    for (const bad of ['', 'Mine', '2mine', 'my layout']) expect(LAYOUT_ID.test(bad)).toBe(false);
  });

  test('a refusal is the daemon’s sentence and its first reason, never a status code', () => {
    const refused = new DaemonCallError(422, 'layout_invalid', 'that layout cannot be used', {
      issues: [{ path: 'nav.items', message: '"ghost" is not an installed screen' }],
    });
    expect(refusalSentence(refused)).toBe('that layout cannot be used: "ghost" is not an installed screen');
    expect(refusalSentence(new DaemonCallError(409, 'layout_exists', 'there is already a layout called mine'))).toBe(
      'there is already a layout called mine',
    );
    expect(refusalSentence('boom')).toBe('The change did not go through.');
  });
});
