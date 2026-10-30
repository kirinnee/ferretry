import '../support/dom.ts';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SessionView, WardenStatusView } from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { ComponentType } from 'react';

import { SessionsPage, type SessionsPageProps } from '../../src/components/sessions-page.tsx';
import { AgendaInboxContext } from '../../src/hooks/use-agenda-inbox.ts';
import { projectScopePath, projectScopeState, type ScopeNavigation } from '../../src/hooks/use-project-scope.ts';
import type { WardenStatusReader } from '../../src/hooks/use-warden-status.ts';
import type { AccountPickerHealthCatalog } from '../../src/lib/account-picker-catalog.ts';
import { DaemonAccountPickerStore } from '../../src/lib/account-picker-store.ts';
import type { InboxCard } from '../../src/lib/agenda-inbox.ts';
import { type ControlsStorage, DaemonControlsStore } from '../../src/lib/controls.ts';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { FleetProject } from '../../src/lib/fleet-grouping.ts';
import type { DaemonFleetPort } from '../../src/lib/fleet-store.ts';
import { DaemonFleetStore } from '../../src/lib/fleet-store.ts';
import { PageHost } from '../../src/lib/pages/page-host.tsx';
import { DaemonClientProvider } from '../../src/lib/store.tsx';
import { type DaemonProjectsPort, DaemonProjectsStore } from '../../src/lib/projects-store.ts';
import { type DaemonUsagePort, DaemonUsageStore } from '../../src/lib/usage-store.ts';
import { agendaItem, choices, type FakeInbox, fakeInbox, InboxHarness, inboxCard } from '../support/agenda-inbox.tsx';
import { interact, mount, must } from '../support/dom.ts';
import { healthOf } from '../support/health.ts';
import { sessionView } from '../support/sessions.ts';
import { settleUntil } from '../support/settle.ts';
import { wardenConfig, wardenStatus } from '../support/warden.ts';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.invalid', deviceId: 'alpha-token' });
const beta = daemonConnection({ daemonId: 'beta', baseUrl: 'https://beta.invalid', deviceId: 'beta-token' });
const now = () => Date.parse('2026-08-01T12:00:00.000Z');

/**
 * The dashboard drops its view switch below 900px, and `innerWidth` is a
 * process-wide global an earlier suite in the same bun process can leave at a
 * phone width. Pin the desktop width these assertions describe, and hand back
 * whatever was there so this file leaks nothing of its own.
 */
const DESKTOP_WIDTH = 1_440;
let originalWidth: PropertyDescriptor | undefined;

beforeAll(() => {
  originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: DESKTOP_WIDTH });
});

afterAll(() => {
  if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth);
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'innerWidth');
});

const storage = (): ControlsStorage => {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

interface FakeNavigation extends ScopeNavigation {
  readonly pushes: string[];
  readonly replaces: string[];
  /** Listeners still attached — a mounted scope machine holds exactly one. */
  readonly listeners: () => number;
  /** Listener invocations `announce` actually delivered, ever. */
  readonly notified: () => number;
}

const navigation = (path = '/d/alpha'): FakeNavigation => {
  let current = new URL(path, 'https://pwa.invalid');
  let state: unknown = null;
  let notifications = 0;
  const pops = new Set<() => void>();
  const pushes: string[] = [];
  const replaces: string[] = [];
  return {
    pushes,
    replaces,
    listeners: () => pops.size,
    notified: () => notifications,
    snapshot: () => ({ pathname: current.pathname, search: current.search, state }),
    push: (next, url) => {
      pushes.push(url);
      current = new URL(url, 'https://pwa.invalid');
      state = next;
    },
    replace: (next, url) => {
      replaces.push(url);
      current = new URL(url, 'https://pwa.invalid');
      state = next;
    },
    announce: () => {
      pops.forEach(listener => {
        notifications += 1;
        listener();
      });
    },
    listen: listener => {
      pops.add(listener);
      return () => {
        pops.delete(listener);
      };
    },
  };
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};

interface DeferredFleetPort extends DaemonFleetPort {
  /** The gate for one connection key, created on first mention. */
  readonly pending: (key: string) => Deferred<readonly SessionView[]>;
  /** Every `list` call in order, named by the key that identified it. */
  readonly calls: readonly string[];
}

/**
 * A fleet port whose reads finish when the test says so, keyed by whatever
 * identifies the connection for the fencing under proof: the daemon id when two
 * daemons race, the device token when one daemon is re-paired underneath.
 */
const deferredFleet = (keyOf: (daemon: DaemonConnection) => string): DeferredFleetPort => {
  const gates = new Map<string, Deferred<readonly SessionView[]>>();
  const calls: string[] = [];
  const pending = (key: string): Deferred<readonly SessionView[]> => {
    const existing = gates.get(key);
    if (existing !== undefined) return existing;
    const gate = deferred<readonly SessionView[]>();
    gates.set(key, gate);
    return gate;
  };
  return {
    calls,
    pending,
    list: daemon => {
      const key = keyOf(daemon);
      calls.push(key);
      return pending(key).promise;
    },
    get: () => Promise.reject(new Error('not used')),
  };
};

/** Lets real timers run inside `act`, following the `use-usage` precedent. */
const elapse = async (ms: number): Promise<void> => {
  await interact(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
};

/**
 * The usage cadence these assertions drive, and a window several ticks wide.
 * Real timers can only ever fire MORE often than the window promises, so every
 * assertion made across one must be a lower bound — an upper bound belongs
 * behind the store's visibility gate, which no elapsed time can defeat.
 */
const POLL_MS = 5;
const POLL_WINDOW_MS = 26;

const sessions = (prefix: string): readonly SessionView[] => [
  sessionView('shared', {
    config: { teammate: `${prefix}-team`, name: `${prefix} task`, cwd: `/${prefix}/repo`, mode: 'auto' },
    state: { status: 'running', lastActivityAt: '2026-08-01T11:59:00.000Z' },
  }),
];

const projectsFor = (connection: DaemonConnection): readonly FleetProject[] => [
  { name: `${connection.daemonId} repo`, path: `/${connection.daemonId}/repo` },
];

const warden: WardenStatusView = wardenStatus({
  config: wardenConfig({ intervalMinutes: 5 }),
  lastSweepAt: '2026-08-01T11:58:00.000Z',
  fingerprint: 'test',
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const pageProps = (overrides: Partial<SessionsPageProps> = {}): SessionsPageProps => {
  const fleet = new DaemonFleetStore({
    list: daemon => Promise.resolve(daemon.daemonId === alpha.daemonId ? sessions('alpha') : sessions('beta')),
    get: () => Promise.reject(new Error('not used')),
  } satisfies DaemonFleetPort);
  const projects = new DaemonProjectsStore({
    projects: daemon => Promise.resolve(projectsFor(daemon)),
  } satisfies DaemonProjectsPort);
  const usage = new DaemonUsageStore({ usage: () => Promise.resolve({ accounts: [] }) } satisfies DaemonUsagePort, {
    isHidden: () => true,
  });
  return {
    connection: alpha,
    fleet,
    controls: new DaemonControlsStore(storage()),
    projects,
    usage,
    wardenStatus: (() => Promise.resolve(warden)) satisfies WardenStatusReader,
    onOpenWardenReport: () => undefined,
    scopeNavigation: navigation(),
    clock: { now, intervalMs: 60_000, hold: true },
    ...overrides,
  };
};

describe('SessionsPage', () => {
  it('hydrates only its paired daemon and renders its grouped shared id', async () => {
    const props = pageProps();
    const page = await mount(<SessionsPage {...props} />);
    await settle();
    expect(page.container.textContent).toContain('Alpha-Team');
    expect(page.container.querySelector('a[href="/d/alpha/session/shared"]')).not.toBeNull();
    expect(props.fleet.fleet(beta.daemonId).sessions).toBeNull();
    await page.unmount();
  });

  it('switches same-id daemons without leaking rows, then accepts the new connection', async () => {
    const props = pageProps();
    const page = await mount(<SessionsPage {...props} />);
    await settle();
    await page.render(<SessionsPage {...props} connection={beta} scopeNavigation={navigation('/d/beta')} />);
    await settle();
    expect(page.container.textContent).toContain('Beta-Team');
    expect(page.container.textContent).not.toContain('Alpha-Team');
    expect(page.container.querySelector('a[href="/d/beta/session/shared"]')).not.toBeNull();
    await page.unmount();
  });

  it('shows loading and an honest fleet error distinctly', async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<readonly SessionView[]>((_resolve, fail) => {
      reject = fail;
    });
    const props = pageProps({
      fleet: new DaemonFleetStore({ list: () => pending, get: () => Promise.reject(new Error('not used')) }),
    });
    const page = await mount(<SessionsPage {...props} />);
    expect(page.container.querySelectorAll('.animate-pulse')).toHaveLength(6);
    await interact(async () => reject(new Error('fleet offline')));
    // The failure is said for people, in place; the raw text waits behind Details.
    expect(page.container.textContent).toContain('This machine couldn’t refresh its sessions');
    expect(page.container.textContent).not.toContain('fleet offline');
    expect(page.container.querySelector('[data-machine-status-row="refresh-failed"]')).not.toBeNull();
    await page.unmount();
  });

  it('renders an authoritative empty fleet and applies every connected control filter', async () => {
    const empty = pageProps({
      fleet: new DaemonFleetStore({ list: () => Promise.resolve([]), get: () => Promise.reject(new Error('unused')) }),
    });
    const emptyPage = await mount(<SessionsPage {...empty} />);
    await settle();
    expect(emptyPage.container.textContent).toContain('No matching sessions.');
    await emptyPage.unmount();

    const filtered = pageProps({
      fleet: new DaemonFleetStore({
        list: () =>
          Promise.resolve([
            sessionView('auto-rc', {
              config: { teammate: 'auto', name: 'needle', cwd: '/alpha/repo', mode: 'auto', remoteControl: true },
            }),
            sessionView('interactive', {
              config: {
                teammate: 'interactive',
                name: 'needle',
                cwd: '/alpha/repo',
                mode: 'interactive',
                remoteControl: true,
              },
            }),
            sessionView('finished', {
              config: { teammate: 'done', name: 'needle', cwd: '/alpha/repo', mode: 'auto', remoteControl: true },
              state: { status: 'completed' },
            }),
          ]),
        get: () => Promise.reject(new Error('unused')),
      }),
    });
    filtered.controls.setDeviceControls({ query: 'needle', mode: 'auto', rcOnly: true, includeFinished: false });
    const page = await mount(<SessionsPage {...filtered} />);
    await settle();
    expect(page.container.textContent).toContain('Auto');
    expect(page.container.textContent).not.toContain('Interactive');
    expect(page.container.textContent).not.toContain('Done');
    await page.unmount();
  });

  it('writes device view controls and pushes daemon-qualified scope history', async () => {
    const props = pageProps();
    const nav = navigation();
    const page = await mount(<SessionsPage {...props} scopeNavigation={nav} />);
    await settle();
    const cards = must(
      Array.from(page.container.querySelectorAll('button')).find(button => button.textContent?.includes('cards')),
      'cards tab',
    );
    await interact(() => cards.click());
    expect(props.controls.controls(alpha.daemonId).dashboardView).toBe('cards');
    await interact(() =>
      (
        must(page.container.querySelector('[aria-label="Focus folder alpha repo"]'), 'project heading') as HTMLElement
      ).click(),
    );
    expect(nav.pushes).toEqual(['/d/alpha?project=%2Falpha%2Frepo']);
    expect(props.controls.controls(alpha.daemonId).projectScope).toBe('/alpha/repo');
    await page.unmount();
  });

  it('renders a scoped header, exits scope, and recovers only this daemon scope', async () => {
    const props = pageProps();
    props.controls.setControls(alpha.daemonId, { projectScope: '/alpha/repo' });
    props.controls.setControls(beta.daemonId, { projectScope: '/beta/repo' });
    const nav = navigation();
    const page = await mount(<SessionsPage {...props} scopeNavigation={nav} />);
    await settle();
    expect(page.container.textContent).toContain('alpha repo');
    expect(page.container.textContent).toContain('1 session');
    await interact(() =>
      (must(page.container.querySelector('[aria-label="Show all folders"]'), 'scope exit') as HTMLElement).click(),
    );
    expect(props.controls.controls(alpha.daemonId).projectScope).toBeNull();
    expect(props.controls.controls(beta.daemonId).projectScope).toBe('/beta/repo');
    await page.unmount();

    const recoveryProps = pageProps();
    recoveryProps.controls.setControls(alpha.daemonId, { projectScope: '/missing' });
    const recovered = await mount(<SessionsPage {...recoveryProps} scopeNavigation={navigation()} />);
    await settle();
    // The pure dashboard suite proves its transient role=status banner. Here the
    // connected effect is allowed to clear in the same React flush, so prove its
    // durable daemon-qualified recovery side effects instead.
    expect(recoveryProps.controls.controls(alpha.daemonId).projectScope).toBeNull();
    expect((recovered.container.querySelector('main') as HTMLElement).dataset.density).toBe('full');
    await recovered.unmount();
  });

  it('mounts usage only at full density and releases it when density becomes compact', async () => {
    const reads: string[] = [];
    const props = pageProps({
      usage: new DaemonUsageStore(
        {
          usage: daemon => {
            reads.push(daemon.daemonId);
            return Promise.resolve({ accounts: [] });
          },
        },
        { isHidden: () => true },
      ),
    });
    props.controls.setDeviceControls({ density: 'compact' });
    const page = await mount(<SessionsPage {...props} />);
    await settle();
    expect(reads).toEqual([]);
    await interact(() => props.controls.setDeviceControls({ density: 'full' }));
    await settle();
    expect(reads).toEqual([alpha.daemonId]);
    await interact(() => props.controls.setDeviceControls({ density: 'minimal' }));
    await settle();
    await page.unmount();
  });

  it('names each session’s account by its fleet name at full density, reading the roster only there', async () => {
    const reads: string[] = [];
    const noHealth: AccountPickerHealthCatalog = { health: new Map(), error: null };
    const accountPicker = new DaemonAccountPickerStore({
      catalog: async daemon => {
        reads.push(daemon.daemonId);
        return {
          accounts: [
            {
              id: 'claude-id',
              kind: 'claude',
              agent: true,
              credentialId: 'login-claude',
              wrapper: 'claude',
              displayName: 'Studio Claude',
              defaultModel: null,
              models: [],
              available: true,
              unavailableReason: null,
            },
          ],
        };
      },
      health: async () => noHealth,
      checkHealth: async () => noHealth,
    });
    const props = pageProps({ accountPicker });
    props.controls.setDeviceControls({ density: 'compact' });
    const page = await mount(<SessionsPage {...props} />);
    await settle();
    expect(reads).toEqual([]);
    expect(page.container.textContent).not.toContain('Studio Claude');
    await interact(() => props.controls.setDeviceControls({ density: 'full' }));
    await settle();
    expect(reads).toEqual([alpha.daemonId]);
    expect(page.container.querySelector('[data-account="claude"]')?.textContent).toBe('Studio Claude');
    await page.unmount();
  });

  it('propagates warden status and cleans subscriptions on unmount', async () => {
    let reads = 0;
    const props = pageProps({
      wardenStatus: () => {
        reads += 1;
        return Promise.resolve(warden);
      },
    });
    const page = await mount(<SessionsPage {...props} />);
    await settle();
    expect(page.container.textContent).toContain('Fleet checks');
    await page.unmount();
    expect(reads).toBe(1);
  });

  it('composes as a route-matched PageHost Sessions slot', async () => {
    const props = pageProps();
    const Empty: ComponentType = () => null;
    const Session: ComponentType<{
      connection: DaemonConnection;
      scope: { daemonId: typeof alpha.daemonId; sessionId: string };
    }> = () => null;
    const page = await mount(
      <PageHost
        connection={alpha}
        route={{ kind: 'sessions', daemonId: alpha.daemonId }}
        slots={{
          ConnectionPicker: Empty,
          Setup: Empty,
          Sessions: connection => <SessionsPage {...props} connection={connection.connection} />,
          NewSession: Empty,
          SessionChat: Session,
          Settings: Empty,
          Warden: Empty,
          Analytics: Empty,
          Learning: Empty,
        }}
      />,
    );
    await settle();
    expect(page.container.textContent).toContain('Alpha-Team');
    await page.unmount();
  });

  it('never lets a late Alpha hydrate overwrite the Beta row holding the same id', async () => {
    const port = deferredFleet(daemon => daemon.daemonId);
    const fleet = new DaemonFleetStore(port);
    const props = pageProps({ fleet });
    const page = await mount(<SessionsPage {...props} />);
    await settle();
    await page.render(<SessionsPage {...props} connection={beta} scopeNavigation={navigation('/d/beta')} />);
    await settle();
    expect(port.calls).toEqual([alpha.daemonId, beta.daemonId]);

    await interact(() => port.pending(beta.daemonId).resolve(sessions('beta')));
    await settle();
    expect(page.container.textContent).toContain('Beta-Team');

    // Alpha answers last, into a page that is now paired elsewhere.
    await interact(() => port.pending(alpha.daemonId).resolve(sessions('alpha')));
    await settle();
    expect(page.container.textContent).toContain('Beta-Team');
    expect(page.container.textContent).not.toContain('Alpha-Team');
    expect(page.container.querySelector('a[href="/d/beta/session/shared"]')).not.toBeNull();
    expect(page.container.querySelector('a[href="/d/alpha/session/shared"]')).toBeNull();
    expect(must(fleet.session({ daemonId: beta.daemonId, sessionId: 'shared' }), 'beta row').config.name).toBe(
      'beta task',
    );
    // The answer was published — to the slice that asked for it, not this one.
    expect(must(fleet.session({ daemonId: alpha.daemonId, sessionId: 'shared' }), 'alpha row').config.name).toBe(
      'alpha task',
    );
    await page.unmount();
  });

  it('never lets a late Alpha hydrate paper over the Beta fleet error', async () => {
    const port = deferredFleet(daemon => daemon.daemonId);
    const fleet = new DaemonFleetStore(port);
    const props = pageProps({ fleet });
    const page = await mount(<SessionsPage {...props} />);
    await settle();
    await page.render(<SessionsPage {...props} connection={beta} scopeNavigation={navigation('/d/beta')} />);
    await settle();

    await interact(() => port.pending(beta.daemonId).reject(new Error('beta offline')));
    await settle();
    expect(page.container.textContent).toContain('couldn’t refresh its sessions');

    await interact(() => port.pending(alpha.daemonId).resolve(sessions('alpha')));
    await settle();
    expect(page.container.textContent).toContain('couldn’t refresh its sessions');
    expect(page.container.textContent).not.toContain('Alpha-Team');
    const slice = fleet.fleet(beta.daemonId);
    expect(slice.sessions).toBeNull();
    expect(slice.status).toBe('error');
    expect(slice.error).toBe('beta offline');
    await page.unmount();
  });

  it('keeps the re-paired hydrate when the replaced connection answers last', async () => {
    const rotated = daemonConnection({
      daemonId: alpha.daemonId,
      baseUrl: 'https://alpha-relay.invalid',
      deviceId: 'alpha-token-2',
    });
    const port = deferredFleet(daemon => daemon.deviceId);
    const fleet = new DaemonFleetStore(port);
    const props = pageProps({ fleet });
    const page = await mount(<SessionsPage {...props} />);
    await settle();
    await page.render(<SessionsPage {...props} connection={rotated} />);
    await settle();
    // Same durable daemon, two connections: the re-pair is its own read.
    expect(port.calls).toEqual([alpha.deviceId, rotated.deviceId]);

    await interact(() => port.pending(rotated.deviceId).resolve(sessions('repaired')));
    await settle();
    expect(page.container.textContent).toContain('Repaired-Team');

    await interact(() => port.pending(alpha.deviceId).resolve(sessions('stale')));
    await settle();
    expect(page.container.textContent).toContain('Repaired-Team');
    expect(page.container.textContent).not.toContain('Stale-Team');
    const rows = must(fleet.fleet(alpha.daemonId).sessions, 'alpha rows');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.config.name).toBe('repaired task');
    await page.unmount();
  });

  it('polls usage only while full density is mounted and leaves it stopped after unmount', async () => {
    const reads: string[] = [];
    /**
     * The store's visibility gate is this test's clock control. The read that
     * follows `watch()` is unconditional, while every TICK is skipped while the
     * tab is hidden — so entering full density hidden makes "mounting reads
     * once" a lifecycle fact, instead of a race between a 5ms poll and however
     * long a loaded machine takes to reach the next assertion.
     */
    let hidden = true;
    const props = pageProps({
      usage: new DaemonUsageStore(
        {
          usage: daemon => {
            reads.push(daemon.daemonId);
            return Promise.resolve({ at: '2026-08-01T11:59:00.000Z', stale: false, accounts: [] });
          },
        },
        { pollMs: POLL_MS, isHidden: () => hidden },
      ),
    });
    props.controls.setDeviceControls({ density: 'compact' });
    const page = await mount(<SessionsPage {...props} />);
    let atUnmount = 0;
    try {
      await settle();
      await elapse(POLL_WINDOW_MS);
      expect(reads).toEqual([]);

      await interact(() => props.controls.setDeviceControls({ density: 'full' }));
      await settle();
      expect(reads).toEqual([alpha.daemonId]);
      // Mounting reads once and once only: a hidden tab adds nothing to that,
      // however many tick deadlines pass before the tab is looked at again.
      await elapse(POLL_WINDOW_MS);
      expect(reads).toEqual([alpha.daemonId]);

      hidden = false;
      await elapse(POLL_WINDOW_MS);
      const polled = reads.length;
      expect(polled).toBeGreaterThan(1);
      expect(reads.every(read => read === alpha.daemonId)).toBe(true);

      await interact(() => props.controls.setDeviceControls({ density: 'minimal' }));
      await settle();
      const lean = reads.length;
      await elapse(POLL_WINDOW_MS);
      expect(reads).toHaveLength(lean);

      // Re-enter full so unmount has a live poll to tear down, not a dead one.
      await interact(() => props.controls.setDeviceControls({ density: 'full' }));
      await settle();
      await elapse(POLL_WINDOW_MS);
      expect(reads.length).toBeGreaterThan(lean + 1);
    } finally {
      await page.unmount();
      atUnmount = reads.length;
    }
    await elapse(POLL_WINDOW_MS);
    expect(reads).toHaveLength(atUnmount);
  });

  it('detaches the warden poll and the scope listener at unmount', async () => {
    let reads = 0;
    const gate = deferred<WardenStatusView>();
    const nav = navigation();
    const props = pageProps({
      scopeNavigation: nav,
      wardenStatus: () => {
        reads += 1;
        return gate.promise;
      },
    });
    const page = await mount(<SessionsPage {...props} />);
    await settle();
    expect(reads).toBe(1);
    expect(nav.listeners()).toBe(1);

    // An unrelated control write must not restart either subscription.
    await interact(() => props.controls.setDeviceControls({ query: 'shared' }));
    await settle();
    expect(reads).toBe(1);
    expect(nav.listeners()).toBe(1);

    // The stimulus, proved live first: a scoped address a listener honours.
    await interact(() => {
      nav.push(projectScopeState(alpha.daemonId, '/alpha/repo'), projectScopePath(alpha.daemonId, '/alpha/repo'));
      nav.announce();
    });
    expect(nav.notified()).toBe(1);
    expect(props.controls.controls(alpha.daemonId).projectScope).toBe('/alpha/repo');

    await page.unmount();
    expect(nav.listeners()).toBe(0);

    // The same stimulus after teardown reaches nobody and writes nothing.
    await interact(() => {
      nav.push(projectScopeState(alpha.daemonId, '/alpha/other'), projectScopePath(alpha.daemonId, '/alpha/other'));
      nav.announce();
    });
    expect(nav.notified()).toBe(1);
    expect(props.controls.controls(alpha.daemonId).projectScope).toBe('/alpha/repo');

    // The read still in flight at teardown answers a cancelled effect: the
    // reader is never called again, and nothing throws out of the resolution.
    await interact(async () => {
      gate.resolve(warden);
      await gate.promise;
    });
    expect(reads).toBe(1);
  });

  it('says "Updating…" over the cached rows until the live read answers, then stops', async () => {
    // Arrange
    const gate = deferred<readonly SessionView[]>();
    const fleet = new DaemonFleetStore({ list: () => gate.promise, get: () => Promise.reject(new Error('not used')) });
    fleet.seed(alpha, sessions('alpha'), now());
    const page = await mount(<SessionsPage {...pageProps({ fleet })} />);
    try {
      // Act
      const cached = page.container.querySelectorAll('[data-cache-updating]').length;
      const cachedRows = page.container.textContent;
      await interact(async () => gate.resolve(sessions('alpha')));
      await settle();

      // Assert
      expect(cached).toBe(1);
      expect(cachedRows).toContain('Alpha-Team');
      expect(page.container.querySelectorAll('[data-cache-updating]')).toHaveLength(0);
      expect(page.container.textContent).toContain('Alpha-Team');
    } finally {
      await page.unmount();
    }
  });
});

describe('SessionsPage across every machine', () => {
  const machineSource = (connection: DaemonConnection, rows: readonly SessionView[]) => ({
    daemonId: connection.daemonId,
    name: String(connection.daemonId),
    reach: 'online' as const,
    projects: projectsFor(connection),
    slice: { sessions: rows, byId: new Map(), status: 'ready' as const, error: null },
  });

  it('lists every machine, filters each by the page’s own search, and opens another machine’s folder there', async () => {
    const navigated: string[] = [];
    const props = pageProps({
      machineSources: [machineSource(alpha, sessions('alpha')), machineSource(beta, sessions('beta'))],
      newSessionMachines: [
        { daemonId: alpha.daemonId, name: 'alpha' },
        { daemonId: beta.daemonId, name: 'beta' },
      ],
      onNavigate: path => navigated.push(path),
    });
    const page = await mount(<SessionsPage {...props} />);
    await settle();
    expect(page.container.querySelectorAll('[data-machine-section]')).toHaveLength(2);
    expect(page.container.querySelector('[data-new-session-menu]')).not.toBeNull();
    const heads = [...page.container.querySelectorAll<HTMLButtonElement>('[aria-label="Focus folder beta repo"]')];
    await interact(() => heads[0]?.click());
    expect(navigated).toEqual([projectScopePath(beta.daemonId, '/beta/repo')]);

    await interact(() => props.controls.setDeviceControls({ query: 'beta task' }));
    expect(page.container.querySelector('[data-machine-section="alpha"] .fy-machine-section__empty')?.textContent).toBe(
      'No sessions on this machine.',
    );
    await page.unmount();
  });

  it('a focused folder is one machine’s page again', async () => {
    const props = pageProps({
      machineSources: [machineSource(alpha, sessions('alpha')), machineSource(beta, sessions('beta'))],
      scopeNavigation: navigation(projectScopePath(alpha.daemonId, '/alpha/repo')),
    });
    const page = await mount(<SessionsPage {...props} />);
    await settle();
    expect(page.container.querySelector('[data-all-machines]')).toBeNull();
    await page.unmount();
  });

  it('without a navigator another machine’s folder goes nowhere rather than somewhere wrong', async () => {
    const props = pageProps({
      machineSources: [machineSource(alpha, sessions('alpha')), machineSource(beta, sessions('beta'))],
    });
    const page = await mount(<SessionsPage {...props} />);
    await settle();
    const heads = [...page.container.querySelectorAll<HTMLButtonElement>('[aria-label="Focus folder beta repo"]')];
    await interact(() => heads[0]?.click());
    expect(page.container.querySelectorAll('[data-machine-section]')).toHaveLength(2);
    await page.unmount();
  });
});

describe('SessionsPage Needs you', () => {
  const card = inboxCard(agendaItem('A4', { subject: 'Rebase onto main?', ask: choices('Rebase now', 'Wait') }));

  const withInbox = (fake: FakeInbox, cards: readonly InboxCard[], props: SessionsPageProps) => (
    <InboxHarness
      cards={cards}
      fake={fake}
      render={inbox => (
        <AgendaInboxContext.Provider value={inbox}>
          <SessionsPage {...props} />
        </AgendaInboxContext.Provider>
      )}
    />
  );

  it('puts the newest open Attention above the list, with See all into this machine’s inbox', async () => {
    const navigated: string[] = [];
    const page = await mount(withInbox(fakeInbox(), [card], pageProps({ onNavigate: to => navigated.push(to) })));
    await settle();
    const deck = must(page.container.querySelector('[data-agenda-needs-you]'), 'the Needs you deck');
    expect(deck.querySelector('[data-agenda-card="A4"]')).not.toBeNull();
    expect(deck.querySelector('[data-agenda-see-all]')?.getAttribute('href')).toBe('/d/alpha/inbox');
    // Above the list, not inside or after it.
    const list = must(page.container.querySelector('main'), 'the dashboard');
    expect(deck.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(page.container.textContent).toContain('Alpha-Team');
    await page.unmount();
  });

  it('draws no deck with nothing open, and none at all without a shell inbox', async () => {
    const empty = await mount(withInbox(fakeInbox(), [], pageProps()));
    await settle();
    expect(empty.container.querySelector('[data-agenda-needs-you]')).toBeNull();
    await empty.unmount();

    const bare = await mount(<SessionsPage {...pageProps()} />);
    await settle();
    expect(bare.container.querySelector('[data-agenda-needs-you]')).toBeNull();
    expect(bare.container.querySelector('[data-agenda-undo]')).toBeNull();
    await bare.unmount();
  });
});

describe('SessionsPage on a saturated disk', () => {
  const machineAnswering = (io?: unknown) =>
    ({
      request: async (_path: string, schema: { parse: (value: unknown) => unknown }) =>
        schema.parse({ ...healthOf('4.101.0'), ...(io === undefined ? {} : { io }) }),
    }) as unknown as FyApiClient;

  it('says the daemon is slow, not dead, above the sessions it still lists', async () => {
    // Arrange
    const client = machineAnswering({ someAvg10: 52, fullAvg10: 46, saturated: true });
    const page = await mount(
      <DaemonClientProvider client={async () => client}>
        <SessionsPage {...pageProps()} />
      </DaemonClientProvider>,
    );
    try {
      // Act
      await settleUntil(
        () => page.container.querySelector('[data-disk-pressure]') !== null,
        'the disk note to appear',
        interact,
      );

      // Assert
      expect(page.container.querySelector('[data-disk-pressure]')?.textContent).toBe(
        'Disk is saturated (io pressure 46% full) — the daemon is slow, not dead',
      );
      expect(page.container.textContent).toContain('Alpha-Team');
    } finally {
      await page.unmount();
    }
  });

  it('says nothing about the disk when the machine reports none', async () => {
    // Arrange
    const client = machineAnswering();
    const page = await mount(
      <DaemonClientProvider client={async () => client}>
        <SessionsPage {...pageProps()} />
      </DaemonClientProvider>,
    );
    try {
      // Act
      await settle();

      // Assert
      expect(page.container.querySelector('[data-disk-pressure]')).toBeNull();
    } finally {
      await page.unmount();
    }
  });
});
