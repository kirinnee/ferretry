import { describe, expect, test } from 'bun:test';
import { parseInventory, standings, wholeDaemonBlocked } from '../../../src/client/inventory.ts';
import { blockedLine, compareVersions, remedyFor, wholeDaemonSentence } from '../../../src/client/sentences.ts';
import { CORE, inventoryOf, surface } from './fixtures.ts';

const board = surface('board');
const agenda = surface('agenda', { consumes: ['board'] });
const compiled = [...CORE, board, agenda];

describe('parseInventory', () => {
  test('reads the strict inventory', () => {
    const inventory = parseInventory(inventoryOf(compiled));
    expect(inventory.kind).toBe('read');
  });

  test('a different protocol is a protocol mismatch, not damage', () => {
    expect(parseInventory({ protocol: 2, plugins: [] })).toEqual({ kind: 'protocol-mismatch', daemonProtocol: 2 });
  });

  test('an unknown field is refused (strict wire schema)', () => {
    expect(parseInventory({ protocol: 1, plugins: [], extra: true }).kind).toBe('unreadable');
    expect(parseInventory({ protocol: 1, plugins: [{ id: 'a', on: true, contract: 'x', more: 1 }] }).kind).toBe(
      'unreadable',
    );
  });

  test('a duplicate id is damage', () => {
    const body = { protocol: 1, plugins: [{ id: 'a', on: true, contract: 'x' }, { id: 'a', on: false, contract: 'x' }] };
    expect(parseInventory(body).kind).toBe('unreadable');
  });

  test('not an object is damage', () => {
    expect(parseInventory('nope').kind).toBe('unreadable');
    expect(parseInventory(null).kind).toBe('unreadable');
  });
});

describe('standings', () => {
  test('before the bootstrap read every package waits', () => {
    for (const standing of standings(undefined, compiled).values()) {
      expect(standing).toEqual({ state: 'blocked', reason: 'unread' });
    }
  });

  test('present, on and the same hash is allowed', () => {
    const result = standings(parseInventory(inventoryOf(compiled)), compiled);
    expect(result.get('board')).toEqual({ state: 'allowed' });
  });

  test('missing, off and different are blocked', () => {
    const inventory = parseInventory(
      inventoryOf(compiled, { board: null, agenda: { on: false } }),
    );
    const result = standings(inventory, compiled);
    expect(result.get('board')).toEqual({ state: 'blocked', reason: 'missing' });
    expect(result.get('agenda')).toEqual({ state: 'blocked', reason: 'off' });
    const different = standings(parseInventory(inventoryOf(compiled, { board: { contract: 'other' } })), compiled);
    expect(different.get('board')).toEqual({ state: 'blocked', reason: 'different' });
    expect(different.get('agenda')).toEqual({ state: 'allowed' });
  });

  test('a consumer whose hash also changed names the consumed package', () => {
    const inventory = parseInventory(
      inventoryOf(compiled, { board: { contract: 'b2' }, agenda: { contract: 'a2' } }),
    );
    expect(standings(inventory, compiled).get('agenda')).toEqual({ state: 'blocked', reason: 'different', via: 'board' });
  });

  test('a core hash mismatch blocks everything', () => {
    const inventory = parseInventory(inventoryOf(compiled, { gate: { contract: 'g2' } }));
    for (const standing of standings(inventory, compiled).values()) {
      expect(standing).toEqual({ state: 'blocked', reason: 'core' });
    }
    expect(wholeDaemonBlocked(inventory, compiled)).toBe(true);
  });

  test('a protocol mismatch and an unreadable answer block everything', () => {
    expect(wholeDaemonBlocked({ kind: 'protocol-mismatch', daemonProtocol: 2 }, compiled)).toBe(true);
    expect(standings({ kind: 'unreadable' }, compiled).get('board')).toEqual({ state: 'blocked', reason: 'unreadable' });
    expect(wholeDaemonBlocked(undefined, compiled)).toBe(false);
  });
});

describe('sentences', () => {
  test('versions compare by semver core', () => {
    expect(compareVersions('5.1.0', '5.0.9')).toBe(1);
    expect(compareVersions('5.0.0', '5.0.0-rc.1')).toBe(0);
    expect(compareVersions('nonsense', '0.0.1')).toBe(-1);
  });

  test('app newer: update the daemon; daemon newer or unknown: reload the app', () => {
    expect(remedyFor('5.1.0', '5.0.0')).toBe('update-daemon');
    expect(remedyFor('5.0.0', '5.1.0')).toBe('reload-app');
    expect(remedyFor('5.0.0', undefined)).toBe('reload-app');
  });

  test('the one line per blocked package', () => {
    const titleOf = (id: string) => (id === 'board' ? 'Board' : id);
    expect(blockedLine('Board', { state: 'allowed' }, 'reload-app', titleOf)).toBeUndefined();
    expect(blockedLine('Board', { state: 'blocked', reason: 'different' }, 'update-daemon', titleOf)).toBe(
      'Update this daemon to use Board: `fy daemon update`.',
    );
    expect(blockedLine('Board', { state: 'blocked', reason: 'different' }, 'reload-app', titleOf)).toBe(
      'Reload the app to use Board.',
    );
    expect(
      blockedLine('Agenda', { state: 'blocked', reason: 'different', via: 'board' }, 'update-daemon', titleOf),
    ).toBe('Agenda needs Board, which needs an update: `fy daemon update`.');
    expect(blockedLine('Board', { state: 'blocked', reason: 'core' }, 'reload-app', titleOf)).toBe(
      wholeDaemonSentence('reload-app'),
    );
  });
});
