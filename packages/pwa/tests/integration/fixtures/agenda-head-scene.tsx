/**
 * The browser entry for "the open agenda item's head is ONE row": the REAL `AgendaItemView` over the message
 * list's cell above a stand-in composer, with a short or a long title and, optionally, a form in the card.
 *
 *   ?theme=<family>-<mode>
 *   ?title=short|long          a title that fits the row, or one far too long for it (default short)
 *   ?card=choice|form          a one-row answer, or a form of fields in the card (default choice)
 */

import { createRoot } from 'react-dom/client';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const long = params.get('title') === 'long';
const title = long
  ? 'Which database should keep the board’s finished items, and who owns the migration of the old ones, and by when must the cut-over to it be done so the old store can be switched off for good?'
  : 'Spend limit';
const common = {
  title,
  subject: 'One rule left before spend limits ship, and the ferret needs it today.',
  premise: '- Each login has a limit\n- A running turn always finishes',
  context: '- Warn never stops a turn',
  waitingSince: '2026-08-01T11:00:00.000Z',
};

const choice = agendaItem('A47', { ...common, ask: choices('Pause', 'Switch', 'Warn') });
const form = agendaItem('A48', { ...common, kind: 'input', ask: { kind: 'open-question' } } as never);

function Fields() {
  return (
    <form className="scene-form" data-scene-form="">
      <label>
        Region
        <input data-scene-field="" defaultValue="eu-west" type="text" />
      </label>
      <label>
        Alerts
        <textarea data-scene-field="" defaultValue="Relay down" rows={3} />
      </label>
    </form>
  );
}

function Scene() {
  const asForm = params.get('card') === 'form';
  return (
    <div className="kt-chat-surface scene-chat">
      <div className="fy-chat-log">
        <AgendaItemView
          busy={false}
          error={null}
          ferret="Zoe"
          history={[]}
          item={asForm ? form : choice}
          now={NOW}
          onAct={() => undefined}
          onClose={() => undefined}
          onNext={() => undefined}
          onPrevious={() => undefined}
          onSnooze={() => undefined}
          position={{ index: 2, total: 8 }}
          renderProse={text => text}
          swipeable={false}
          {...(asForm ? { inputForm: <Fields /> } : {})}
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
