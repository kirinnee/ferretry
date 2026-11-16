import { describe, expect, test } from 'bun:test';
import type { RunnerHandle } from '../../../../contract/index.ts';
import { paneIdentityKey } from '../../../../daemon/lib/moves/pane-identity.ts';

const handle = '%3' as RunnerHandle;

describe('paneIdentityKey', () => {
  test('names a pane by its handle, pid and process start', () => {
    expect(paneIdentityKey({ handle, pid: 4242, processStart: '1792626406' })).toBe('%3:4242:1792626406');
  });

  test('is unknown, never a shared key, when the pid or the start is missing', () => {
    expect(paneIdentityKey({ handle })).toBeUndefined();
    expect(paneIdentityKey({ handle, pid: 4242 })).toBeUndefined();
    expect(paneIdentityKey({ handle, processStart: '1792626406' })).toBeUndefined();
  });

  test('is unknown for a pane that is gone or that the runner cannot place', () => {
    expect(paneIdentityKey('gone')).toBeUndefined();
    expect(paneIdentityKey(undefined)).toBeUndefined();
  });
});
