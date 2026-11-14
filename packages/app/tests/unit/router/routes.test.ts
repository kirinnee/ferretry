import { describe, expect, test } from 'bun:test';
import type { ScreenRef } from '../../../src/layout/engine.ts';
import { addressPlace, daemonSettingsHref, routeTable } from '../../../src/router/routes.ts';

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

  test('a settings tab is addressed by its plugin and its own id', () => {
    expect(table.parse('/d/d1/settings/runtimes/model-sets')).toEqual({
      kind: 'daemon-settings',
      daemon: 'd1',
      tab: 'runtimes',
      tabId: 'model-sets',
    });
    expect(table.parse('/d/d1/settings/runtimes/model%20sets')).toMatchObject({ tabId: 'model sets' });
    expect(table.parse('/d/d1/settings/runtimes/a/b')).toEqual({
      kind: 'not-found',
      path: '/d/d1/settings/runtimes/a/b',
    });
    expect(table.parse('/d/d1/settings/%E0%A4%A/x')).toEqual({
      kind: 'not-found',
      path: '/d/d1/settings/%E0%A4%A/x',
    });
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

  test('board-app: a trailing optional param (`board/:project?`) matches with and without its segment', () => {
    const board: ScreenRef = { plugin: 'board', id: 'board', path: 'board/:project?', label: 'Board' };
    const optional = routeTable([board]);
    expect(optional.parse('/d/d1/board')).toEqual({ kind: 'screen', daemon: 'd1', screen: board, params: {} });
    expect(optional.parse('/d/d1/board/')).toEqual({ kind: 'screen', daemon: 'd1', screen: board, params: {} });
    // The card id a v4 deep link carries (`/d/<id>/board/<card>`) is the param, named without its `?`.
    expect(optional.parse('/d/d1/board/I1')).toEqual({
      kind: 'screen',
      daemon: 'd1',
      screen: board,
      params: { project: 'I1' },
    });
    expect(optional.parse('/d/d1/board/I1/extra')).toEqual({ kind: 'not-found', path: '/d/d1/board/I1/extra' });
    expect(optional.href(board, {}, 'd1')).toBe('/d/d1/board');
    expect(optional.href(board, { project: 'I 1' }, 'd1')).toBe('/d/d1/board/I%201');
  });

  test('board-app: an exact route wins over an optional one at the same address', () => {
    const board: ScreenRef = { plugin: 'board', id: 'board', path: 'board/:project?', label: 'Board' };
    expect(routeTable([board, newCard]).parse('/d/d1/board/new')).toMatchObject({ screen: newCard });
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
    expect(daemonSettingsHref('d1', 'runtimes', 'model-sets')).toBe('/d/d1/settings/runtimes/model-sets');
    expect(daemonSettingsHref('d 1')).toBe('/d/d%201/settings');
  });
});

describe('R4-S1 where an address stands to a daemon-less screen, by the router’s own parse', () => {
  const drawsJoin = (pathname: string): boolean => {
    const drawn = table.parse(pathname);
    return drawn.kind === 'screen' && drawn.screen === join;
  };

  test('R4-S1 every spelling the router draws the join screen at is "at" it', () => {
    for (const pathname of ['/join', '/join/', '/app/join', '/app/join/', '/j%6Fin', '//join//', '/app/j%6fin/']) {
      expect(drawsJoin(pathname)).toBe(true);
      expect(addressPlace(join, pathname)).toBe('at');
    }
  });

  test('R4-S1 an address beneath the join screen is "beneath" it, and the router does not draw the screen there', () => {
    for (const pathname of ['/join/x', '/join/x/y', '/app/join/x', '/j%6Fin/x/']) {
      expect(drawsJoin(pathname)).toBe(false);
      expect(addressPlace(join, pathname)).toBe('beneath');
    }
  });

  test('R4-S1 every other address is "elsewhere", the same as the router says', () => {
    for (const pathname of [
      '/',
      '/app/',
      '/shared',
      '/joined',
      '/joi',
      '/x/join',
      '/app/app/join',
      '/d/d1/join',
      '/d/d1/join/x',
      '/settings',
      '/%E0%A4%A',
      '/%E0%A4%A/join',
    ]) {
      expect(drawsJoin(pathname)).toBe(false);
      expect(addressPlace(join, pathname)).toBe('elsewhere');
    }
  });

  test('a per-daemon screen, or one that would shadow the shell, is never "at" a daemon-less address', () => {
    expect(addressPlace(card, '/d/d1/board/F1')).toBe('elsewhere');
    expect(addressPlace(card, '/board/F1')).toBe('elsewhere');
    const reserved: ScreenRef = { plugin: 'bad', id: 'app', path: '/settings', label: 'Shadow' };
    expect(addressPlace(reserved, '/settings')).toBe('elsewhere');
    expect(addressPlace(reserved, '/settings/x')).toBe('elsewhere');
  });
});
