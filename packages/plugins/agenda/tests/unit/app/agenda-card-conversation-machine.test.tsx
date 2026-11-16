/**
 * THE OPEN CARD'S CONVERSATION IS ITS OWN MACHINE'S, on both pages that open a card (`agenda`, `agenda-ask`): the Inbox
 * lists every machine's cards, so machine B's card opened on machine A's page draws Conversation's panel (the
 * `agenda.conversation` slot) resolved for B, and a reply typed there is sent through B, never through the page's A (where
 * the ferret is missing, or is another ferret with the same id). Each assertion fails when a screen hands the slot the
 * page's daemon instead of the card's.
 */

import { afterEach, describe, expect, test } from 'bun:test';
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
  ShellContext,
} from '@ferretry/app/testing';
import type { ComponentType, ReactNode } from 'react';
import { AGENDA_CONVERSATION_SLOT } from '../../../contract/slots.ts';
import { AgendaFleet } from '../../../app/lib/agenda-fleet.ts';
import { createAgendaAskScreen } from '../../../app/views/agenda-ask-screen.tsx';
import { createAgendaScreen } from '../../../app/views/agenda-screen.tsx';
import { agendaItem, choices } from '../../support/app/agenda-inbox.tsx';

ensureDom();

const A = `fy_daemon_${'a'.repeat(43)}`;
const B = `fy_daemon_${'b'.repeat(43)}`;
const FERRET = 'session-1';
const at = '2026-08-01T11:00:00.000Z';

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

/** One machine holding a ferret (the SAME id on both machines) with one open ask. */
const machine = (daemon: string, subject: string) => {
  const item = agendaItem('A2', { subject, ask: choices('Ship', 'Hold') });
  const board = { v: 1, sessionId: FERRET, items: [item], resolved: [], count: 1, parseErrors: 0, updatedAt: at };
  const client = {
    call: async (route: string) => {
      if (route === 'GET /v1/ferrets') return [{ id: FERRET, name: FERRET }];
      if (route === 'GET /v1/ferrets/:ferretId/agenda') return board;
      if (route === 'GET /v1/agenda/open') return { sessions: [{ sessionId: FERRET, items: [item] }] };
      if (route === 'GET /v1/machine/agenda') return { ...board, sessionId: 'machine-agenda', items: [] };
      if (route === 'GET /v1/ferrets/:ferretId/messages')
        return { v: 1, ferret: FERRET, nextCursor: null, previousCursor: null, messages: [] };
      if (route === 'GET /v1/ferrets/:ferretId/sends') return { sends: [] };
      throw new Error(`unexpected fixture route ${route}`);
    },
    subscribe: () => () => undefined,
  };
  noteClientDaemon(client, daemon);
  return client;
};

/**
 * A shell that places one panel in the conversation slot and answers each panel by the DAEMON it was asked for: the
 * panel's Send records that daemon, so what a reply would have been sent through is what the test reads.
 */
function ConversationShell({
  resolved,
  sent,
  children,
}: {
  readonly resolved: string[];
  readonly sent: string[];
  readonly children: ReactNode;
}) {
  const shell = {
    runtime: {
      appHook: () => undefined,
      subscribe: () => () => undefined,
      version: () => 0,
      titleOf: (plugin: string) => plugin,
      blockedLine: () => undefined,
      reach: () => ({}),
      place: () => null,
      half: (daemon: string) => {
        resolved.push(daemon);
        return {
          kind: 'ready',
          panels: {
            conversation: (props: Record<string, unknown>) => (
              <button
                data-composer-send={daemon}
                onClick={() => sent.push(`${daemon}:${String(props['ferret'])}`)}
                type="button"
              >
                Send
              </button>
            ),
          },
        };
      },
    },
    plan: {
      panels: (slot: string) =>
        slot === AGENDA_CONVERSATION_SLOT ? [{ plugin: 'conversation', id: 'conversation', slot, order: 0 }] : [],
    },
    views: { screens: new Map() },
    routes: {
      href: () => {
        throw new Error('no screen');
      },
    },
  } as never;
  return <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>;
}

const SCREENS = {
  agenda: (runtime: never, fleet: AgendaFleet) => createAgendaScreen(runtime, fleet),
  'agenda-ask': (runtime: never, fleet: AgendaFleet) => createAgendaAskScreen(runtime, fleet),
} as const;

for (const surface of ['agenda', 'agenda-ask'] as const) {
  describe(`the ${surface} page, opening a card of another machine`, () => {
    test('draws machine B’s conversation for B’s card and sends the reply through B', async () => {
      const a = machine(A, 'Laptop item');
      const b = machine(B, 'Server item');
      const fleet = new AgendaFleet();
      const onA = fleet.runtimeOf(a as never);
      const onB = fleet.runtimeOf(b as never);
      runtimes.push(onA, onB);
      const harness = deviceViewHarness({ plugin: 'agenda', fragments: [] });
      harness.setRows([
        fakeReachRow({ daemon: A, client: a as never }),
        fakeReachRow({ daemon: B, client: b as never }),
      ]);
      const resolved: string[] = [];
      const sent: string[] = [];
      const Screen = SCREENS[surface](onA as never, fleet) as ComponentType<{ params: Record<string, string> }>;
      window.innerWidth = 400;
      mounted = await mount(
        <harness.Harness place="daemon">
          <ConversationShell resolved={resolved} sent={sent}>
            <RouterProvider>
              <Screen params={{}} />
            </RouterProvider>
          </ConversationShell>
        </harness.Harness>,
      );
      const root = mounted.container;
      await settleUntil(() => root.textContent?.includes('Server item') === true, 'the Server item card', interact);
      const row = [...root.querySelectorAll<HTMLElement>('[data-agenda-row]')].find(node =>
        node.textContent?.includes('Server item'),
      );
      expect(row).toBeDefined();
      await interact(() => row?.click());
      await settleUntil(
        () => root.querySelector('[data-composer-send]') !== null,
        () => `the conversation panel did not draw; drew: ${root.textContent ?? ''}`,
        interact,
      );

      expect(resolved).toContain(B);
      expect(resolved).not.toContain(A);
      await interact(() => root.querySelector<HTMLButtonElement>('[data-composer-send]')?.click());
      expect(sent).toEqual([`${B}:${FERRET}`]);
    });
  });
}
