/**
 * The one doctor line for a host that cannot hold every folder `imports` reads by descriptor: said at boot, once, naming
 * what the host lacks and the consequence; silent on a host that reaches everything and on a disk that does not say.
 */
import { describe, expect, test } from 'bun:test';
import type { HostFs } from '../../../host/adapters/node-fs.ts';
import { descriptorReachNote } from '../../../host/descriptor-reach.ts';

const fsReaching = (reach: { path: boolean; calls: boolean; bracket: boolean } | 'fails' | undefined): HostFs =>
  ({
    descriptorReach:
      reach === undefined
        ? undefined
        : async () => {
            if (reach === 'fails') throw new Error('the probe failed');
            return reach;
          },
  }) as unknown as HostFs;

describe('R-0198 the descriptor reach of the host is said once at boot', () => {
  test('R-0198 a host with a descriptor path says nothing', async () => {
    expect(await descriptorReachNote(fsReaching({ path: true, calls: false, bracket: false }))).toBeUndefined();
  });

  test('R-0198 a disk that does not say, and a probe that fails, say nothing', async () => {
    expect(await descriptorReachNote(fsReaching(undefined))).toBeUndefined();
    expect(await descriptorReachNote(fsReaching('fails'))).toBeUndefined();
  });

  test('R-0198 a host with neither the path nor the C calls warns, naming the consequence and no path', async () => {
    const note = await descriptorReachNote(fsReaching({ path: false, calls: false, bracket: false }));
    expect(note).toMatchObject({ plugin: 'kernel', state: 'warn' });
    expect(note?.detail).toContain('read by path after the link check');
    expect(note?.detail).toContain('one bounded read');
    expect(note?.detail).not.toContain('/home');
  });

  test('R-0198 a host with the C calls but not the bracket warns that listings go by path', async () => {
    const note = await descriptorReachNote(fsReaching({ path: false, calls: true, bracket: false }));
    expect(note).toMatchObject({ plugin: 'kernel', state: 'warn' });
    expect(note?.detail).toContain('listed by path');
  });

  test('R-0198 a host with the C calls and the bracket says nothing', async () => {
    expect(await descriptorReachNote(fsReaching({ path: false, calls: true, bracket: true }))).toBeUndefined();
  });
});
