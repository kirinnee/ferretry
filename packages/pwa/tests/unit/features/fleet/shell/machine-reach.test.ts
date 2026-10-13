import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { machineReachSummary, readMachineReach } from '../../../../../src/features/fleet/shell/machine-reach.ts';
import { machineClient, machineView } from './machine-support.ts';

describe('machine reach', () => {
  it('reads the machine through the injected client, at the catalogue path', async () => {
    const paths: string[] = [];
    const reach = await readMachineReach(async () => machineClient(machineView(), paths));
    expect(reach).toEqual({ kind: 'online', machine: machineView() });
    expect(paths).toEqual(['/v1/fleet/machine']);
  });

  it('calls a refusal reachable, with a reason, and anything else offline', async () => {
    expect(await readMachineReach(async () => machineClient(new FyHttpError('not found', 404, undefined)))).toEqual({
      kind: 'unreadable',
      reason: 'This machine runs an older Ferretry that cannot show its setup here yet.',
    });
    expect(await readMachineReach(async () => machineClient(new FyHttpError('limited', 403, 'grant_denied')))).toEqual({
      kind: 'unreadable',
      reason: 'This machine answered but did not share its setup: limited',
    });
    expect(await readMachineReach(async () => machineClient(new Error('network down')))).toEqual({ kind: 'offline' });
    expect(await readMachineReach(async () => Promise.reject(new Error('no carrier')))).toEqual({ kind: 'offline' });
  });

  it('summarises each state in the words the Machines list shows', () => {
    expect(machineReachSummary({ kind: 'checking' })).toBe('Checking');
    expect(machineReachSummary({ kind: 'offline' })).toBe('Offline');
    expect(machineReachSummary({ kind: 'unreadable', reason: 'x' })).toBe('Online · Setup not shown');
    expect(machineReachSummary({ kind: 'online', machine: machineView() })).toBe('Online · 2 runtimes');
    expect(machineReachSummary({ kind: 'online', machine: machineView({ runtimeCount: 1 }) })).toBe(
      'Online · 1 runtime',
    );
    expect(machineReachSummary({ kind: 'online', machine: machineView({ setUp: false, runtimeCount: 0 }) })).toBe(
      'Online · Not set up yet',
    );
  });
});
