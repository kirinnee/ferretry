/**
 * The browser entry for "the open agenda item keeps its head and its answers in reach": the REAL `AgendaItemView`
 * over the message list's cell, above a stand-in composer.
 *
 *   ?theme=<family>-<mode>
 *   ?kind=choice|reply         a one-row answer (default), or an answer in words (the composer is the answer)
 *   ?touch=1                   the card is swipeable
 *
 * The chat at its tail (Conversation's `Transcript` beside this half's `AgendaLine`) is not drawn here: Agenda imports
 * nothing of Conversation's app.
 */

import { createRoot } from 'react-dom/client';
import { AgendaItemView } from '../../../../app/features/agenda/agenda-item-view.tsx';
import { agendaItem, choices } from '../../../support/app/agenda-inbox.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const points = (prefix: string, count: number): string =>
  Array.from(
    { length: count },
    (_, index) =>
      `- ${prefix} ${String(index + 1)}: a point long enough to wrap on a phone screen, so the card runs well past one screen of its own.`,
  ).join('\n');

const long = {
  premise: points('Premise', 10),
  context: points('Context', 10),
  body: `${points('Detail', 12)}\n\nA closing paragraph that says what happens after the pick, and what does not.`,
  why: 'The board keeps every finished item.',
  waitingSince: '2026-08-01T11:00:00.000Z',
};

const choice = agendaItem('A47', {
  ...long,
  title: 'Which database should keep the board’s finished items?',
  subject: 'Which database should keep the board’s finished items?',
  ask: choices('SQLite', 'Postgres', 'Files'),
  recommendation: { decision: 'SQLite', why: 'No server to run, and one file to back up.' },
});

const reply = agendaItem('A48', {
  ...long,
  title: 'What should the release email say?',
  subject: 'What should the release email say?',
  ask: { kind: 'open-question' },
  kind: 'reply',
} as never);

const history = [
  { kind: 'ferret', key: 'f1', at: NOW - 600_000, text: 'Re !A47: I looked at both and lean to SQLite.' },
  { kind: 'ferret', key: 'f2', at: NOW - 300_000, text: 'Re !A47: nothing has changed since.' },
] as never;

function Item() {
  const kind = params.get('kind') ?? 'choice';
  return (
    <div className="kt-chat-surface scene-chat">
      <div className="fy-chat-log">
        <AgendaItemView
          busy={false}
          error={null}
          ferret="Zoe"
          history={history}
          item={kind === 'reply' ? reply : choice}
          now={NOW}
          onAct={() => undefined}
          onClose={() => undefined}
          onNext={() => undefined}
          onPrevious={() => undefined}
          position={{ index: 1, total: 3 }}
          renderProse={text => text}
          swipeable={params.get('touch') === '1'}
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
if (root !== null) createRoot(root).render(<Item />);
