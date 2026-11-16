/**
 * THE INBOX HISTORY IS BOUND TO CONVERSATION'S ROWS: the `agenda` and `agenda-ask` screens, built by the half the shell
 * builds, read the chat messages that name an open ask through Conversation's `GET /v1/ferrets/:ferretId/messages`
 * route (and the send ledger beside it) and draw them as the ask's History, with the receipt of each send. Each
 * assertion fails when a screen stops handing `readConversation` to the page.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { type AgendaItem, MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import { ensureDom, interact, type Mounted, mount, RouterProvider, settleUntil } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type ComponentType, Suspense } from 'react';
import app from '../../../app/index.ts';
import manifest from '../../../manifest.ts';
import { agendaItem, choices } from '../../support/app/agenda-inbox.tsx';
import { openConversation } from '../../support/app/agenda-folds.ts';

ensureDom();

const FERRET = 'session-1';
const at = '2026-08-01T11:00:00.000Z';

/** A daemon with one ferret whose agenda holds `item` and whose conversation has two rows about it. */
const daemon = (item: AgendaItem): { readonly client: PluginClient; readonly calls: string[] } => {
  const calls: string[] = [];
  const board = { v: 1, sessionId: FERRET, items: [item], resolved: [], count: 1, parseErrors: 0, updatedAt: at };
  const client = {
    call: async (route: string, init?: { params?: { ferretId?: string } }) => {
      calls.push(`${route} ${init?.params?.ferretId ?? ''}`.trim());
      if (route === 'GET /v1/ferrets') return [{ id: FERRET, name: FERRET }];
      if (route === 'GET /v1/ferrets/:ferretId/agenda') return board;
      if (route === 'GET /v1/ferrets/:ferretId/messages')
        return {
          v: 1,
          ferret: FERRET,
          nextCursor: null,
          previousCursor: null,
          messages: [
            { point: 'p1', role: 'user', text: '^A2 is staging green?', timestamp: at, selectionBinding: 'b1' },
            { point: 'p2', role: 'assistant', text: 'On ^A2: yes, all green.', timestamp: at, selectionBinding: 'b2' },
          ],
        };
      if (route === 'GET /v1/ferrets/:ferretId/sends')
        return {
          sends: [
            {
              v: 1,
              sendId: 's1',
              acceptedAt: at,
              acceptedTurn: 1,
              path: 'direct',
              message: '^A2 is staging green?',
              attachmentIds: [],
              fate: 'delivered',
            },
          ],
        };
      if (route === 'GET /v1/agenda/open') return { sessions: [{ sessionId: FERRET, items: [item] }] };
      if (route === 'GET /v1/machine/agenda') return { ...board, sessionId: MACHINE_AGENDA_ID, items: [] };
      throw new Error(`no route ${route}`);
    },
    subscribe: () => () => undefined,
  } as unknown as PluginClient;
  return { client, calls };
};

const WIDTH = window.innerWidth;
let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  window.innerWidth = WIDTH;
  window.history.replaceState({}, '', '/');
});

for (const surface of ['agenda', 'agenda-ask'] as const) {
  describe(`the ${surface} screen`, () => {
    test('draws the chat rows that name the open ask as its History, with the receipt of the send', async () => {
      const item = agendaItem('A2', { subject: 'Is staging green?', ask: choices('Yes', 'No') } as Partial<AgendaItem>);
      const { client, calls } = daemon(item);
      window.innerWidth = 400;
      const half = app.build?.({ manifest, client });
      const Screen = half?.screens[surface] as unknown as ComponentType<Record<string, unknown>>;
      view = await mount(
        <RouterProvider>
          <Suspense fallback={null}>
            <Screen params={surface === 'agenda-ask' ? { ferret: FERRET, ask: 'A2' } : {}} />
          </Suspense>
        </RouterProvider>,
      );
      const root = view.container;
      await settleUntil(
        () =>
          root.querySelector('[data-agenda-row]') !== null || root.querySelector('[data-agenda-inbox="card"]') !== null,
        () => `the ask did not draw; drew: ${root.textContent ?? ''}`,
        interact,
      );
      await interact(() => root.querySelector<HTMLElement>('[data-agenda-row]')?.click());
      await settleUntil(
        () => calls.some(call => call.startsWith('GET /v1/ferrets/:ferretId/messages')),
        () => `the conversation was never read; calls: ${calls.join(', ')}`,
        interact,
      );
      await interact(() => new Promise(resolve => setTimeout(resolve, 20)));
      await openConversation(root);
      const history = root.querySelector('[data-agenda-history]');
      expect(history?.textContent).toContain('is staging green?');
      expect(history?.textContent).toContain('yes, all green.');
      expect(history?.querySelector('[data-send-receipt]')?.getAttribute('data-send-receipt')).toBe('answered');
      expect(calls).toContain(`GET /v1/ferrets/:ferretId/messages ${FERRET}`);
      expect(calls).toContain(`GET /v1/ferrets/:ferretId/sends ${FERRET}`);
    });
  });
}
