/** The unified agenda item with its snooze control, in a real browser fixture. */

import { createRoot } from 'react-dom/client';
import { ChatProse } from '../../../../app/shell.ts';
import { AgendaItemView } from '../../../../app/features/agenda/agenda-item-view.tsx';
import { agendaItem, choices } from '../../../support/app/agenda-inbox.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const win = window as unknown as { __skipped: number; __done: number };
win.__skipped = 0;
win.__done = 0;

const item = agendaItem('A1229', {
  title: 'Send 20 pod-label PRs to their teams',
  subject: 'Send 20 pod-label PRs to their teams',
  ask: params.get('marked') === '1' ? choices('A **Send now**', 'B **Wait**') : choices('Send now', 'Wait'),
  premise: 'The PRs add the 8 standard pod labels across 17 repos; CI green except one.',
  context: 'You asked for one table to send them out and inspect them.',
  waitingSince: '2026-08-01T11:00:00.000Z',
});

function Item() {
  return (
    <div className="kt-chat-surface" style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="fy-chat-log">
        <AgendaItemView
          busy={false}
          error={null}
          ferret="Judie"
          history={[] as never}
          item={item}
          now={NOW}
          onAct={() => undefined}
          onClose={() => undefined}
          onNext={() => undefined}
          onPrevious={() => undefined}
          onSnooze={() => undefined}
          position={{ index: 0, total: 1 }}
          renderProse={text => <ChatProse text={text} />}
          swipeable
        />
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Item />);
