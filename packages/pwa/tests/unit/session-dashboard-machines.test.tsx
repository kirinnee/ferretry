import { afterEach, describe, expect, test } from 'bun:test';
import { SessionDashboard, type SessionDashboardProps } from '../../src/components/session-dashboard.tsx';
import type { PickerAccount } from '../../src/lib/account-picker-catalog.ts';
import { allMachinesView, type MachineSource } from '../../src/lib/all-machines.ts';
import { type DaemonId, daemonConnection } from '../../src/lib/daemon-connection.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const studio = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.invalid', deviceId: 'on-studio' });
const LAPTOP = 'laptop' as DaemonId;
const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const row = (id: string, cwd: string, state: Record<string, unknown> = {}) =>
  sessionView(id, { config: { teammate: id, name: `Task ${id}`, cwd }, state: { lastActivityAt: ago(2), ...state } });

const source = (
  daemonId: DaemonId,
  name: string,
  sessions: MachineSource['slice']['sessions'],
  reach: MachineSource['reach'],
): MachineSource => ({
  daemonId,
  name,
  reach,
  projects: [{ name: 'ferretry', path: '/work/ferretry' }],
  slice: { sessions, byId: new Map(), status: 'ready', error: null, readAt: NOW - 5 * 60_000 },
});

const SOURCES: readonly MachineSource[] = [
  source(
    studio.daemonId,
    'studio',
    [row('ivo', '/work/ferretry'), row('hadi', '/work/ferretry', { status: 'awaiting_question' })],
    'online',
  ),
  source(LAPTOP, 'laptop', [row('pim', '/work/ferretry', { status: 'awaiting_user' })], 'offline'),
];

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const dashboard = (overrides: Partial<SessionDashboardProps> = {}) => {
  const calls: string[] = [];
  const element = (
    <SessionDashboard
      allMachines={allMachinesView(SOURCES)}
      connection={studio}
      dashboardView={null}
      density="compact"
      error={null}
      groups={[]}
      narrow
      newSessionMachines={[
        { daemonId: studio.daemonId, name: 'studio' },
        { daemonId: LAPTOP, name: 'laptop' },
      ]}
      now={NOW}
      onEnterScope={path => calls.push(`enter:${path}`)}
      onExitScope={() => undefined}
      onFocusMachine={(daemon, path) => calls.push(`focus:${daemon}:${path}`)}
      onNavigate={to => calls.push(`navigate:${to}`)}
      onOpenWardenReport={() => undefined}
      onSetView={() => undefined}
      scope={null}
      scopeName=""
      scopeRecovered={false}
      sessions={null}
      usage={null}
      wardenStatus={null}
      wardenVerdicts={[]}
      {...overrides}
    />
  );
  return { calls, element };
};

const click = async (element: Element | null, what: string): Promise<void> => {
  await interact(() => (must(element, what) as HTMLElement).click());
};

describe('the Sessions page across every machine', () => {
  test('pins Needs you with each row’s machine, then every machine with its own folders', async () => {
    const { element, calls } = dashboard();
    view = await mount(element);
    const pinned = must(view.container.querySelector('[data-needs-you-group]'), 'Needs you');
    expect(pinned.querySelectorAll('[data-session-row]')).toHaveLength(1);
    expect(pinned.querySelector('[data-machine-chip]')?.textContent).toBe('studio');
    const sections = [...view.container.querySelectorAll('[data-machine-section]')];
    expect(sections.map(section => section.getAttribute('data-machine-reach'))).toEqual(['online', 'offline']);
    // The down machine says so IN ITS OWN SECTION: a status line under its heading, its rows read-only.
    expect(sections[1]?.querySelector('h2')?.textContent).toContain('offline');
    const status = sections[1]?.querySelector('[data-machine-status]');
    expect(status?.textContent).toContain('Unreachable');
    expect(status?.textContent).toMatch(/as of \d\d:\d\d/);
    expect(sections[1]?.querySelector('[data-machine-read-only]')?.getAttribute('title')).toContain(
      'laptop isn’t reachable right now',
    );
    expect(sections[0]?.querySelector('[data-machine-status]')).toBeNull();
    expect(view.container.querySelectorAll('[data-machine-section] [data-machine-chip]')).toHaveLength(0);
    // The count is what is drawn across machines; all three sessions are.
    expect(view.container.querySelector('[title="visible / total sessions"]')?.textContent).toBe('3/3');

    // This machine's folder focuses here; another machine's opens that machine.
    const heads = [...view.container.querySelectorAll<HTMLButtonElement>('[aria-label="Focus folder ferretry"]')];
    await click(heads[0] ?? null, 'studio’s folder');
    await click(heads[1] ?? null, 'laptop’s folder');
    expect(calls).toEqual(['enter:/work/ferretry', 'focus:laptop:/work/ferretry']);

    await click(view.container.querySelector('[data-new-session-menu]'), '+ New');
    const items = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="New session on"] [role="menuitem"]')];
    // laptop is offline: still listed, but disabled with its reason, so "+ New" never dead-ends on it.
    expect(items.map(item => item.textContent)).toEqual(['studiothis one', 'laptoplaptop isn’t reachable right now']);
    expect(items.map(item => item.disabled)).toEqual([false, true]);
    await interact(() => items[1]?.click());
    expect(calls.at(-1)).not.toBe('navigate:/d/laptop/new');
    await interact(() => items[0]?.click());
    expect(calls.at(-1)).toBe('navigate:/d/studio/new');
  });

  test('full density draws the full rows per machine, and an emptied machine says where its sessions went', async () => {
    const onlyAsking = [
      source(LAPTOP, 'laptop', [row('ora', '/work/ferretry', { status: 'awaiting_question' })], 'online'),
    ];
    view = await mount(
      dashboard({ allMachines: allMachinesView([...SOURCES.slice(0, 1), ...onlyAsking]), density: 'full' }).element,
    );
    expect(view.container.querySelectorAll('[data-needs-you-group] [data-session-row]')).toHaveLength(2);
    // A phone draws full cards; each one links to its own machine.
    expect(
      view.container.querySelector('[data-machine-section="studio"] a[href="/d/studio/session/ivo"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector('[data-machine-section="laptop"] .fy-machine-section__empty')?.textContent,
    ).toBe('Everything on this machine is in Needs you.');
    await view.render(
      dashboard({ allMachines: allMachinesView([source(LAPTOP, 'laptop', [], 'online')]), density: 'full' }).element,
    );
    expect(view.container.querySelector('.fy-machine-section__empty')?.textContent).toBe(
      'No sessions on this machine.',
    );
  });

  test('full rows on every machine name the account from THAT machine’s roster, and never borrow another’s', async () => {
    const account = (displayName: string): PickerAccount => ({
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'claude',
      agent: true,
      credentialId: `login-${displayName}`,
      wrapper: 'claude',
      displayName,
      defaultModel: 'opus',
      models: [{ id: 'opus', available: true }],
      available: true,
      unavailableReason: null,
    });
    const both = allMachinesView([
      source(studio.daemonId, 'studio', [row('ivo', '/work/ferretry')], 'online'),
      source(LAPTOP, 'laptop', [row('rue', '/work/ferretry')], 'online'),
    ]);
    const accountOn = (machine: string) =>
      view?.container.querySelector(`[data-machine-section="${machine}"] [data-account]`)?.textContent ?? null;
    view = await mount(
      dashboard({
        allMachines: both,
        density: 'full',
        accounts: [account('Studio Max')],
        machineAccounts: new Map([
          [studio.daemonId, [account('Studio Max')]],
          [LAPTOP, [account('Laptop Pro')]],
        ]),
      }).element,
    );
    expect([accountOn('studio'), accountOn('laptop')]).toEqual(['Studio Max', 'Laptop Pro']);
    // The laptop's roster is not read yet: its row names no account rather than the studio's.
    await view.render(
      dashboard({ allMachines: both, density: 'full', accounts: [account('Studio Max')], machineAccounts: new Map() })
        .element,
    );
    expect([accountOn('studio'), accountOn('laptop')]).toEqual(['Studio Max', null]);
  });

  test('a skeleton until any machine answers; one machine to start on keeps the plain link', async () => {
    view = await mount(
      dashboard({
        allMachines: allMachinesView([source(studio.daemonId, 'studio', null, 'reading')]),
        newSessionMachines: [{ daemonId: studio.daemonId, name: 'studio' }],
      }).element,
    );
    expect(view.container.querySelector('[data-all-machines]')).toBeNull();
    expect(view.container.querySelector('.animate-pulse')).not.toBeNull();
    expect(view.container.querySelector('[data-new-session-menu]')).toBeNull();
    expect(view.container.querySelector('a[href="/d/studio/new"]')).not.toBeNull();
  });

  test('without a navigator a second machine cannot be chosen, so the link stays', async () => {
    view = await mount(dashboard({ onNavigate: undefined }).element);
    expect(view.container.querySelector('[data-new-session-menu]')).toBeNull();
  });
});
