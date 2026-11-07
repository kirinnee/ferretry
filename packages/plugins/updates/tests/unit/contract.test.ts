import { describe, expect, test } from 'bun:test';
import { fakeUpdates, updatesConformance } from '../../contract/testing/index.ts';
import {
  DAEMON_RELEASE_KEYS,
  DAEMON_RELEASE_SIGNATURE_CONTEXT,
  DaemonUpdateStartRequestSchema,
  UpdatesConfigSchema,
  updatesLoosens,
} from '../../contract/index.ts';

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

describe('release signing and the first release', () => {
  test('the signing context is the line the signer reads, and the trusted keys are base64url SPKI only', () => {
    expect(DAEMON_RELEASE_SIGNATURE_CONTEXT).toBe('ferretry-daemon-release-v1\n');
    for (const key of DAEMON_RELEASE_KEYS) expect(key).toMatch(/^[A-Za-z0-9_-]+$/u);
  });
  test('5.0.0 ships with automatic installs off', () => {
    expect(UpdatesConfigSchema.parse({}).autoInstall).toBe(false);
  });
});
