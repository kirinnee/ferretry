import { describe, expect, test } from 'bun:test';
import { machineDisplayOrder } from '../../src/lib/all-machines.ts';
import { parseControlsRecord } from '../../src/lib/controls.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { moveMachine, reconcileMachineOrder, stepMachine } from '../../src/lib/machine-order.ts';

const ids = (...names: string[]) => names as DaemonId[];
const [A, B, C, D] = ids('a', 'b', 'c', 'd') as [DaemonId, DaemonId, DaemonId, DaemonId];

describe('reconcileMachineOrder', () => {
  test('is the pairing order when nothing was saved', () => {
    expect(reconcileMachineOrder([A, B, C], [])).toEqual([A, B, C]);
  });

  test('follows the saved order, then appends machines it has never seen in pairing order', () => {
    expect(reconcileMachineOrder([A, B, C, D], ['c', 'a'])).toEqual([C, A, B, D]);
  });

  test('drops a machine that was unpaired and a repeated id', () => {
    expect(reconcileMachineOrder([A, B], ['gone', 'b', 'b', 'a'])).toEqual([B, A]);
  });
});

describe('moveMachine and stepMachine', () => {
  test('drops a machine before or after another', () => {
    expect(moveMachine([A, B, C], A, C, 'after')).toEqual([B, C, A]);
    expect(moveMachine([A, B, C], C, A, 'before')).toEqual([C, A, B]);
    expect(moveMachine([A, B, C], A, C, 'before')).toEqual([B, A, C]);
  });

  test('is the same list when nothing moves, or when a machine is unknown', () => {
    const order = [A, B, C];
    expect(moveMachine(order, A, B, 'before')).toBe(order);
    expect(moveMachine(order, B, B, 'after')).toBe(order);
    expect(moveMachine(order, D, A, 'before')).toBe(order);
    expect(moveMachine(order, A, D, 'before')).toBe(order);
  });

  test('steps one place among the machines on screen, and stops at either end', () => {
    expect(stepMachine([A, B, C], [A, B, C], B, -1)).toEqual([B, A, C]);
    expect(stepMachine([A, B, C], [A, B, C], B, 1)).toEqual([A, C, B]);
    const order = [A, B, C];
    expect(stepMachine(order, [A, B, C], A, -1)).toBe(order);
    expect(stepMachine(order, [A, B, C], C, 1)).toBe(order);
    // A machine hidden by a filter is stepped over: A swaps with C, the one on screen beside it.
    expect(stepMachine([A, B, C], [A, C], A, 1)).toEqual([B, C, A]);
  });
});

describe('machineDisplayOrder with a saved order', () => {
  const list = [
    { daemonId: B, pairedAt: 20 },
    { daemonId: A, pairedAt: 10 },
    { daemonId: C, pairedAt: 30 },
  ];

  test('keeps the pairing order by default', () => {
    expect(machineDisplayOrder(list).map(entry => entry.daemonId)).toEqual([A, B, C]);
  });

  test('puts saved machines first, appends a newly paired one, and drops an unpaired one', () => {
    expect(machineDisplayOrder(list, ['c', 'gone', 'a']).map(entry => entry.daemonId)).toEqual([C, A, B]);
  });
});

describe('the saved order in the controls record', () => {
  const read = (machineOrder: unknown) => parseControlsRecord(JSON.stringify({ v: 1, device: { machineOrder } }));

  test('keeps distinct non-blank string ids and nothing else', () => {
    expect(read(['b', 'a', 'b', '', '  ', 7, null]).device.machineOrder).toEqual(['b', 'a']);
  });

  test('is empty when absent or not a list', () => {
    expect(read(undefined).device.machineOrder).toEqual([]);
    expect(read('b,a').device.machineOrder).toEqual([]);
  });
});
