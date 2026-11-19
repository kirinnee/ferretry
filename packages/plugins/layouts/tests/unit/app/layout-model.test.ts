import { describe, expect, test } from 'bun:test';
import { COMPACT_LAYOUT, DEFAULT_LAYOUT, LayoutSchema } from '../../../contract/index.ts';
import { choiceOf, LAYOUT_ID, LAYOUT_SETTINGS, listOf, refusalSentence } from '../../../app/lib/layout-model.ts';
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
        const keys = setting.path.split('.');
        let cursor = edited;
        for (const key of keys.slice(0, -1)) {
          cursor[key] = { ...(cursor[key] as object) };
          cursor = cursor[key] as Record<string, unknown>;
        }
        cursor[keys[keys.length - 1] as string] = option.id;
        expect(LayoutSchema.safeParse(edited).success).toBe(true);
      }
      expect(setting.options.map(option => option.id)).toContain(choiceOf(DEFAULT_LAYOUT, setting.path));
    }
  });

  test('only what the shell draws is offered: no right or top side, no bar style', () => {
    const offered = (path: string): string[] =>
      LAYOUT_SETTINGS.flatMap(setting =>
        setting.kind === 'choice' && setting.path === path ? setting.options.map(o => o.id) : [],
      );
    for (const path of ['nav.side', 'phone.nav.side']) expect(offered(path)).toEqual(['left', 'bottom']);
    expect(offered('nav.style')).toEqual(['rail', 'list']);
    expect(offered('phone.nav.style')).toEqual([]); // a phone's side bar is always the shut drawer: no style to choose
  });

  test('a saved word that is no longer offered reads as the choice the shell draws it as', () => {
    // The built-in default still says `top` and `bar`; the shell draws them as the left side bar, opened.
    expect(choiceOf(DEFAULT_LAYOUT, 'nav.side')).toBe('left');
    expect(choiceOf(DEFAULT_LAYOUT, 'nav.style')).toBe('list');
    const right = { ...DEFAULT_LAYOUT, nav: { ...DEFAULT_LAYOUT.nav, side: 'right' as const } };
    expect(choiceOf(right, 'nav.side')).toBe('left');
    expect(choiceOf({ ...right, phone: { nav: { side: 'top' } } }, 'phone.nav.side')).toBe('left');
    expect(choiceOf(COMPACT_LAYOUT, 'nav.style')).toBe('rail');
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
    expect(choiceOf(DEFAULT_LAYOUT, 'phone.nav.side')).toBe('bottom');
    expect(choiceOf(DEFAULT_LAYOUT, 'nav.side')).toBe('left');
    expect(listOf(DEFAULT_LAYOUT, 'phone.nav.items')).toEqual([
      'ferrets',
      'agenda',
      'board',
      'projects',
      'insights',
      'settings',
    ]);
    const bare = LayoutSchema.parse({ id: 'bare', nav: { side: 'right', style: 'bar', items: ['agenda'] } });
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
