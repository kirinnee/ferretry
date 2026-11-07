import { describe, expect, test } from 'bun:test';
import type { ScreenRef } from '../../../src/layout/engine.ts';
import { daemonSettingsHref, routeTable } from '../../../src/router/routes.ts';

const card: ScreenRef = { plugin: 'board', id: 'card', path: 'board/:card', label: 'Card' };
const newCard: ScreenRef = { plugin: 'board', id: 'new-card', path: 'board/new', label: 'New card' };
const join: ScreenRef = { plugin: 'catalogs', id: 'join', path: '/join', label: 'Join' };
const shadow: ScreenRef = { plugin: 'bad', id: 'settings', path: 'settings', label: 'Settings' };
const table = routeTable([card, newCard, join, shadow]);

describe('routes', () => {
  test('the shell pages', () => {
    expect(table.parse('/')).toEqual({ kind: 'home' });
    expect(table.parse('/app/')).toEqual({ kind: 'home' });
    expect(table.parse('/settings')).toEqual({ kind: 'device-settings' });
    expect(table.parse('/d/d1')).toEqual({ kind: 'daemon-home', daemon: 'd1' });
    expect(table.parse('/d/d1/settings')).toEqual({ kind: 'daemon-settings', daemon: 'd1' });
    expect(table.parse('/d/d1/settings/board')).toEqual({ kind: 'daemon-settings', daemon: 'd1', tab: 'board' });
  });

  test('a per-daemon screen carries its daemon and decoded params', () => {
    expect(table.parse('/d/d1/board/F%2012')).toEqual({
      kind: 'screen',
      daemon: 'd1',
      screen: card,
      params: { card: 'F 12' },
    });
  });

  test('a literal segment wins over a parameter', () => {
    expect(table.parse('/d/d1/board/new')).toMatchObject({ screen: newCard });
  });

  test('an absolute screen has no daemon', () => {
    expect(table.parse('/join')).toEqual({ kind: 'screen', screen: join, params: {} });
    expect(table.parse('/d/d1/join')).toEqual({ kind: 'not-found', path: '/d/d1/join' });
  });

  test('a screen cannot shadow the shell, and nonsense is not found', () => {
    expect(table.parse('/d/d1/settings')).toEqual({ kind: 'daemon-settings', daemon: 'd1' });
    expect(table.parse('/d/%E0%A4%A')).toEqual({ kind: 'not-found', path: '/d/%E0%A4%A' });
    expect(table.parse('/nowhere')).toEqual({ kind: 'not-found', path: '/nowhere' });
  });

  test('hrefs', () => {
    expect(table.href(card, { card: 'F 12' }, 'd 1')).toBe('/d/d%201/board/F%2012');
    expect(table.href(join, {})).toBe('/join');
    expect(() => table.href(card, {}, 'd1')).toThrow('needs "card"');
    expect(daemonSettingsHref('d1', 'board')).toBe('/d/d1/settings/board');
  });
});
