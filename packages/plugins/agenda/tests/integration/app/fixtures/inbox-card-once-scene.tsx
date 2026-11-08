/** The Inbox lists parked card asks once, through the unified agenda. */

import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import { inboxParked } from '../../../../app/lib/agenda-inbox.ts';
import { daemonId } from '../../../../app/shell.ts';
import { agendaItem, choices, fakeInbox, InboxHarness } from '../../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../../support/app/sessions.ts';
import { laptop } from '../../../unit/app/board-support.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

/** A board project's id; the gate item only names it. */
const PROJECT = '00000000-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const UNTIL = '2026-08-02T09:00:00.000Z';
const phone = window.innerWidth < 768;
const fake = fakeInbox();
const machine = daemonId(laptop.daemonId);

const view = sessionView('sess-1', { config: { teammate: 'vena', name: 'Gate duty' } });
const gateItem = agendaItem('A1', {
  subject: 'Duplicate gate items on reassign',
  raisedBy: 'daemon',
  raisedBySession: null,
  kind: 'choice',
  ask: choices('Done', 'Not good'),
  parked: { reason: 'snoozed', at: '2026-08-01T10:00:00.000Z', until: UNTIL },
  gate: {
    cardId: 'F9',
    laneId: 'tested',
    laneName: 'Try it',
    entry: 1,
    projectId: PROJECT,
    options: [
      { id: 'o0', label: 'Done', outcome: 'close' },
      { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
    ],
  },
} as never);
const note = agendaItem('A2', {
  subject: 'Share links over the relay',
  ask: choices('Ship', 'Hold'),
  parked: { reason: 'snoozed', at: '2026-08-01T10:30:00.000Z', until: UNTIL },
} as never);

{
  const sources = [{ daemonId: machine, name: 'Fake machine', sessions: [view] }];
  const boardFor = () => ({ items: [gateItem, note] }) as never;
  const root = document.getElementById('root');
  if (root !== null)
    createRoot(root).render(
      <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
        <InboxHarness
          cards={[]}
          fake={fake}
          parked={inboxParked(sources, boardFor)}
          render={inbox => (
            <AgendaInboxPage
              clock={fake.clock.now}
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
}
