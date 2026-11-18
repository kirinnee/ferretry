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
  test('a name nobody shares is the title alone', () => {
    expect(distinctDaemonName(paired('a'), [paired('a')])).toBe('dev-box');
  });

  test('a twin at another address is followed by its address', () => {
    const one = paired('a', { address: 'http://10.0.0.1:40245' });
    const two = paired('b', { address: 'http://10.0.0.2:40245' });
    expect(distinctDaemonName(one, [one, two])).toBe('dev-box (10.0.0.1:40245)');
    expect(distinctDaemonName(two, [one, two])).toBe('dev-box (10.0.0.2:40245)');
  });

  test('loopback twins are told apart without the address, by the day each was paired', () => {
    const one = paired('a', { address: 'http://127.0.0.1:7617', pairedAt: Date.UTC(2026, 9, 3, 12) });
    const two = paired('b', { address: 'http://127.0.0.1:7618', pairedAt: Date.UTC(2026, 9, 4, 12) });
    expect(distinctDaemonName(one, [one, two])).toBe('dev-box (paired 3 Oct)');
    expect(distinctDaemonName(two, [one, two])).toBe('dev-box (paired 4 Oct)');
  });

  test('loopback twins paired on one day are told apart by their number in pairing order', () => {
    const one = paired('a', { address: 'http://127.0.0.1:7617', pairedAt: Date.UTC(2026, 9, 3, 10) });
    const two = paired('b', { address: 'http://localhost:7618', pairedAt: Date.UTC(2026, 9, 3, 11) });
    expect(distinctDaemonName(one, [two, one])).toBe('dev-box (1)');
    expect(distinctDaemonName(two, [two, one])).toBe('dev-box (2)');
    for (const name of [distinctDaemonName(one, [one, two]), distinctDaemonName(two, [one, two])]) {
      expect(name).not.toContain('127.0.0.1');
      expect(name).not.toContain('7618');
    }
  });

  test('a loopback twin beside an off-host twin: only the off-host one keeps its address', () => {
    const local = paired('a', { address: 'http://127.0.0.1:7617', pairedAt: Date.UTC(2026, 9, 3, 12) });
    const remote = paired('b', { address: 'http://10.0.0.2:7617', pairedAt: Date.UTC(2026, 9, 4, 12) });
    expect(distinctDaemonName(local, [local, remote])).toBe('dev-box (paired 3 Oct)');
    expect(distinctDaemonName(remote, [local, remote])).toBe('dev-box (10.0.0.2:7617)');
  });

  test('a pairing a newer one replaced is the old pairing, and the live one needs no suffix', () => {
    const old = paired('a', { pairedAt: 1 });
    const live = paired('b', { pairedAt: 2 });
    expect(distinctDaemonName(old, [old, live])).toBe('dev-box (old pairing)');
    expect(distinctDaemonName(live, [old, live])).toBe('dev-box');
  });

  test('two that still share an address are told apart by the day each was paired', () => {
    const first = paired('a', { address: 'http://10.0.0.2:40245', pairedAt: Date.UTC(2026, 9, 3, 12) });
    const second = paired('b', { address: 'http://10.0.0.2:40245', pairedAt: Date.UTC(2026, 9, 3, 12) });
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
