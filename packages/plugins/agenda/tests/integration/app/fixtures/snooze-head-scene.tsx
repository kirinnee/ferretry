/** The unified agenda item with its snooze control, in a real browser fixture. */

import { createRoot } from 'react-dom/client';
import { AgendaItemView } from '../../../../app/features/agenda/agenda-item-view.tsx';
import { agendaItem, choices } from '../../../support/app/agenda-inbox.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const title =
  params.get('title') === 'short'
    ? 'Spend limit'
    : 'Which day works best for the board’s finished items cut-over, and who owns the old ones?';

const item = agendaItem('A47', {
  title,
  subject: 'One rule left before spend limits ship, and the ferret needs it today.',
  premise: '- Each login has a limit',
  context: '- Warn never stops a turn',
  waitingSince: '2026-08-01T11:00:00.000Z',
  ask: choices('Pause', 'Switch', 'Warn'),
});

function Item() {
  return (
    <div className="kt-chat-surface" style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="fy-chat-log">
        <AgendaItemView
          busy={false}
          error={null}
          ferret="Zoe"
          history={[]}
          item={item}
          now={NOW}
          onAct={() => undefined}
          onClose={() => undefined}
          onNext={() => undefined}
          onPrevious={() => undefined}
          onSnooze={() => undefined}
          position={{ index: 2, total: 8 }}
          renderProse={text => text}
          swipeable={false}
        />
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Item />);
