import { describe, it } from 'bun:test';
import should from 'should';
import { BunSecretShell, DaemonSecretsLoader } from '../../../src/adapters/runtime/daemon-secrets.ts';

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

describe('BunSecretShell', () => {
  it('should parse only successful string-valued environments from its injected process', async () => {
    // Arrange
    const shell = new BunSecretShell({
      source: file => {
        should(file).equal('/private/secrets');
        return { success: true, stdout: JSON.stringify({ TOKEN: 'private-value' }) };
      },
    });

    // Act + Assert
    should(await shell.source('/private/secrets')).deepEqual({ TOKEN: 'private-value' });
  });

  it('should reject malformed process output without exposing it', async () => {
    const unsuccessful = new BunSecretShell({ source: () => ({ success: false, stdout: '' }) });
    const arrayOutput = new BunSecretShell({ source: () => ({ success: true, stdout: '[]' }) });
    const nonStringValue = new BunSecretShell({
      source: () => ({ success: true, stdout: JSON.stringify({ TOKEN: 1 }) }),
    });

    should(await unsuccessful.source('/private/secrets')).equal(undefined);
    await should(arrayOutput.source('/private/secrets')).be.rejectedWith('invalid secret environment');
    await should(nonStringValue.source('/private/secrets')).be.rejectedWith('invalid secret environment');
  });
});
