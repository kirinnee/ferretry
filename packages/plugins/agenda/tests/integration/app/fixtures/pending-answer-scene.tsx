/**
 * The browser entry for "an answer shows at once in the item's conversation": the REAL `AgendaInboxPage` (over the Inbox's
 * real `DeferredAgendaActions`, on the app's own `answerReceipts`) and the REAL chat item view (`useAgenda`, with no Inbox
 * provider above it, as the chat line has none). The owner answers on the Inbox's own answer chips and Undo toast; the
 * scene adds only what is outside the product — the route (`#inbox` / `#chat`: leaving the Inbox flushes what it holds,
 * as the Inbox's unmount does) and the machine (`window.scene`: time passing, the machine refusing). Fake data only.
 *
 *   ?theme=<family>-<mode>
 */

import { agendaListSnapshot, type AgendaId, type AgendaSnapshot } from '@ferretry/core-asks/contract';
import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import { type AgendaActionClient, useAgenda } from '../../../../app/features/agenda/agenda.tsx';
import type { AgendaCall } from '../../../../app/lib/agenda-call.ts';
import { AgendaClientContext } from '../../../../app/lib/agenda-client-context.tsx';
import { answerReceipts } from '../../../../app/lib/answer-receipts.ts';
import { daemonConnection, daemonId, daemonSessionScope } from '../../../../app/shell.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../../support/app/sessions.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.now();
const phone = window.innerWidth < 768;
const connection = daemonConnection({ daemonId: 'workshop' });
const item = agendaItem('A47', {
  title: 'Ship the relay fix',
  subject: 'Ship the relay fix today?',
  premise: '- The fix passed review',
  waitingSince: new Date(NOW - 3_600_000).toISOString(),
  ask: choices('Ship', 'Hold'),
});
const card = inboxCard(
  item,
  sessionView('sess-1', { config: { teammate: 'zoe', name: 'Relay fix' } as never }),
  'Workshop',
  daemonId('workshop'),
);

const fake = fakeInbox(answerReceipts);
fake.holdCommits = true;

declare global {
  interface Window {
    scene: { readonly advance: (ms: number) => void; readonly refuse: (reason: string) => void };
  }
}
window.scene = {
  advance: ms => fake.clock.advance(ms),
  refuse: reason => fake.gates.shift()?.reject(new Error(reason)),
};

const route = (): 'inbox' | 'chat' => (window.location.hash === '#chat' ? 'chat' : 'inbox');
const subscribe = (listener: () => void): (() => void) => {
  const changed = (): void => {
    // Leaving the Inbox sends what it holds (its unmount's flush); the receipts outlive it.
    if (route() === 'chat') fake.deferred.flush();
    listener();
  };
  window.addEventListener('hashchange', changed);
  return () => window.removeEventListener('hashchange', changed);
};

const noMachine = { call: async () => Promise.reject(new Error('no machine in this scene')) } as unknown as AgendaCall;

function Chat() {
  const snapshot = {
    v: 1,
    sessionId: 'sess-1',
    items: [item],
    resolved: [],
    count: 1,
    parseErrors: 0,
    updatedAt: new Date(NOW).toISOString(),
  } as unknown as AgendaSnapshot;
  const agenda = useAgenda({
    agendaMode: true,
    client: {} as AgendaActionClient,
    connection,
    ferret: 'Zoe',
    focus: { target: 'A47' as AgendaId, seq: 1 },
    now: NOW,
    scope: daemonSessionScope(connection, 'sess-1'),
    snapshot: agendaListSnapshot(snapshot),
    status: 'ready',
    swipeable: false,
  });
  return (
    <AgendaClientContext.Provider value={noMachine}>
      {/* The chat's own stage: the item view lays over the message list in one grid cell. */}
      <div data-scene-chat="" style={{ display: 'grid', flex: '1 1 0', minHeight: 0 }}>
        <div className="fy-chat-log" style={{ gridArea: '1 / 1' }}>
          {agenda.scrim}
        </div>
        {agenda.view}
      </div>
    </AgendaClientContext.Provider>
  );
}

function Scene() {
  const shown = useSyncExternalStore(subscribe, route);
  return (
    <div
      className={shown === 'chat' ? 'kt-chat-surface scene-chat' : undefined}
      style={shown === 'chat' ? undefined : { position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}
    >
      {shown === 'chat' ? (
        <Chat />
      ) : (
        <InboxHarness
          cards={[card]}
          fake={fake}
          render={inbox => (
            <AgendaInboxPage
              clock={fake.clock.now}
              inbox={inbox}
              initialOpen={card.key}
              now={NOW}
              onNavigate={() => undefined}
              phone={phone}
              reducedMotion
            />
          )}
        />
      )}
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
