/**
 * The browser entry for "a gate item swipes as the protocol lays it out": the REAL `AgendaInboxPage` over one gate item
 * built with the protocol's own `gateAnswers` / `gateAskOptions`, so ← is Not good and → is Done.
 *
 *   ?theme=<family>-<mode>
 */

import { gateAnswers, gateAskOptions, type AgendaGate } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import { agendaItem, fakeInbox, InboxHarness, inboxCard } from '../../support/agenda-inbox.tsx';
import { sessionView } from '../../support/sessions.ts';
import { PROJECT } from '../../unit/board-support.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const phone = window.innerWidth < 768;

const gate: AgendaGate = {
  cardId: 'F9',
  laneId: 'tested',
  laneName: 'Try it',
  entry: 1,
  projectId: PROJECT,
  projectName: 'Ferretry',
  options: [
    { id: 'o0', label: 'Done', outcome: 'close' },
    { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
};

const item = agendaItem('G1', {
  subject: 'Pairing QR is ready to test',
  why: 'F9 reached Try it.',
  raisedBy: 'daemon',
  raisedBySession: null,
  raisedByName: null,
  kind: 'choice',
  ask: { kind: 'multiple-choice', options: gateAskOptions(gate) },
  answers: gateAnswers(gate),
  gate,
} as never);

const fake = fakeInbox();
const card = inboxCard(item, sessionView('sess-1', { config: { teammate: 'vena', name: 'Pairing QR' } }));

function Scene() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <InboxHarness
        cards={[card]}
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
