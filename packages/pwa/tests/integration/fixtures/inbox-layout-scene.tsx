/**
 * The browser entry for "the Inbox list lines up": the REAL `AgendaInboxPage` over a fake inbox that spans two
 * machines, three ferrets and all three sections, so the toolbar draws every control it can.
 *
 *   ?theme=<family>-<mode>
 *
 * A viewport under 768px draws the phone's page, as the shell does.
 */

import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../support/agenda-inbox.tsx';
import { sessionView } from '../../support/sessions.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const phone = window.innerWidth < 768;

const stopped = inboxCard(
  agendaItem('S1', { subject: 'Pick a database for the ledger', ask: choices('Postgres', 'SQLite') }),
  sessionView('sess-6', {
    config: { teammate: 'piper', name: 'Ledger rewrite' },
    state: { attention: { open: 1, first: 'S1', ask: 'Pick', latestAt: '2026-08-01T11:00:00.000Z', stopped: true } },
  } as never),
);
const needsYou = [
  inboxCard(
    agendaItem('A1', { subject: 'Which day works for the cut-over?', ask: choices('Mon', 'Tue', 'Wed') }),
    sessionView('sess-1', { config: { teammate: 'durian', name: 'Liftoff EC2' } }),
    'Liftoff EC2',
    daemonId('ec2'),
  ),
  inboxCard(
    agendaItem('A2', { subject: 'Spend limit: pause, switch or warn?', ask: choices('Pause', 'Switch', 'Warn') }),
    sessionView('sess-1', { config: { teammate: 'durian', name: 'Liftoff EC2' } }),
    'Liftoff EC2',
    daemonId('ec2'),
  ),
  inboxCard(
    agendaItem('A3', { subject: 'Ship the relay fix today?', ask: choices('Ship', 'Hold') }),
    sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } }),
  ),
];
const withFerret = inboxCard(
  agendaItem('F1', { subject: 'Draft the plan', waitingOn: 'ferret', waitingFor: 'info' } as never),
  sessionView('sess-7', { config: { teammate: 'hadi', name: 'Docs sweep' } }),
);

const fake = fakeInbox();

function Scene() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <InboxHarness
        cards={[stopped, ...needsYou, withFerret]}
        fake={fake}
        render={inbox => (
          <AgendaInboxPage clock={fake.clock.now} inbox={inbox} now={NOW} onNavigate={() => undefined} phone={phone} />
        )}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
