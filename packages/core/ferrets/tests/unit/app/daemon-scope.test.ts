import { describe, it } from 'bun:test';
import should from 'should';
import { daemonConnection } from '../../../app/lib/daemon-connection.ts';
import { daemonSessionKey, daemonSessionScope } from '../../../app/lib/daemon-scope.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'http://127.0.0.1:7431', deviceId: 'token-b' });

describe('daemon session scope', () => {
  it('should distinguish identical session IDs from different daemons', () => {
    // Act
    const a = daemonSessionScope(daemonA, 'same-session');
    const b = daemonSessionScope(daemonB, 'same-session');

    // Assert
    should(daemonSessionKey(a)).not.equal(daemonSessionKey(b));
  });

  it('should reject an empty session ID', () => {
    // Act
    const actual = (): unknown => daemonSessionScope(daemonA, ' ');

    // Assert
    should(actual).throw('sessionId must not be empty');
  });
});
