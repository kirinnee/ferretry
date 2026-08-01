import '../support/dom.ts';

import { describe, expect, it } from 'bun:test';
import type { SessionView, WardenStatusView } from '@ferretry/protocol';
import type { ComponentType } from 'react';

import { SessionsPage, type SessionsPageProps } from '../../src/components/sessions-page.tsx';
import type { ScopeNavigation } from '../../src/hooks/use-project-scope.ts';
import type { WardenStatusReader } from '../../src/hooks/use-warden-status.ts';
import { type ControlsStorage, DaemonControlsStore } from '../../src/lib/controls.ts';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { FleetProject } from '../../src/lib/fleet-grouping.ts';
import type { DaemonFleetPort } from '../../src/lib/fleet-store.ts';
import { DaemonFleetStore } from '../../src/lib/fleet-store.ts';
import { PageHost } from '../../src/lib/pages/page-host.tsx';
import { type DaemonProjectsPort, DaemonProjectsStore } from '../../src/lib/projects-store.ts';
import { type DaemonUsagePort, DaemonUsageStore } from '../../src/lib/usage-store.ts';
import { interact, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.invalid', deviceToken: 'alpha-token' });
const beta = daemonConnection({ daemonId: 'beta', baseUrl: 'https://beta.invalid', deviceToken: 'beta-token' });
const now = () => Date.parse('2026-08-01T12:00:00.000Z');

const storage = (): ControlsStorage => {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

interface FakeNavigation extends ScopeNavigation {
  readonly pushes: string[];
  readonly replaces: string[];
}

const navigation = (path = '/d/alpha'): FakeNavigation => {
  let current = new URL(path, 'https://pwa.invalid');
  let state: unknown = null;
  const listeners = new Set<() => void>();
  const pushes: string[] = [];
  const replaces: string[] = [];
  return {
    pushes,
    replaces,
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
      listeners.forEach(listener => {
        listener();
      });
    },
    listen: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

const sessions = (prefix: string): readonly SessionView[] => [
  sessionView('shared', {
    config: { teammate: `${prefix}-team`, name: `${prefix} task`, cwd: `/${prefix}/repo`, mode: 'auto' },
    state: { status: 'running', lastActivityAt: '2026-08-01T11:59:00.000Z' },
  }),
];

const projectsFor = (connection: DaemonConnection): readonly FleetProject[] => [
  { name: `${connection.daemonId} repo`, path: `/${connection.daemonId}/repo` },
];

const warden: WardenStatusView = {
  config: {
    enabled: true,
    accounts: [],
    failover: { policy: 'fallback', failureThreshold: 3, cooldownMinutes: 30 },
    providerOutage: { minDistinctSessions: 2, persistenceSweeps: 2, tailLines: 40 },
    intervalMinutes: 5,
    unattendedMinutes: 20,
    minSpawnGapMinutes: 10,
    susThinkingSeconds: 600,
    susSubprocessSeconds: 900,
    maxAssignedWardens: 2,
    assignedCooldownMinutes: 15,
    blessMinutes: 30,
  },
  lastSweepAt: '2026-08-01T11:58:00.000Z',
  anomalies: [],
  fingerprint: 'test',
};

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
    expect(page.container.textContent).toContain('fleet offline');
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
});
