import { describe, expect, test } from 'bun:test';
import { parseInventory, unreadableBecause, wholeDaemonWhy } from '../../../src/client/inventory.ts';
import { CORE, inventoryOf, surface } from './fixtures.ts';

const board = surface('board');
const compiled = [...CORE, board];
const read = (overrides: Parameters<typeof inventoryOf>[1] = {}) => parseInventory(inventoryOf(compiled, overrides));

describe('wholeDaemonWhy: the same full-screen sentence, told apart', () => {
  test('nothing is blocked, or nothing has answered: no reason', () => {
    expect(wholeDaemonWhy(undefined, compiled)).toBeUndefined();
    expect(wholeDaemonWhy(read(), compiled)).toBeUndefined();
    // A plugin that is not a core piece never makes the whole daemon blocked, so it is no reason either.
    expect(wholeDaemonWhy(read({ board: null }), compiled)).toBeUndefined();
  });

  test('a core piece with another contract, missing or off is named with how it failed', () => {
    expect(wholeDaemonWhy(read({ gate: { contract: 'another' } }), compiled)).toBe('gate has a different contract');
    expect(wholeDaemonWhy(read({ ferrets: null }), compiled)).toBe('ferrets is not in the list');
    expect(wholeDaemonWhy(read({ kernel: { on: false } }), compiled)).toBe('kernel is off');
    expect(wholeDaemonWhy(read({ asks: null, vault: { contract: 'x' } }), compiled)).toBe(
      'vault has a different contract; asks is not in the list',
    );
  });

  test('a protocol mismatch names both protocols; an unreadable answer says it was not a list', () => {
    expect(wholeDaemonWhy(parseInventory({ protocol: 2, plugins: [] }), compiled)).toBe(
      'this app speaks protocol 1, this daemon speaks protocol 2',
    );
    expect(wholeDaemonWhy(parseInventory({ nope: true }), compiled)).toBe(
      'the plugin list this daemon sent could not be read',
    );
  });

  test('a read that failed on the way names the carrier’s own sentence as the cause', () => {
    const inventory = unreadableBecause(new Error('Relay only — there is no relay for this machine right now.'));
    expect(wholeDaemonWhy(inventory, compiled)).toBe('Relay only — there is no relay for this machine right now');
  });

  test('the cause is one capped line, and an error with no words says nothing more than an unreadable answer', () => {
    const long = unreadableBecause(new Error(`a\n  b ${'x'.repeat(1000)}`));
    expect(long.kind === 'unreadable' ? long.cause?.length : 0).toBe(240);
    expect(long.kind === 'unreadable' ? long.cause?.startsWith('a b x') : false).toBe(true);
    expect(unreadableBecause(new Error('  '))).toEqual({ kind: 'unreadable' });
    expect(unreadableBecause('not an error')).toEqual({ kind: 'unreadable' });
    expect(wholeDaemonWhy(unreadableBecause(undefined), compiled)).toBe(
      'the plugin list this daemon sent could not be read',
    );
  });

  test('it names ids and reasons only: never a hash', () => {
    const why = wholeDaemonWhy(read({ gate: { contract: 'h-secret-looking-hash' } }), compiled) ?? '';
    expect(why).not.toContain('h-secret-looking-hash');
    expect(why).not.toContain('h-gate');
  });
});
