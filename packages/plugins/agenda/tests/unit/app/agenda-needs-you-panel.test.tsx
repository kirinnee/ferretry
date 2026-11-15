/**
 * THE NEEDS YOU PANEL (`navPanels['needs-you']`, S4): the ferrets that wait on the owner, drawn once under the nav
 * entries from every machine the plugin may run on, and a locked machine left unread. A row is only a way in: it opens
 * the ask page at the ferret's first open item.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import {
  deviceViewHarness,
  ensureDom,
  fakeReachRow,
  interact,
  type Mounted,
  mount,
  noteClientDaemon,
  settleUntil,
} from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ComponentType } from 'react';
import { NeedsYouRail, needsYouAcross } from '../../../app/features/agenda/agenda-nav.tsx';
import app from '../../../app/index.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../support/app/sessions.ts';

ensureDom();

const A = `fy_daemon_${'a'.repeat(43)}`;
const B = `fy_daemon_${'b'.repeat(43)}`;
const C = `fy_daemon_${'c'.repeat(43)}`;

/** One machine: its ferrets and the items each holds; every route it is asked is recorded. */
function machine(daemon: string, ferrets: Record<string, string>) {
  const calls: string[] = [];
  const client = {
    call: async (route: string) => {
      calls.push(route);
      if (route === 'GET /v1/ferrets') return Object.keys(ferrets).map(id => ({ id, name: id, teammate: id }));
      if (route === 'GET /v1/agenda/open')
        return {
          sessions: Object.entries(ferrets).map(([sessionId, ask]) => ({
            sessionId,
            items: [agendaItem('A1', { subject: ask, waitingSince: '2026-11-01T10:00:00.000Z' })],
          })),
        };
      throw new Error(`no route ${route}`);
    },
    subscribe: () => () => undefined,
  } as unknown as PluginClient;
  noteClientDaemon(client as never, daemon);
  return { client, calls };
}

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const Panel = app.shell.navPanels?.['needs-you'] as unknown as ComponentType;

describe('the Needs you panel', () => {
  it('lists the ferrets waiting on the owner on every unlocked machine, each opening its ask page', async () => {
    const a = machine(A, { khristina: 'Ship the build?' });
    const b = machine(B, { judson: 'Rotate the key?' });
    const c = machine(C, { never: 'Never read' });
    const harness = deviceViewHarness({ plugin: 'agenda', fragments: [] });
    harness.setRows([
      fakeReachRow({ daemon: A, client: a.client, machine: 'laptop' }),
      fakeReachRow({ daemon: B, client: b.client, machine: 'server' }),
      fakeReachRow({ daemon: C, client: c.client, machine: 'studio', locked: true }),
    ]);
    view = await mount(
      <harness.Harness>
        <Panel />
      </harness.Harness>,
    );
    const text = (): string => view?.container.textContent ?? '';
    await settleUntil(
      () => text().includes('Ship the build?') && text().includes('Rotate the key?'),
      () => `both machines' ferrets did not draw; drew: ${text()}`,
      interact,
    );
    expect(text()).not.toContain('Never read');
    expect(c.calls).toEqual([]);
    expect(view.container.querySelector('[data-sbar-needs-you-group] .fy-sbar__count')?.textContent).toBe('2');
    const hrefs = [...view.container.querySelectorAll('[data-sbar-needs-you]')].map(link => link.getAttribute('href'));
    expect(hrefs.toSorted()).toEqual([`/d/${A}/agenda/khristina/A1`, `/d/${B}/agenda/judson/A1`].toSorted());
    expect(text()).toContain('laptop');
    expect(text()).toContain('server');
  });

  it('draws nothing while no machine has a ferret waiting', async () => {
    const harness = deviceViewHarness({ plugin: 'agenda', fragments: [] });
    harness.setRows([fakeReachRow({ daemon: A, client: machine(A, {}).client })]);
    view = await mount(
      <harness.Harness>
        <Panel />
      </harness.Harness>,
    );
    await interact(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(view.container.querySelector('[data-sbar-needs-you-group]')).toBeNull();
    expect(MACHINE_AGENDA_ID).toBeString();
  });
});

describe('the rows across machines', () => {
  const asked = (open: number, latestAt: string) => ({ open, first: 'A1', ask: 'Pick one', latestAt });

  it('are newest asked first across machines, and name a machine only when there are several', () => {
    const old = sessionView('old', { state: { agenda: asked(1, '2026-11-01T10:00:00.000Z') } });
    const fresh = sessionView('fresh', { state: { agenda: asked(2, '2026-11-02T10:00:00.000Z') } });
    const quiet = sessionView('quiet');
    const several = needsYouAcross([
      { daemonId: 'one' as never, name: 'One', sessions: [old, quiet] },
      { daemonId: 'two' as never, name: 'Two', sessions: [fresh] },
      { daemonId: 'three' as never, name: 'Three', sessions: null },
    ]);
    expect(several.map(row => [row.view.config.id, row.machine])).toEqual([
      ['fresh', 'Two'],
      ['old', 'One'],
    ]);
    const alone = needsYouAcross([{ daemonId: 'one' as never, name: 'One', sessions: [old] }]);
    expect(alone.map(row => row.machine)).toEqual([undefined]);
  });
});

describe('the rail form', () => {
  it('draws an icon per ferret with a dot, each opening the ask page, and nothing when none waits', async () => {
    const view1 = sessionView('s-1', {
      config: { teammate: 'zoe' },
      state: { agenda: { open: 2, first: 'A4', ask: 'Ship it?', latestAt: '2026-11-01T10:00:00.000Z' } },
    });
    const noSummary = sessionView('s-2', { config: { teammate: 'kai' } });
    const visited: string[] = [];
    view = await mount(
      <NeedsYouRail
        isActive={row => row.view.config.id === 's-1'}
        onNavigate={to => visited.push(to)}
        rows={[
          { daemonId: 'alpha' as never, view: view1 },
          { daemonId: 'alpha' as never, view: noSummary },
        ]}
      />,
    );
    const links = [...view.container.querySelectorAll<HTMLAnchorElement>('[data-sbar-needs-you]')];
    expect(links.map(link => link.getAttribute('href'))).toEqual(['/d/alpha/agenda/s-1/A4', '/d/alpha/agenda']);
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
    expect(links[0]?.getAttribute('aria-label')).toBe('Zoe — 2 open Inbox items');
    expect(links[0]?.querySelector('.fy-unread-badge--dot')).not.toBeNull();
    expect(links[1]?.getAttribute('aria-label')).toBe('Kai');
    expect(links[1]?.querySelector('.fy-unread-badge--dot')).toBeNull();
    await interact(() => links[0]?.click());
    expect(visited).toEqual(['/d/alpha/agenda/s-1/A4']);
    await view.unmount();
    view = await mount(<NeedsYouRail isActive={() => false} onNavigate={() => undefined} rows={[]} />);
    expect(view.container.querySelector('[data-sbar-needs-you-rail]')).toBeNull();
  });
});
