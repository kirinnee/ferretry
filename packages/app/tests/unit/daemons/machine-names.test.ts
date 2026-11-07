import { describe, expect, test } from 'bun:test';
import type { PairedDaemon } from '../../../src/daemons/daemon-list.ts';
import { distinctDaemonName, machineDisplayOrder, reconcileMachineOrder } from '../../../src/daemons/machine-names.ts';

const paired = (daemon: string, overrides: Partial<PairedDaemon> = {}): PairedDaemon => ({
  daemon,
  machine: 'dev-box',
  deviceId: 'dev',
  address: 'http://127.0.0.1:40245',
  carriers: [],
  pairedAt: 1,
  lastSelectedAt: 1,
  ...overrides,
});

describe('distinctDaemonName', () => {
  test('a name nobody shares is the title alone, the owner’s label first', () => {
    expect(distinctDaemonName(paired('a'), [paired('a')])).toBe('dev-box');
    expect(distinctDaemonName(paired('a', { label: 'Desk' }), [paired('a', { label: 'Desk' })])).toBe('Desk');
  });

  test('a twin at another address is followed by its address', () => {
    const one = paired('a');
    const two = paired('b', { address: 'http://10.0.0.2:40245' });
    expect(distinctDaemonName(one, [one, two])).toBe('dev-box (127.0.0.1:40245)');
    expect(distinctDaemonName(two, [one, two])).toBe('dev-box (10.0.0.2:40245)');
  });

  test('a pairing a newer one replaced is the old pairing, and the live one needs no suffix', () => {
    const old = paired('a', { pairedAt: 1 });
    const live = paired('b', { pairedAt: 2 });
    expect(distinctDaemonName(old, [old, live])).toBe('dev-box (old pairing)');
    expect(distinctDaemonName(live, [old, live])).toBe('dev-box');
  });

  test('two that still share an address are told apart by the day each was paired', () => {
    const first = paired('a', { pairedAt: Date.UTC(2026, 9, 3, 12) });
    const second = paired('b', { pairedAt: Date.UTC(2026, 9, 3, 12) });
    expect(distinctDaemonName(first, [first, second])).toBe('dev-box (paired 3 Oct)');
  });
});

describe('machineDisplayOrder', () => {
  const a = paired('a', { pairedAt: 1 });
  const b = paired('b', { pairedAt: 2 });
  const c = paired('c', { pairedAt: 3 });

  test('is the pairing order, oldest first, whichever daemon was selected last', () => {
    expect(machineDisplayOrder([c, a, b]).map(daemon => daemon.daemon)).toEqual(['a', 'b', 'c']);
  });

  test('puts the saved order first and ignores ids that are gone or repeated', () => {
    expect(machineDisplayOrder([a, b, c], ['c', 'x', 'c', 'a']).map(daemon => daemon.daemon)).toEqual(['c', 'a', 'b']);
    expect(reconcileMachineOrder(['a', 'b'], ['b', 'b', 'z'])).toEqual(['b', 'a']);
  });
});

describe('reconcileMachineOrder', () => {
  test('is the pairing order when nothing was saved', () => {
    expect(reconcileMachineOrder(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  test('follows the saved order, then appends machines it has never seen in pairing order', () => {
    expect(reconcileMachineOrder(['a', 'b', 'c', 'd'], ['c', 'a'])).toEqual(['c', 'a', 'b', 'd']);
  });

  test('drops a machine that was unpaired and a repeated id', () => {
    expect(reconcileMachineOrder(['a', 'b'], ['gone', 'b', 'b', 'a'])).toEqual(['b', 'a']);
  });
});
