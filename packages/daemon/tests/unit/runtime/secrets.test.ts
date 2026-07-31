import { describe, it } from 'bun:test';
import should from 'should';
import {
  loadDaemonSecrets,
  type EnvironmentWriterPort,
  type SecretShellPort,
} from '../../../src/lib/runtime/secrets.ts';

describe('daemon secret policy', () => {
  it('should import only permitted names without retaining a secret in the policy result', async () => {
    // Arrange
    const received: string[] = [];
    const shell: SecretShellPort = { source: async () => ({ API_TOKEN: 'secret', PATH: 'replace', 'bad-key': 'no' }) };
    const environment: EnvironmentWriterPort = { set: key => received.push(key) };

    // Act
    const status = await loadDaemonSecrets(shell, environment, '/private/secrets');

    // Assert
    should(status).equal('loaded');
    should(received).deepEqual(['API_TOKEN']);
  });

  it('should fail closed when the source cannot be read', async () => {
    // Act
    const status = await loadDaemonSecrets(
      { source: async () => await Promise.reject(new Error('unreadable')) },
      { set: () => undefined },
      '/private/secrets',
    );

    // Assert
    should(status).equal('failed');
  });
});
