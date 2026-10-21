import { describe, expect, it } from 'bun:test';
import { BROWSER_LOGIN_PATH } from '../../src/lib/browser-login.ts';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { createAppStore } from '../../src/lib/store.tsx';
import { AutoCarrierPreferences, autoDial, dialByHost, keyedDaemon, relayCrypto } from '../support/relay.ts';

class MemoryRepository implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();

  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const CLOSED = { state: 'closed', profilePrimed: false } as const;

/**
 * The composed browser-login port, proved through the store that builds it.
 *
 * The login window is DAEMON-GLOBAL and its status is a credential, so the one
 * thing composition has to get right is which daemon answered: a port built
 * against the wrong client would show one machine's VNC password to a reader
 * looking at another. `act` is the call that exercises both halves — it POSTs
 * the human's intent and then takes an authoritative read — so one journey
 * covers the whole seam the shell hands to the banner.
 */
describe('the app store’s browser-login port', () => {
  it('reaches the named daemon’s own client for both the action and the read', async () => {
    const { identity, daemon, deviceKeys } = await keyedDaemon('https://alpha.example.test', [
      { kind: 'direct', daemonUrl: 'https://alpha.example.test' },
    ]);
    const scripted = autoDial(identity, {
      respond: request =>
        request.path === '/v1/carriers'
          ? { body: { carriers: [{ kind: 'direct', url: daemon.baseUrl }] } }
          : { body: CLOSED },
    });
    // A second paired machine that must hear nothing of this journey.
    const other = await keyedDaemon('https://beta.example.test');
    const otherScripted = autoDial(other.identity);
    const store = await createAppStore({
      repository: new MemoryRepository(),
      carrierPreferences: new AutoCarrierPreferences(undefined),
      deviceKeys,
      relayCrypto,
      relayDial: dialByHost({ 'alpha.example.test': scripted.dial, 'beta.example.test': otherScripted.dial }).dial,
    });
    store.connections.add(daemon);
    store.connections.add(other.daemon);

    const snapshot = await store.browserLogin.act(daemon, { action: 'confirm' });

    expect(snapshot.state).toBe('closed');
    const asked = scripted.requests as { method: string; path: string }[];
    expect(asked.filter(request => request.path === BROWSER_LOGIN_PATH).map(request => request.method)).toEqual([
      'POST',
      'GET',
    ]);
    expect(otherScripted.requests).toEqual([]);
  });
});
