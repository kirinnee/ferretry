/**
 * The browser entry for "a card's gate rides on its open thread": the REAL `AgendaItemView` over a thread that carries
 * a gate (`gateAttached`), so the item's own question and the gate's options are both answerable on the one item.
 *
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const thread = agendaItem('A47', {
  title: 'Badge colour',
  subject: 'Which colour should the badge be?',
  premise: '- The badge is on every card\n- The ferret needs one colour today',
  context: '- Blue matches the header',
  waitingSince: '2026-08-01T11:00:00.000Z',
  task: { id: 'F12' },
  ask: choices('Blue', 'Green'),
  gateAttached: {
    cardId: 'F12',
    laneId: 'tested',
    laneName: 'To test',
    entry: 3,
    projectId: 'p1',
    projectName: 'Ferretry',
    cardTitle: 'Badge colour',
    options: [
      { id: 'o0', label: 'Done', outcome: 'close' },
      { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
    ],
  },
} as never);

function Scene() {
  return (
    <div className="kt-chat-surface scene-chat">
      <div className="fy-chat-log">
        <AgendaItemView
          busy={false}
          error={null}
          ferret="Zoe"
          history={[]}
          item={thread}
          now={NOW}
          onAct={() => undefined}
          onClose={() => undefined}
          onNext={() => undefined}
          onPrevious={() => undefined}
          onSnooze={() => undefined}
          position={{ index: 1, total: 3 }}
          renderProse={text => text}
          swipeable={false}
        />
      </div>
      <div className="fy-chat-input" data-safe-bottom="">
        <div className="fy-chat-input__column">
          <div className="scene-composer">Reply to Zoe…</div>
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
