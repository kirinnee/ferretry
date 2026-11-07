/**
 * The browser entry for "the Inbox shows the machine's own agenda": the REAL `AgendaInboxPage` over a fake inbox whose
 * first group is the Machine (two notices, no ferret, no chat) above one ordinary ferret's group.
 *
 *   ?theme=<family>-<mode>
 *   ?open=1             the reader opened the first Machine row: its detail, with what to do
 */

import type { AgendaSnapshot } from '../../../../app/wire/index.ts';
import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import { machineSessionView } from '../../../../app/lib/machine-agenda.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../../support/app/sessions.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const phone = window.innerWidth < 768;

const moved = agendaItem('M1', {
  notice: true,
  subject: '4 ferrets could not be moved',
  why: "Ferretry moves a ferret to another login when its login hits a limit. These 4 couldn't be moved.",
  context: [
    'durian (7f3a91c2): Its login hit its usage limit until 6pm. A login can take it now:',
    '$ fy migrate 7f3a91c2 -a claude-llm1',
    'kai (b04e55d8): Its login hit its usage limit until 9pm. A login can take it now:',
    '$ fy migrate b04e55d8 -a claude-atomi-long-login-name',
    'rho (c81d02aa): No other login could take it, every one is over its cap. Wait for a login to reset.',
    'piper (e29c1a60): It is mid-turn. Wait for it to finish its turn.',
  ].join('\n'),
  howToResolve: 'Run the command under a ferret to move it yourself, or wait as its line says.',
  waitingSince: '2026-08-01T10:00:00.000Z',
  sourceRef: 'warden:auto-move-failed',
} as never);
const limit = agendaItem('M2', {
  notice: true,
  subject: 'claude-liftoff hit its hard limit',
  why: 'Its weekly window is spent until Friday.',
  context: 'Spent $400.00 of the $400.00 weekly limit.',
  howToResolve: 'Raise the limit in Settings › Budgets, or wait until the window resets on Friday.',
  waitingSince: '2026-08-01T11:00:00.000Z',
  sourceRef: 'budget:claude-liftoff:weekly',
} as never);
const snapshot = {
  sessionId: 'machine-agenda',
  items: [moved, limit],
  resolved: [],
  updatedAt: '2026-08-01T11:00:00.000Z',
} as unknown as AgendaSnapshot;
const machineView = machineSessionView(snapshot);
if (machineView === undefined) throw new Error('the scene needs a machine agenda');

const ferret = inboxCard(
  agendaItem('A1', { subject: 'Ship the relay fix today?', ask: choices('Ship', 'Hold') }),
  sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } }),
);
const fake = fakeInbox();
const openFirst = params.get('open') === '1' ? inboxCard(moved, machineView).key : undefined;

function Scene() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <InboxHarness
        cards={[ferret, inboxCard(limit, machineView), inboxCard(moved, machineView)]}
        fake={fake}
        render={inbox => (
          <AgendaInboxPage
            clock={fake.clock.now}
            initialOpen={openFirst}
            inbox={inbox}
            now={NOW}
            onNavigate={() => undefined}
            phone={phone}
          />
        )}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
