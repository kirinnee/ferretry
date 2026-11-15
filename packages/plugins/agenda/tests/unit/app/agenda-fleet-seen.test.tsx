/**
 * Opening a card of ANOTHER machine from the fleet Inbox, on both pages that open one (`agenda`, `agenda-ask`): the
 * machine that is told, and marks the ask seen, is the opened card's, never the page's. Two machines hold the same
 * ask id (`machine-agenda/A2`); opening B's must reach B's provider (closing B's line) and B's client, and leave A's
 * own notification and A's seen mark alone.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import {
  deviceViewHarness,
  ensureDom,
  fakeReachRow,
  interact,
  type Mounted,
  mount,
  noteClientDaemon,
  RouterProvider,
  settleUntil,
  WithAppHooks,
} from '@ferretry/app/testing';
import type { ComponentType } from 'react';
import { AGENDA_ITEM_OPENED_HOOK, type AgendaSeenMark } from '../../../contract/app-hooks.ts';
import { AgendaFleet } from '../../../app/lib/agenda-fleet.ts';
import { createAgendaAskScreen } from '../../../app/views/agenda-ask-screen.tsx';
import { createAgendaScreen } from '../../../app/views/agenda-screen.tsx';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';

ensureDom();

const A = `fy_daemon_${'a'.repeat(43)}`;
const B = `fy_daemon_${'b'.repeat(43)}`;

let mounted: Mounted | undefined;
const runtimes: Array<{ ferrets: { stop(): void } }> = [];
const width = window.innerWidth;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  for (const runtime of runtimes.splice(0)) runtime.ferrets.stop();
  window.innerWidth = width;
  window.history.replaceState({}, '', '/');
});

/** One machine: its client (what it is posted), and its provider (whose notification line it closes). */
const machine = (daemon: string, subject: string) => {
  const seen: unknown[] = [];
  const closed: string[] = [];
  const client = {
    call: async (route: string, init?: { body?: unknown }) => {
      if (route === 'GET /v1/ferrets') return [];
      if (route === 'GET /v1/machine/agenda')
        return {
          v: 1,
          sessionId: MACHINE_AGENDA_ID,
          items: [agendaItem('A2', { subject })],
          resolved: [],
          count: 1,
          parseErrors: 0,
          updatedAt: '2026-08-01T11:00:00.000Z',
        };
      if (route === 'POST /v1/push/seen') {
        seen.push(init?.body);
        return { cleared: true, tags: [] };
      }
      throw new Error(`unexpected fixture route ${route}`);
    },
    subscribe: () => () => undefined,
  };
  noteClientDaemon(client, daemon);
  // What Access's provider does on this machine: close this machine's own line, then make the machine's seen mark.
  const hook = async (ferret: string, ask: string, mark: AgendaSeenMark) => {
    closed.push(`${daemon}:${ferret}/${ask}`);
    await mark();
  };
  return { client, seen, closed, hook };
};

const SCREENS = {
  agenda: (runtime: never, fleet: AgendaFleet) => createAgendaScreen(runtime, fleet),
  'agenda-ask': (runtime: never, fleet: AgendaFleet) => createAgendaAskScreen(runtime, fleet),
} as const;

for (const surface of ['agenda', 'agenda-ask'] as const) {
  describe(`the ${surface} page, opening a card of another machine`, () => {
    const openOn = async (page: 'A' | 'B', subject: string) => {
      const a = machine(A, 'Laptop item');
      const b = machine(B, 'Server item');
      const fleet = new AgendaFleet();
      const onA = fleet.runtimeOf(a.client as never);
      const onB = fleet.runtimeOf(b.client as never);
      runtimes.push(onA, onB);
      const harness = deviceViewHarness({ plugin: 'agenda', fragments: [] });
      harness.setRows([
        fakeReachRow({ daemon: A, client: a.client as never }),
        fakeReachRow({ daemon: B, client: b.client as never }),
      ]);
      const Screen = SCREENS[surface](page === 'A' ? (onA as never) : (onB as never), fleet) as ComponentType<{
        params: Record<string, string>;
      }>;
      window.innerWidth = 400;
      mounted = await mount(
        <harness.Harness place="daemon">
          <WithAppHooks
            provided={{}}
            onDaemon={{ [A]: { [AGENDA_ITEM_OPENED_HOOK]: a.hook }, [B]: { [AGENDA_ITEM_OPENED_HOOK]: b.hook } }}
          >
            <RouterProvider>
              <Screen params={{}} />
            </RouterProvider>
          </WithAppHooks>
        </harness.Harness>,
      );
      const root = mounted.container;
      await settleUntil(() => root.textContent?.includes(subject) === true, `the ${subject} card`, interact);
      const row = [...root.querySelectorAll<HTMLElement>('[data-agenda-row]')].find(node =>
        node.textContent?.includes(subject),
      );
      expect(row).toBeDefined();
      await interact(() => row?.click());
      await interact(() => new Promise(resolve => setTimeout(resolve, 20)));
      return { a, b };
    };

    test('marks machine B’s card seen on B and closes B’s line, leaving A’s notification alone', async () => {
      const { a, b } = await openOn('A', 'Server item');
      expect(b.seen).toEqual([{ sessionId: MACHINE_AGENDA_ID, agendaId: 'A2' }]);
      expect(b.closed).toEqual([`${B}:${MACHINE_AGENDA_ID}/A2`]);
      expect(a.seen).toEqual([]);
      expect(a.closed).toEqual([]);
    });

    test('marks machine A’s card, with the same ask id, seen on A only', async () => {
      const { a, b } = await openOn('B', 'Laptop item');
      expect(a.seen).toEqual([{ sessionId: MACHINE_AGENDA_ID, agendaId: 'A2' }]);
      expect(a.closed).toEqual([`${A}:${MACHINE_AGENDA_ID}/A2`]);
      expect(b.seen).toEqual([]);
      expect(b.closed).toEqual([]);
    });
  });
}
