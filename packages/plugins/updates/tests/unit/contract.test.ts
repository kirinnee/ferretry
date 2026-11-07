import { describe, expect, test } from 'bun:test';
import { fakeUpdates, updatesConformance } from '../../contract/testing/index.ts';
import { DaemonUpdateStartRequestSchema, updatesLoosens } from '../../contract/index.ts';

updatesConformance('fakeUpdates', () => fakeUpdates({ available: true, latest: '5.0.1' }));

describe('updates wire', () => {
  test('an update names the version the person agreed to, and nothing else', () => {
    expect(DaemonUpdateStartRequestSchema.safeParse({ target: '5.0.1', when: 'now' }).success).toBe(true);
    expect(
      DaemonUpdateStartRequestSchema.safeParse({ target: '5.0.1', when: 'now', confirmMidTurn: true }).success,
    ).toBe(false);
  });
  test('turning on automatic installs is held for the owner; turning it off is not', () => {
    expect(updatesLoosens({ autoInstall: false }, { autoInstall: true })).toHaveLength(1);
    expect(updatesLoosens({ autoInstall: true }, { autoInstall: false })).toEqual([]);
  });
});
