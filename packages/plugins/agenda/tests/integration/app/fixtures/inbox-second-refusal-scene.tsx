/**
 * The Inbox deck on the SECOND item, while the first item's answer is refused twice (the reader retried it). The REAL
 * `AgendaInboxPage` over a fake daemon; `window.scene.refuseTwice()` plays "answer, refused, retry, refused again".
 */
import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import { daemonId } from '../../../../app/shell.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../../support/app/sessions.ts';

declare global {
  interface Window {
    secondRefusal: { readonly refuseTwice: () => Promise<void> };
  }
}

document.documentElement.dataset.theme = new URLSearchParams(window.location.search).get('theme') ?? 'studio-light';
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const phone = window.innerWidth < 768;
const fake = fakeInbox();

const first = inboxCard(agendaItem('A3', { subject: 'Rebase onto main?', ask: choices('Rebase now', 'Wait', 'Skip') }));
const second = inboxCard(
  agendaItem('A2', { subject: 'Ship it?', ask: choices('Ship', 'Hold'), waitingSince: '2026-08-01T10:00:00.000Z' }),
  sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } }),
  'Laptop',
  daemonId('laptop'),
);

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1) await new Promise<void>(done => setTimeout(done, 0));
};
window.secondRefusal = {
  refuseTwice: async () => {
    const answer = { kind: 'dismiss', label: 'Dismiss' } as never;
    for (const reason of ['The machine is offline.', 'The machine said no again.']) {
      fake.failNext = reason;
      fake.deferred.schedule(first, answer);
      fake.clock.advance(10_000);
      await settle();
    }
  },
};

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', padding: '0 16px' }}>
      <InboxHarness
        cards={[first, second]}
        fake={fake}
        render={inbox => (
          <AgendaInboxPage
            clock={fake.clock.now}
            initialOpen={second.key}
            inbox={inbox}
            now={NOW}
            onNavigate={() => undefined}
            phone={phone}
            reducedMotion
          />
        )}
      />
    </div>,
  );
