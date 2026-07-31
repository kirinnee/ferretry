import { describe, it } from 'bun:test';
import should from 'should';
import { DaemonSecretsLoader } from '../../../src/adapters/runtime/daemon-secrets.ts';

describe('DaemonSecretsLoader', () => {
  it('should keep missing and failed secret sources silent while preserving the target environment', async () => {
    // Arrange
    const target: Record<string, string> = {};
    const missing = new DaemonSecretsLoader(
      { source: async () => undefined },
      { set: (key, value) => (target[key] = value) },
    );
    const failing = new DaemonSecretsLoader(
      {
        source: async () => {
          throw new Error('private detail');
        },
      },
      { set: (key, value) => (target[key] = value) },
    );

    // Act + Assert
    should(await missing.load('/private/secrets')).equal('missing');
    should(await failing.load('/private/secrets')).equal('failed');
    should(target).deepEqual({});
  });
});
