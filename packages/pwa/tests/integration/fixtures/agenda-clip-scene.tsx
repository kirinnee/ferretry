/**
 * The browser entry for "menus open inside the viewport" and "the Answer-quickly card scrolls and keeps its answers in
 * reach": the REAL `AgendaItemView` with its ⓘ panel's snooze control, and the REAL `ToTestStep` in the run's own
 * fixed-height box.
 *
 *   ?theme=<family>-<mode>
 *   ?scene=item|run       the open item (its ⓘ panel carries the snooze control), or one card of the run (default run)
 *   ?marked=1            item: the options' labels carry Markdown ("A **Send now**", "B **Wait**")
 *   ?same=1               run: the card's title is its task's name, in another case
 *   ?steps=<n>            run: how many steps the card has (default 16: longer than the box)
 *
 * `window.__skipped` counts the run's Skip.
 */

import { createRoot } from 'react-dom/client';
import { ChatProse } from '../../../src/components/chat-prose.tsx';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import type { ToTestAnswers } from '../../../src/features/agenda/to-test-rows.tsx';
import { ToTestStep } from '../../../src/features/agenda/to-test-step.tsx';
import type { ToTestCard } from '../../../src/lib/to-test-inbox.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';

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

const stepCount = Number(params.get('steps') ?? 16);
const stepWords = (): string =>
  stepCount < 5
    ? 'Open the card.'
    : `ask a ferret to run something that prompts for a password through a real \`sudo\`, then read what the card says about it and about the lock.`;
const steps = Array.from(
  { length: stepCount },
  (_, index) => `${String(index + 1)}. Step ${String(index + 1)}: ${stepWords()}`,
).join('\n');

const same = params.get('same') === '1';
const row = {
  key: 'to-test:F1',
  card: {
    key: 'F1',
    daemonId: 'd1',
    machine: 'Liftoff EC2',
    task: {
      id: 'F1',
      title: same ? 'Secret card program check' : 'Try the secret card program',
      shippedIn: { version: '4.192.0' },
    },
  },
  group: {},
  doneLaneId: 'closed',
  notGoodLaneId: 'implement',
  howToTest: steps,
  taskName: same ? 'Secret Card Program Check' : 'Credentials Build Lead',
  since: '2026-08-01T06:00:00.000Z',
  snoozedUntil: null,
} as unknown as ToTestCard;

const answers: ToTestAnswers = {
  answerFor: () => ({ pressed: null, error: null }) as never,
  done: () => {
    win.__done += 1;
  },
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
              index={5}
              now={NOW}
              onNavigate={() => undefined}
              onNext={() => {
                win.__skipped += 1;
              }}
              onPrevious={() => undefined}
              row={row}
              total={40}
            />
          </div>
        </div>
      </div>
      <nav data-tab-bar="" style={{ flex: 'none', height: 56, borderTop: '1px solid currentColor' }} />
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(params.get('scene') === 'item' ? <Item /> : <Run />);
