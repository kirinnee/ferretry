import { describe, expect, test } from 'bun:test';
import type { CredentialProvider } from '../../../../contract/index.ts';
import { CredentialWatch } from '../../../../daemon/lib/api/credential-watch.ts';

/** A provider that holds no one; only its subscription behaviour is under test. */
const provider = (watch?: CredentialProvider['watch']): CredentialProvider => ({
  standing: () => 'unknown',
  generation: () => 0,
  ...(watch === undefined ? {} : { watch }),
});

describe('G149 following the credential providers Gate is bound to', () => {
  test('a provider that cannot be watched is still handed back, so it is asked on every call', () => {
    const told: string[] = [];
    const watch = new CredentialWatch(() => told.push('moved'));
    const broken = provider(() => {
      throw new Error('this provider cannot push notices');
    });
    expect(watch.follow('device', broken)).toBe(broken);
    expect(told).toEqual([]);
  });

  test('a provider that pushes tells Gate once per notice, and a replaced one is cancelled', () => {
    const told: string[] = [];
    const watch = new CredentialWatch(() => told.push('moved'));
    const listeners: Array<() => void> = [];
    const cancelled: number[] = [];
    const pushing = (id: number) =>
      provider(listener => {
        listeners.push(listener);
        return () => cancelled.push(id);
      });
    const first = pushing(1);
    watch.follow('device', first);
    watch.follow('device', first);
    expect(listeners).toHaveLength(1);
    listeners[0]?.();
    expect(told).toEqual(['moved']);
    watch.follow('device', pushing(2));
    expect(cancelled).toEqual([1]);
    watch.follow('device', undefined);
    expect(cancelled).toEqual([1, 2]);
  });
});
