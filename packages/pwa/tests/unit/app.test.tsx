import { afterEach, describe, expect, it } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';

import { AppShell } from '../../src/App.tsx';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { type DaemonId, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { RouterProvider } from '../../src/lib/router.tsx';
import { createAppStore, StoreProvider } from '../../src/lib/store.tsx';
import { interact, mount } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-token',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceToken: 'beta-token',
});

class MemoryRepository implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();

  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const setPath = (path: string): void => window.history.replaceState({}, '', path);

afterEach(() => {
  setPath('/');
  localStorage.clear();
});

const appStore = async (reads: string[]) =>
  await createAppStore({
    repository: new MemoryRepository(),
    connectClient: async connection =>
      ({
        get: async (sessionId: string) => {
          reads.push(`${connection.daemonId}:${sessionId}`);
          return sessionView(sessionId, {
            config: {
              teammate: connection.daemonId === alpha.daemonId ? 'Alpha Agent' : 'Beta Agent',
              name: `${connection.daemonId} session`,
            },
          });
        },
      }) as unknown as FyApiClient,
    fetcher: async () => Response.json({}),
  });

const renderShell = async (path: string, paired: readonly DaemonId[] = []) => {
  const reads: string[] = [];
  const store = await appStore(reads);
  for (const daemon of paired) store.connections.add(daemon === alpha.daemonId ? alpha : beta);
  setPath(path);
  const view = await mount(
    <RouterProvider>
      <StoreProvider store={store}>
        <AppShell />
      </StoreProvider>
    </RouterProvider>,
  );
  return { reads, store, view };
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('AppShell', () => {
  it('renders the unpaired first run as the normal connection screen', async () => {
    const { reads, view } = await renderShell('/');

    expect(view.container.querySelector('h1')?.textContent).toBe('Connect a daemon');
    expect(view.container.textContent).toContain('No daemons are paired yet');
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(reads).toEqual([]);
    await view.unmount();
  });

  it('fails closed when a daemon-qualified route has no matching runtime pairing', async () => {
    const { reads, view } = await renderShell('/d/missing/session/shared', [alpha.daemonId, beta.daemonId]);

    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('not paired in this browser');
    expect(view.container.querySelector('h1')?.textContent).toBe('Connect a daemon');
    expect(view.container.querySelector('[data-session="shared"]')).toBeNull();
    expect(reads).toEqual([]);
    await view.unmount();
  });

  it('uses the routed daemon instead of the selected daemon', async () => {
    // Adding beta last selects it, while the route explicitly asks for alpha.
    const { reads, view } = await renderShell('/d/alpha/session/shared', [alpha.daemonId, beta.daemonId]);
    await settle();

    const session = view.container.querySelector('[data-session="shared"]');
    expect(session?.getAttribute('data-daemon')).toBe('alpha');
    expect(session?.textContent).toContain('Alpha Agent');
    expect(session?.textContent).not.toContain('Beta Agent');
    expect(reads).toEqual(['alpha:shared']);
    await view.unmount();
  });

  it('never crosses two daemons that own the same session id', async () => {
    const { reads, view } = await renderShell('/d/alpha/session/shared', [alpha.daemonId, beta.daemonId]);
    await settle();
    expect(view.container.querySelector('[data-session="shared"]')?.textContent).toContain('Alpha Agent');

    window.history.pushState({}, '', '/d/beta/session/shared');
    await interact(() => window.dispatchEvent(new PopStateEvent('popstate')));
    await settle();

    const session = view.container.querySelector('[data-session="shared"]');
    expect(session?.getAttribute('data-daemon')).toBe('beta');
    expect(session?.textContent).toContain('Beta Agent');
    expect(session?.textContent).not.toContain('Alpha Agent');
    expect(reads).toEqual(['alpha:shared', 'beta:shared']);
    await view.unmount();
  });
});
