/**
 * The browser entry for the Inbox once a card's ask is an agenda item: the REAL `AgendaInboxPage` over one open question
 * and one snoozed one. There is no To test list any more (a card waiting for a try is an agenda item like any other), so
 * the page draws no To test section and no snoozed to-test row, and "Answer quickly" counts the question alone.
 *
 *   ?theme=<family>-<mode>
 *
 * A viewport under 768px draws the phone's page, as the shell does.
 */

import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import { inboxParked } from '../../../../app/lib/agenda-inbox.ts';
import { daemonId } from '../../../../app/shell.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../../support/app/sessions.ts';
import { laptop } from '../../../unit/app/board-support.ts';

document.documentElement.dataset.theme = new URLSearchParams(window.location.search).get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const phone = window.innerWidth < 768;
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const view = sessionView('fr', { config: { name: 'Release cut', teammate: 'johnnie' } as never });
const question = agendaItem('A12', {
  subject: 'Which relay region should the hosted default use?',
  why: 'The directory advertises one region per release.',
  waitingSince: ago(40),
  ask: choices('Frankfurt', 'Singapore'),
});
const snoozed = agendaItem('A13', {
  subject: 'Offline banner wording',
  ask: choices('Keep', 'Change'),
  parked: { reason: 'snoozed', at: ago(30), until: new Date(NOW + 5 * 3_600_000).toISOString() },
} as never);

const fake = fakeInbox();
const sources = [{ daemonId: daemonId(laptop.daemonId), name: 'Laptop', sessions: [view] }];

function Scene() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <InboxHarness
        cards={[inboxCard(question, view)]}
        fake={fake}
        parked={inboxParked(sources, () => ({ items: [snoozed] }) as never)}
        render={inbox => (
          <AgendaInboxPage clock={fake.clock.now} inbox={inbox} now={NOW} onNavigate={() => undefined} phone={phone} />
        )}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
