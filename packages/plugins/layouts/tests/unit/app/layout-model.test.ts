import { describe, expect, test } from 'bun:test';
import { COMPACT_LAYOUT, DEFAULT_LAYOUT, LayoutSchema } from '../../../contract/index.ts';
import {
  changesFor,
  choiceOf,
  LAYOUT_ID,
  LAYOUT_SETTINGS,
  listOf,
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
        // A choice may be several keys (`nav.form`): every key it saves is written, as `fy layout set` would.
        for (const change of changesFor(setting.path, option.id)) {
          const keys = change.path.split('.');
          let cursor = edited;
          for (const key of keys.slice(0, -1)) {
            cursor[key] = { ...(cursor[key] as object) };
            cursor = cursor[key] as Record<string, unknown>;
          }
          cursor[keys[keys.length - 1] as string] = change.value;
        }
        expect(LayoutSchema.safeParse(edited).success).toBe(true);
        expect(choiceOf(edited as typeof DEFAULT_LAYOUT, setting.path), 'the choice reads back as the word saved').toBe(
          option.id,
        );
      }
      expect(setting.options.map(option => option.id)).toContain(choiceOf(DEFAULT_LAYOUT, setting.path));
    }
  });

  test('only what the shell draws is offered: one navigation choice of four forms, and a phone switch for the bottom bar', () => {
    const offered = (path: string): string[] =>
      LAYOUT_SETTINGS.flatMap(setting =>
        setting.kind === 'choice' && setting.path === path ? setting.options.map(o => o.id) : [],
      );
    expect(offered('nav.form')).toEqual(['dock-icons', 'dock-words', 'list', 'bottom']);
    expect(offered('phone.nav.side')).toEqual(['left', 'bottom']);
    expect(offered('nav.side')).toEqual([]); // the side and the style are keys of nav.form, not rows of their own
    expect(offered('nav.style')).toEqual([]);
  });

  test('nav.form is saved to the keys its word means', () => {
    expect(changesFor('nav.form', 'dock-icons')).toEqual([
      { path: 'nav.side', value: 'left' },
      { path: 'nav.style', value: 'dock' },
      { path: 'nav.labels', value: 'icons' },
    ]);
    expect(changesFor('nav.form', 'dock-words').at(-1)).toEqual({ path: 'nav.labels', value: 'words' });
    expect(changesFor('nav.form', 'list')).toEqual([
      { path: 'nav.side', value: 'left' },
      { path: 'nav.style', value: 'list' },
    ]);
    expect(changesFor('nav.form', 'bottom')).toEqual([{ path: 'nav.side', value: 'bottom' }]);
    expect(changesFor('density', 'compact')).toEqual([{ path: 'density', value: 'compact' }]);
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

  test('every phone key has a row, named `phone.*` as `fy layout set` takes it', () => {
    const phone = LAYOUT_SETTINGS.filter(setting => setting.path.startsWith('phone.')).map(setting => setting.path);
    expect(phone).toEqual(['phone.nav.side', 'phone.side.show', 'phone.density', 'phone.nav.items', 'phone.top']);
  });

  test('a phone key is what the layout sets for a phone, else what the wide layout holds', () => {
    expect(choiceOf(DEFAULT_LAYOUT, 'phone.nav.side')).toBe('left'); // a phone follows the wide layout: places in the menu, no bottom bar
    expect(listOf(DEFAULT_LAYOUT, 'phone.nav.items')).toEqual([
      'ferrets',
      'agenda',
      'board',
      'projects',
      'insights',
      'settings',
    ]);
    const bare = LayoutSchema.parse({ id: 'bare', nav: { side: 'left', items: ['agenda'] } });
    expect(choiceOf(bare, 'phone.nav.side')).toBe('left');
    expect(choiceOf(bare, 'phone.side.show')).toBe('never');
    expect(choiceOf(bare, 'phone.density')).toBe('comfortable');
    expect(listOf(bare, 'phone.nav.items')).toEqual(['agenda']);
    expect(listOf(bare, 'phone.top')).toEqual(['daemon-picker', 'search']);
    const phone = LayoutSchema.parse({
      id: 'p',
      nav: { side: 'left', items: [] },
      phone: { nav: { side: 'bottom', style: 'list' }, side: { show: 'always' }, density: 'compact', top: ['search'] },
    });
    expect(choiceOf(phone, 'phone.nav.side')).toBe('bottom');
    expect(choiceOf(phone, 'phone.side.show')).toBe('always');
    expect(choiceOf(phone, 'phone.density')).toBe('compact');
    expect(listOf(phone, 'phone.top')).toEqual(['search']);
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
