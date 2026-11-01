/**
 * The browser entry for "snooze is in the card's one-row head": the REAL `AgendaItemView`, the Inbox's quick-answer
 * run (`ToTestStep`) and a plain list of cards to test (`ToTestList`, the chat's task panel and the Board's Cards view).
 *
 *   ?theme=<family>-<mode>
 *   ?scene=item|run|list
 *   ?title=short|long          a title that fits the row, or one far too long for it (default long)
 */

import { createRoot } from 'react-dom/client';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import { type ToTestAnswers, ToTestList } from '../../../src/features/agenda/to-test-rows.tsx';
import { ToTestStep } from '../../../src/features/agenda/to-test-step.tsx';
import type { ToTestCard } from '../../../src/lib/to-test-inbox.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';

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

const rowOf = (key: string): ToTestCard =>
  ({
    key: `to-test:${key}`,
    card: {
      key,
      daemonId: 'd1',
      machine: 'Liftoff EC2',
      task: { id: key, title, shippedIn: { version: '4.192.0' } },
    },
    group: {},
    doneLaneId: 'closed',
    notGoodLaneId: 'implement',
    howToTest: '1. Open the card.\n2. Press Done.',
    taskName: 'Credentials Build Lead',
    projectName: 'Ferretry',
    since: '2026-08-01T06:00:00.000Z',
    snoozedUntil: null,
  }) as unknown as ToTestCard;

const answers: ToTestAnswers = {
  answerFor: () => ({ pressed: null, error: null }) as never,
  done: () => undefined,
  notGood: () => undefined,
  snooze: () => undefined,
};

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

function Run() {
  const phone = window.innerWidth < 768;
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: '1 1 0', minHeight: 0 }}>
        <div className="fy-attn-inbox" data-agenda-inbox="card" {...(phone ? { 'data-phone': '' } : {})}>
          <header style={{ minHeight: 32 }}>Inbox</header>
          <div className="fy-attn-inbox__deck fy-attn-inbox__deck--open">
            <ToTestStep
              answers={answers}
              index={2}
              now={NOW}
              onNavigate={() => undefined}
              onNext={() => undefined}
              onPrevious={() => undefined}
              row={rowOf('F1')}
              total={8}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function List() {
  return (
    <div className="kt-chat-surface" style={{ padding: 12 }}>
      <ToTestList answers={answers} now={NOW} onNavigate={() => undefined} rows={[rowOf('F1'), rowOf('F2')]} />
    </div>
  );
}

const scene = params.get('scene');
const root = document.getElementById('root');
if (root !== null) createRoot(root).render(scene === 'run' ? <Run /> : scene === 'list' ? <List /> : <Item />);
