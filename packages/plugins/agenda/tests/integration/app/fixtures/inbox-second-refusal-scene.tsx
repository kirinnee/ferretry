/**
 * The Inbox deck on the first item the reader opens, an item whose last answer the machine refused. The REAL
 * `AgendaInboxPage` over a fake daemon. The reader taps the real Retry; `window.secondRefusal.readBoardAgain()` plays
 * "the machine took the retry, the board was read again, and the item is open again with a NEW reason".
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import type { InboxCard } from '../../../../app/lib/agenda-inbox.ts';
import { daemonId } from '../../../../app/shell.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../../support/app/sessions.ts';

declare global {
  interface Window {
    secondRefusal: { readonly readBoardAgain: () => Promise<void> };
  }
}

document.documentElement.dataset.theme = new URLSearchParams(window.location.search).get('theme') ?? 'studio-light';
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const phone = window.innerWidth < 768;
const fake = fakeInbox();

const next = inboxCard(agendaItem('A3', { subject: 'Rebase onto main?', ask: choices('Rebase now', 'Wait', 'Skip') }));
const refused = (reason: string, at: string): InboxCard => {
  const card = inboxCard(
    agendaItem('A2', { subject: 'Ship it?', ask: choices('Ship', 'Hold'), waitingSince: '2026-08-01T10:00:00.000Z' }),
    sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } }),
    'Laptop',
    daemonId('laptop'),
  );
  return {
    ...card,
    item: { ...card.item, undelivered: { at, reply: { action: 'dismiss' }, reason } } as InboxCard['item'],
  };
};
const first = refused('The machine is offline.', '2026-08-01T11:30:00.000Z');
const second = refused('The machine said no again.', '2026-08-01T11:45:00.000Z');

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1) await new Promise<void>(done => setTimeout(done, 0));
};

function Scene() {
  const [board, setBoard] = useState<readonly InboxCard[]>([next, first]);
  window.secondRefusal = {
    readBoardAgain: async () => {
      fake.clock.advance(10_000);
      await settle();
      setBoard([next, second]);
      await settle();
    },
  };
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', padding: '0 16px' }}>
      <InboxHarness
        cards={board}
        fake={fake}
        render={inbox => (
          <AgendaInboxPage
            clock={fake.clock.now}
            initialOpen={first.key}
            inbox={inbox}
            now={NOW}
            onNavigate={() => undefined}
            phone={phone}
            reducedMotion
          />
        )}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
