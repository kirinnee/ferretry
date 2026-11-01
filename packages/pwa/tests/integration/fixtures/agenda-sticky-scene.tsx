/**
 * The browser entry for "the open agenda item keeps its head and its answers in reach" and "the chat has no band
 * of nothing above the composer": the REAL `AgendaItemView` over the message list's cell, and the REAL `Transcript`
 * with the REAL `AgendaLine`, each above a stand-in composer, laid out the way `session-chat-page.tsx` lays them.
 *
 *   ?theme=<family>-<mode>
 *   ?scene=item|chat           the open item's view, or the chat at its tail (default item)
 *   ?kind=choice|reply         item: a one-row answer (default), or an answer in words (the composer is the answer)
 *   ?host=0                    chat: leave the Jump pill's host out, as the chat was (two rows under the messages)
 *   ?agenda=0                  chat: no agenda row at all, so the transcript keeps the pill row of its own
 *   ?busy=1                    chat: a turn is running, drawn in the agenda row's left
 */

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Transcript } from '../../../src/components/transcript.tsx';
import { AgendaLine } from '../../../src/features/agenda/agenda-line.tsx';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import type { TranscriptEntry } from '../../../src/lib/session-screens.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';

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

const entries: readonly TranscriptEntry[] = Array.from(
  { length: 16 },
  (_, index): TranscriptEntry => ({
    id: `m${String(index)}`,
    kind: index % 2 === 0 ? 'user' : 'assistant',
    text: `${index % 2 === 0 ? 'Question' : 'Answer'} ${String(index)}: a line long enough to wrap on a phone screen and fill the log.`,
  }),
);

const busy = params.get('busy') === '1';
const startedAt = new Date(Date.now() - 3_000).toISOString();

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

function Chat() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const withAgenda = params.get('agenda') !== '0';
  const hosted = withAgenda && params.get('host') !== '0';
  return (
    <div className="kt-chat-surface scene-chat">
      <div className="fy-chat-log">
        <div className="fy-chat-log__messages">
          <Transcript
            activityFallback={busy ? 'Wrangling…' : null}
            agentName="Zoe"
            busy={busy}
            daemonId="d"
            entries={entries}
            jumpHost={hosted ? host : null}
            liveInRow={withAgenda && busy}
            sessionId="s"
            turnStartedAt={busy ? startedAt : null}
          />
        </div>
      </div>
      <div className="fy-chat-input" data-safe-bottom="">
        <div className="fy-chat-input__column">
          {withAgenda ? (
            <AgendaLine
              controls="drawer"
              counts={{ blocking: 0, needYou: 2, withFerret: 1 }}
              ferret="Zoe"
              {...(hosted ? { jumpSlot: setHost } : {})}
              {...(busy ? { live: <span>Wrangling… 3s</span> } : {})}
              onToggle={() => undefined}
              open={false}
              sending={{ count: 0, headings: [] }}
            />
          ) : null}
          <div className="scene-composer">Message Zoe</div>
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(params.get('scene') === 'chat' ? <Chat /> : <Item />);
