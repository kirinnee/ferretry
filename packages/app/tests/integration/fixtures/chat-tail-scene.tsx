/**
 * The browser entry for "the chat has no band of nothing above the composer": the REAL `Transcript` (Conversation's
 * app) with the REAL `AgendaLine` (Agenda's app), each above a stand-in composer, laid out the way the chat lays its
 * log and its input column. Only the SHELL composes the two halves, so this scene lives in `@ferretry/app`'s tests;
 * neither plugin imports the other.
 *
 *   ?theme=<family>-<mode>
 *   ?host=0                    leave the Jump pill's host out, as the chat was (two rows under the messages)
 *   ?agenda=0                  no agenda row at all, so the transcript keeps the pill row of its own
 *   ?busy=1                    a turn is running, drawn in the agenda row's left
 */

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Transcript } from '../../../../plugins/conversation/app/chat/transcript.tsx';
import type { TranscriptEntry } from '../../../../plugins/conversation/app/chat/transcript-entries.ts';
import { AgendaLine } from '../../../../plugins/agenda/app/features/agenda/agenda-line.tsx';

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
if (root !== null) createRoot(root).render(<Chat />);
