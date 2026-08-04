import { describe, it } from 'bun:test';
import should from 'should';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonSessionCache, daemonSessionKey, daemonSessionScope } from '../../src/lib/daemon-scope.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'http://127.0.0.1:7431', deviceToken: 'token-b' });

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

describe('DaemonSessionCache', () => {
  it('should never serve a daemon value after switching to another daemon with the same session ID', () => {
    // Arrange
    const cache = new DaemonSessionCache<string>();
    const a = daemonSessionScope(daemonA, 'same-session');
    const b = daemonSessionScope(daemonB, 'same-session');
    cache.set(a, 'from daemon a');
    cache.set(b, 'from daemon b');

    // Act
    const actual = [cache.get(a), cache.get(b)];

    // Assert
    should(actual).deepEqual(['from daemon a', 'from daemon b']);
  });

  it('should delete one scope and clear one daemon without touching another daemon', () => {
    // Arrange
    const cache = new DaemonSessionCache<string>();
    const a = daemonSessionScope(daemonA, 'one');
    const aOther = daemonSessionScope(daemonA, 'two');
    const b = daemonSessionScope(daemonB, 'one');
    cache.set(a, 'a-one');
    cache.set(aOther, 'a-two');
    cache.set(b, 'b-one');

    // Act
    const deleted = cache.delete(a);
    cache.clearDaemon(daemonA.daemonId);

    // Assert
    should(deleted).be.true();
    should(cache.get(a)).be.undefined();
    should(cache.get(aOther)).be.undefined();
    should(cache.get(b)).equal('b-one');
  });
});
