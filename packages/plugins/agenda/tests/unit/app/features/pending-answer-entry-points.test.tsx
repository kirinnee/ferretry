/**
 * AN ANSWER GIVEN IN THE REAL INBOX IS SAID IN THE ITEM'S CONVERSATION AT ONCE, where the owner reads it: the chat's item
 * view (the chat line mounts no Inbox at all) and the Inbox's own page, both over the SAME receipts. Nothing here is a scene
 * of buttons: the answer is given on the real `AgendaInboxPage`, and the conversation is the real `useAgenda` item view.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { type AgendaId, agendaListSnapshot, type AgendaSnapshot } from '@ferretry/core-asks/contract';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import { type AgendaActionClient, useAgenda } from '../../../../app/features/agenda/agenda.tsx';
import type { AgendaCall } from '../../../../app/lib/agenda-call.ts';
import { AgendaClientContext } from '../../../../app/lib/agenda-client-context.tsx';
import { answerReceipts } from '../../../../app/lib/answer-receipts.ts';
import { daemonConnection, daemonId, daemonSessionScope } from '../../../../app/shell.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { openConversation } from '../../../support/app/agenda-folds.ts';
import { sessionView } from '../../../support/app/sessions.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const connection = daemonConnection({ daemonId: 'laptop' });
const shipIt = inboxCard(
  agendaItem('A2', { subject: 'Ship it?', ask: choices('Ship', 'Hold'), waitingSince: '2026-08-01T10:00:00.000Z' }),
  sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } as never }),
  'Laptop',
  daemonId('laptop'),
);

const noMachine: AgendaCall = { call: async () => Promise.reject(new Error('no machine in this test')) } as never;
const noActions = {} as AgendaActionClient;

/** The chat's item view for the item, as the chat line builds it: no Inbox provider anywhere above it. */
function Chat() {
  const snapshot = {
    v: 1,
    sessionId: 'sess-2',
    items: [shipIt.item],
    resolved: [],
    count: 1,
    parseErrors: 0,
    updatedAt: '2026-08-01T11:00:00.000Z',
  } as unknown as AgendaSnapshot;
  const agenda = useAgenda({
    agendaMode: true,
    client: noActions,
    connection,
    ferret: 'Kai',
    focus: { target: 'A2' as AgendaId, seq: 1 },
    scope: daemonSessionScope(connection, 'sess-2'),
    snapshot: agendaListSnapshot(snapshot),
    status: 'ready',
    swipeable: false,
  });
  return (
    <AgendaClientContext.Provider value={noMachine}>
      <div className="fy-chat-log">{agenda.scrim}</div>
      {agenda.view}
    </AgendaClientContext.Provider>
  );
}

const views: Mounted[] = [];
const show = async (node: Parameters<typeof mount>[0]): Promise<Mounted> => {
  const view = await mount(node);
  views.push(view);
  return view;
};
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
  answerReceipts.update(() => ({ pending: [], sending: [], failed: [] }));
});

/** What the item's conversation says the owner said, and the receipt drawn with it. */
const owned = (view: Mounted): string[] =>
  [...view.container.querySelectorAll('[data-agenda-history] [data-history="owner"]')].map(
    row =>
      `${row.querySelector('.fy-hist__said')?.textContent ?? ''}|${row.querySelector('[data-send-receipt]')?.getAttribute('data-send-receipt') ?? ''}`,
  );

describe('an answer given in the real Inbox, read in the item’s conversation in the chat', () => {
  it('is there at once, leaves with Undo, stays while it is sent, and says Not sent when the machine refuses it', async () => {
    const fake = fakeInbox(answerReceipts);
    fake.holdCommits = true;
    const inbox = await show(
      <InboxHarness
        cards={[shipIt]}
        fake={fake}
        render={inboxModel => (
          <AgendaInboxPage
            clock={fake.clock.now}
            inbox={inboxModel}
            initialOpen={shipIt.key}
            now={NOW}
            onNavigate={() => undefined}
            phone
            reducedMotion
          />
        )}
      />,
    );
    const chat = await show(<Chat />);
    expect(owned(chat), 'nothing said yet').toEqual([]);

    const answer = async (label: string): Promise<void> => {
      const button = inbox.container.querySelector<HTMLButtonElement>(`[data-agenda-option="${label}"]`);
      await interact(() => must(button, `the ${label} answer`).click());
    };

    await answer('Ship');
    expect(fake.deferred.getSnapshot().pending.map(entry => entry.action.label)).toEqual(['Ship']);
    await openConversation(chat.container);
    expect(owned(chat), 'the chat says it at once').toEqual(['Ship|saved']);

    await interact(() =>
      must(inbox.container.querySelector<HTMLButtonElement>('[data-agenda-undo-button]'), 'Undo').click(),
    );
    expect(owned(chat), 'Undo takes it out of the chat').toEqual([]);

    // Undo puts the card back on the list; opening it again is how the owner answers again.
    const row = must(inbox.container.querySelector<HTMLElement>('[data-agenda-row]'), 'the row');
    await interact(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    await answer('Ship');
    expect(owned(chat)).toEqual(['Ship|saved']);
    await interact(async () => {
      fake.clock.advance(6_000);
      await Promise.resolve();
    });
    expect(fake.gates, 'the answer is on its way').toHaveLength(1);
    expect(owned(chat), 'it stays while it is being sent').toEqual(['Ship|saved']);

    await interact(async () => {
      fake.gates[0]?.reject(new Error('Offline'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(owned(chat), 'a refusal is said, not dropped').toEqual(['Ship|failed']);
    expect(chat.container.querySelector('[data-history="owner"]')?.outerHTML ?? '').toContain('Offline');
  });
});
