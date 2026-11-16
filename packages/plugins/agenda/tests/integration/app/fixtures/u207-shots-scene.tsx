/**
 * FAKE-DATA SCENES for the u2-07 screenshots: the real `AgendaInboxPage` over a fake inbox, opened on a card.
 *   ?theme=<family>-<mode>&case=ask|quote
 * `ask`: a "Try it" card, its answer ports made by the product's own `answerFilePorts` over a scripted client.
 * `quote`: an ordinary ask whose prose can be selected for "Quote in composer".
 */

import { type AgendaGate, type AgendaItem, gateAskOptions } from '@ferretry/core-asks/contract';
import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import { answerFilePorts } from '../../../../app/lib/answer-file-ports.ts';
import type { GateItem } from '../../../../app/lib/gate-items.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../../support/app/sessions.ts';
import { daemonConnection } from '../../../../app/shell.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('case') ?? 'ask';

const laptop = daemonConnection({ daemonId: 'daemon/laptop' });
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const phone = window.innerWidth < 768;

const GATE_OPTIONS: Pick<AgendaGate, 'options'> = {
  options: [
    { id: 'o0', label: 'Done', outcome: 'close' },
    { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
};

const gateItem = (): GateItem =>
  agendaItem('G1', {
    subject: 'Try it: open the pairing page',
    why: 'The pairing page shows a QR code.',
    premise: 'The pairing page shows a QR code.',
    body: '1. Open the pairing page\n2. Scan the code',
    kind: 'choice',
    raisedBy: 'daemon',
    raisedBySession: null,
    ask: { kind: 'multiple-choice', options: gateAskOptions(GATE_OPTIONS) } as AgendaItem['ask'],
    gate: {
      cardId: 'F1',
      laneId: 'tested',
      laneName: 'Tested',
      entry: 1,
      projectId: 'p1',
      projectName: 'Example project',
      options: [...GATE_OPTIONS.options],
    },
  } as unknown as Partial<AgendaItem>) as GateItem;

const owner = sessionView('sess-g', { config: { teammate: 'judson', name: 'Pairing page' } as never });
const gate = inboxCard(gateItem(), owner);
const question = inboxCard(
  agendaItem('A7', {
    subject: 'Which database should keep the board’s finished items?',
    ask: choices('SQLite', 'Postgres'),
    premise: 'The board keeps every finished item, so the store must hold a year of them.',
    context: 'Postgres means another service to run.',
  }),
  sessionView('sess-q', { config: { teammate: 'zoe', name: 'Board storage' } as never }),
);

const client = {
  call: async () =>
    ({
      id: `att_${'b'.repeat(64)}`,
      filename: 'shot.png',
      mime: 'image/png',
      size: 3,
      sha256: '0'.repeat(64),
      createdAt: '2026-10-30T10:00:00.000Z',
    }) as never,
};

const fake = fakeInbox();
const card = scene === 'ask' ? gate : question;

function Scene() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <InboxHarness
        cards={[card]}
        fake={fake}
        reading={false}
        render={inbox => (
          <AgendaInboxPage
            answerPorts={answerFilePorts({ daemon: laptop.daemonId, client })}
            clock={fake.clock.now}
            initialOpen={card.key}
            inbox={{ ...inbox, connectionFor: () => laptop }}
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
