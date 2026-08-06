import { describe, expect, it } from 'bun:test';
import { BROWSER_LOGIN_PATH } from '../../src/lib/browser-login.ts';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { createAppStore } from '../../src/lib/store.tsx';

class MemoryRepository implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();

  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const alpha = daemonConnection({
  daemonId: `fy_daemon_${'a'.repeat(43)}`,
  baseUrl: 'https://alpha.example.test',
  deviceToken: `fy_device_${'t'.repeat(43)}`,
  carriers: [{ kind: 'direct', daemonUrl: 'https://alpha.example.test' }],
});

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
    const requests: Array<{ readonly url: string; readonly method: string }> = [];
    const store = await createAppStore({
      repository: new MemoryRepository(),
      fetcher: async (input, init) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? 'GET' });
        return url.endsWith('/v1/carriers')
          ? Response.json({ carriers: [{ kind: 'direct', url: alpha.baseUrl }] })
          : Response.json(CLOSED);
      },
    });
    store.connections.add(alpha);

    const snapshot = await store.browserLogin.act(alpha, { action: 'confirm' });

    expect(snapshot.state).toBe('closed');
    expect(requests.filter(request => request.url.endsWith(BROWSER_LOGIN_PATH))).toEqual([
      { url: `${alpha.baseUrl}${BROWSER_LOGIN_PATH}`, method: 'POST' },
      { url: `${alpha.baseUrl}${BROWSER_LOGIN_PATH}`, method: 'GET' },
    ]);
  });
});
