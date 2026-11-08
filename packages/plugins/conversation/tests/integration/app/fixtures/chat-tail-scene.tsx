/**
 * The browser entry for "the chat has no band of nothing above the composer": the REAL `Transcript` above a stand-in
 * agenda row and a stand-in composer, laid out the way the chat lays its log and its input column.
 *
 * The agenda row is a STAND-IN: it is Agenda's `AgendaLine`, which Conversation does not import (a package reaches
 * another only through its contract). It reproduces what the transcript depends on — one row, a left slot the Jump
 * pill is portalled into (`jumpSlot`), the Agenda button on its right — so what this scene proves is Conversation's
 * half: the transcript leaves no second row of its own and the pill does not resize the row it sits in. That the real
 * row keeps its height is Agenda's (`packages/plugins/agenda/tests`).
 *
 *   ?theme=<family>-<mode>
 *   ?host=0                    leave the Jump pill's host out, as the chat was (two rows under the messages)
 *   ?agenda=0                  no agenda row at all, so the transcript keeps the pill row of its own
 *   ?busy=1                    a turn is running, drawn in the agenda row's left
 */

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import { Transcript } from '../../../../app/chat/transcript.tsx';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';

/** The stand-in for Agenda's row: one flex row, the jump slot on the left, the toggle on the right. */
function AgendaRowStandIn({
  jumpSlot,
  live,
}: {
  readonly jumpSlot?: (element: HTMLElement | null) => void;
  readonly live?: ReactNode;
}) {
  return (
    <div className="scene-agenda-row">
      {jumpSlot === undefined ? null : <div className="scene-agenda-row__jump" ref={jumpSlot} />}
      {live === undefined ? null : <div className="scene-agenda-row__live">{live}</div>}
      <button className="scene-agenda-row__main" type="button">
        Agenda · 2 need you
      </button>
    </div>
  );
}

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

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
            <AgendaRowStandIn
              {...(hosted ? { jumpSlot: setHost } : {})}
              {...(busy ? { live: <span>Wrangling… 3s</span> } : {})}
            />
          ) : null}
          <div className="scene-composer">Message Zoe</div>
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Chat />);
