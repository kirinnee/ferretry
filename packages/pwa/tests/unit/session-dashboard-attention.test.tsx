import { afterEach, describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { SessionDashboard, type SessionDashboardProps } from '../../src/components/session-dashboard.tsx';
import { activityLine, pullDashboardNeedsYou } from '../../src/components/session-dashboard-model.ts';
import { allMachinesView, type MachineSource } from '../../src/lib/all-machines.ts';
import { type DaemonId, daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { SessionGroup } from '../../src/lib/fleet-grouping.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const studio = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.invalid', deviceId: 'on-studio' });
const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const row = (id: string, minutesAgo?: number, open = 1, first = 'A1', cwd = '/work/ferretry'): SessionView =>
  sessionView(id, {
    config: { teammate: id, name: `Task ${id}`, cwd },
    state: {
      lastActivityAt: ago(2),
      ...(minutesAgo === undefined
        ? {}
        : { attention: { open, first, ask: `Ask of ${id}?`, latestAt: ago(minutesAgo) } }),
    },
  });

const group = (name: string, rows: readonly SessionView[]): SessionGroup => ({ name, path: `/work/${name}`, rows });

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const dashboard = (overrides: Partial<SessionDashboardProps> = {}) => {
  const calls: string[] = [];
  const element = (
    <SessionDashboard
      connection={studio}
      dashboardView={null}
      density="compact"
      error={null}
      groups={[]}
      narrow
      now={NOW}
      onEnterScope={() => undefined}
      onExitScope={() => undefined}
      onNavigate={to => calls.push(`navigate:${to}`)}
      onOpenWardenReport={() => undefined}
      onSetView={() => undefined}
      scope={null}
      scopeName=""
      scopeRecovered={false}
      sessions={[]}
      usage={null}
      wardenStatus={null}
      wardenVerdicts={[]}
      {...overrides}
    />
  );
  return { calls, element };
};

const withGroups = (groups: readonly SessionGroup[], overrides: Partial<SessionDashboardProps> = {}) =>
  dashboard({ groups, sessions: groups.flatMap(g => g.rows), ...overrides });

const rowIds = (root: Element, attribute: string): (string | null)[] =>
  [...root.querySelectorAll(`[${attribute}]`)].map(node => node.getAttribute(attribute));

describe('pullDashboardNeedsYou', () => {
  test('lifts Attention sessions newest first, lists each once, and drops a group it emptied', () => {
    const groups = [
      group('ferretry', [row('calm-a'), row('old', 40), row('new', 3)]),
      group('notes', [row('tie-a', 10, 1, 'A1', '/work/notes'), row('tie-b', 10, 1, 'A2', '/work/notes')]),
    ];
    const result = pullDashboardNeedsYou(groups);
    expect(result.needsYou.map(v => v.config.id)).toEqual(['new', 'tie-a', 'tie-b', 'old']);
    expect(result.groups.map(g => g.name)).toEqual(['ferretry']);
    expect(result.groups[0]?.rows.map(v => v.config.id)).toEqual(['calm-a']);
  });

  test('returns the groups untouched when nothing has Attention, and ignores the quiet status signal', () => {
    const parked = sessionView('parked', { state: { status: 'awaiting_user' } });
    const groups = [group('ferretry', [row('x'), parked])];
    const result = pullDashboardNeedsYou(groups);
    expect(result.needsYou).toEqual([]);
    expect(result.groups).toBe(groups);
  });

  test('lifts nothing when grouping is off: sessions stay in their project group', () => {
    const groups = [group('ferretry', [row('calm-a'), row('new', 3)])];
    const result = pullDashboardNeedsYou(groups, false);
    expect(result.needsYou).toEqual([]);
    expect(result.groups).toBe(groups);
  });

  test('a Your turn session with no Attention items is not needs-you', () => {
    const turn = sessionView('turn', { state: { status: 'awaiting_user' } });
    expect(pullDashboardNeedsYou([group('ferretry', [turn])]).needsYou).toEqual([]);
  });
});

describe('activityLine', () => {
  test('says the Attention ask as the line when the session has open Attention', () => {
    expect(activityLine(row('a', 1)).text).toBe('asks: Ask of a?');
  });
});

describe('the sessions page with Attention', () => {
  test('puts a Needs you group first, newest first, and opens each row at its first item', async () => {
    const { element, calls } = withGroups([
      group('ferretry', [row('calm'), row('old', 30, 2, 'A4'), row('new', 2, 1, 'A9')]),
    ]);
    view = await mount(element);
    const needs = must(view.container.querySelector('[data-needs-you-group]'), 'the Needs you group');
    expect(rowIds(needs, 'data-session-row')).toEqual(['new', 'old']);
    expect(rowIds(view.container, 'data-session-row')).toEqual(['new', 'old', 'calm']);
    const old = must(needs.querySelector('[data-session-row="old"]'), 'the old row');
    expect(old.getAttribute('href') ?? '').toContain('/session/old?agenda=A4');
    expect(old.querySelector('[data-session-ask]')?.textContent).toBe('Ask of old?');
    await interact(() => (old as HTMLElement).click());
    expect(calls.at(-1)).toBe('navigate:/d/studio/session/old?agenda=A4');
    expect(view.container.querySelector('[data-session-row="calm"]')?.getAttribute('href')).toBe(
      '/d/studio/session/calm',
    );
  });

  test('a card shows the bold name, the accent count (99+ capped) and says the count to a screen reader', async () => {
    view = await mount(withGroups([group('ferretry', [row('big', 1, 150), row('one', 2), row('calm')])]).element);
    const big = must(view.container.querySelector('[data-session-row="big"]'), 'the busy card');
    expect(big.hasAttribute('data-session-unread')).toBe(true);
    expect(big.querySelector('[data-unread-badge]')?.textContent).toContain('99+');
    expect(big.querySelector('.sr-only')?.textContent).toBe('150 open Inbox items');
    expect(big.querySelector('.font-bold')).not.toBeNull();
    const one = must(view.container.querySelector('[data-session-row="one"]'), 'the single-item card');
    expect(one.querySelector('.sr-only')?.textContent).toBe('1 open Inbox item');
    const calm = must(view.container.querySelector('[data-session-row="calm"]'), 'the calm card');
    expect(calm.hasAttribute('data-session-unread')).toBe(false);
    expect(calm.querySelector('[data-unread-badge]')).toBeNull();
  });

  test('has no Needs you group when nothing has open Attention', async () => {
    view = await mount(withGroups([group('ferretry', [row('calm')])]).element);
    expect(view.container.querySelector('[data-needs-you-group]')).toBeNull();
  });

  test('the table views carry the same count and link', async () => {
    for (const density of ['compact', 'full'] as const) {
      view = await mount(
        withGroups([group('ferretry', [row('loud', 1, 3, 'A6'), row('calm')])], {
          density,
          dashboardView: 'table',
          narrow: false,
          accounts: null,
        }).element,
      );
      const needs = must(view.container.querySelector('[data-needs-you-group]'), 'the Needs you group');
      const link = must(needs.querySelector('a[href*="agenda=A6"]'), `the ${density} table link`);
      expect(link.querySelector('[data-unread-badge]')?.textContent).toContain('3');
      expect(link.querySelector('.sr-only')?.textContent).toBe('3 open Inbox items');
      expect(needs.querySelector('tr[data-session-unread]')).not.toBeNull();
      await view.unmount();
      view = null;
    }
  });

  test('full-density cards lead with Attention too', async () => {
    view = await mount(
      withGroups([group('ferretry', [row('calm'), row('loud', 1, 2, 'A3')])], {
        density: 'full',
        dashboardView: 'cards',
      }).element,
    );
    const needs = must(view.container.querySelector('[data-needs-you-group]'), 'the Needs you group');
    expect(needs.querySelector('a[href*="agenda=A3"]')).not.toBeNull();
    expect(needs.querySelector('[data-unread-badge]')?.textContent).toContain('2');
  });

  test('a session that is only parked stays in its folder with no count', async () => {
    const parked = sessionView('parked', {
      config: { teammate: 'parked', cwd: '/work/ferretry' },
      state: { status: 'awaiting_user' },
    });
    view = await mount(withGroups([group('ferretry', [parked])]).element);
    expect(view.container.querySelector('[data-needs-you-group]')).toBeNull();
    expect(view.container.querySelector('[data-unread-badge]')).toBeNull();
  });
});

describe('the sessions page across every machine', () => {
  const source = (daemonId: DaemonId, name: string, sessions: SessionView[]): MachineSource => ({
    daemonId,
    name,
    reach: 'online',
    projects: [{ name: 'ferretry', path: '/work/ferretry' }],
    slice: { sessions, byId: new Map(), status: 'ready', error: null, readAt: NOW },
  });

  test('Needs you leads with the Attention sessions of every machine, newest first, each opening at its item', async () => {
    const laptop = 'laptop' as DaemonId;
    const sources = [
      source(studio.daemonId, 'studio', [row('older', 30, 1, 'A2'), row('calm')]),
      source(laptop, 'laptop', [row('newer', 1, 4, 'A8')]),
    ];
    view = await mount(dashboard({ allMachines: allMachinesView(sources) }).element);
    const needs = must(view.container.querySelector('[data-needs-you-group]'), 'the Needs you group');
    expect(rowIds(needs, 'data-session-row')).toEqual(['newer', 'older']);
    const newer = must(needs.querySelector('[data-session-row="newer"]'), 'the newer row');
    expect(newer.getAttribute('href')).toBe('/d/laptop/session/newer?agenda=A8');
    expect(newer.querySelector('[data-unread-badge]')?.textContent).toContain('4');
    expect(newer.textContent).toContain('laptop');
  });
});
