import { describe, expect, it } from 'bun:test';
import { daemonConnection } from '../../../app/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../app/lib/daemon-scope.ts';
import { clearForegroundPinScope, getForegroundPinScope, setForegroundPinScope } from '../../../app/lib/pin-bridge.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceId: 'token-b' });
const scopeA = daemonSessionScope(daemonA, 'shared');
const scopeB = daemonSessionScope(daemonB, 'shared');

describe('foreground scope', () => {
  it('is scoped to the daemon as well as the session', () => {
    try {
      setForegroundPinScope(scopeA);
      expect(getForegroundPinScope()).toEqual(scopeA);
      clearForegroundPinScope(scopeB);
      expect(getForegroundPinScope()).toEqual(scopeA);
      clearForegroundPinScope(scopeA);
      expect(getForegroundPinScope()).toBeNull();
    } finally {
      clearForegroundPinScope(scopeA);
    }
  });
});
