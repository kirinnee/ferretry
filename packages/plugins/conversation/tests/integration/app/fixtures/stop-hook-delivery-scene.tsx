/**
 * The browser entry for hook-delivered messages: what a Claude Code ferret's transcript holds when Ferretry hands it a
 * message through the Stop hook's listener, drawn by the real `Transcript`.
 *
 * FAKE DATA ONLY. Every record below is the wrapper Claude Code 2.1.317 was measured to write, with invented names and
 * words, walked through the real Claude transcript parser, the daemon's log rendering and the app's log reader — so what
 * is on screen is what a chat shows, not a hand-built row.
 *
 * Parameters (all optional):
 *
 *   ?theme=<family>-<mode>
 */

import { ReferenceSurfaceProvider } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import { transcriptEntriesFromLog } from '../../../../app/chat/chat-refresh.ts';
import { Transcript } from '../../../../app/chat/transcript.tsx';
import { peerEnvelopePreamble } from '../../../../contract/index.ts';
import { OWNER_NUDGE_TEXT } from '../../../../daemon/delivery/lib/rewake.ts';
import { renderTranscript } from '../../../../daemon/reader/lib/reads.ts';
import { ClaudeTranscriptParser } from '../../../../daemon/reader/lib/transcript/claude.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.now();

/** The wrapper the harness records around what the Stop hook's listener printed (measured on 2.1.317). */
const wrapped = (text: string): string =>
  `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": ${text}\n\n</system-reminder>`;

const banner = (name: string, sessionId: string): string =>
  peerEnvelopePreamble({ name, sessionId, kind: 'message', label: 'action', clientName: 'fy' });

const RECORDS: readonly { readonly text: string; readonly minutesAgo: number; readonly role: 'user' | 'assistant' }[] =
  [
    { role: 'user', minutesAgo: 9, text: 'Please check the nightly build and tell me why it is red.' },
    { role: 'assistant', minutesAgo: 8, text: 'Looking at the build log now. I will report back when I know.' },
    {
      role: 'user',
      minutesAgo: 6,
      text: wrapped(
        `${banner('avary', 'mvavary1-a41c8b02')}The nightly build is red because the lockfile changed. I pinned it in my branch; please rebase before you push.`,
      ),
    },
    { role: 'assistant', minutesAgo: 5, text: 'Thanks — rebasing onto avary’s branch now.' },
    {
      role: 'user',
      minutesAgo: 3,
      text: wrapped(OWNER_NUDGE_TEXT),
    },
    {
      role: 'assistant',
      minutesAgo: 2,
      text: 'Rebased and pushed. Ending my turn so the owner’s message can come through.',
    },
    { role: 'user', minutesAgo: 1, text: 'Great, thanks. Please also run the full test suite before you finish.' },
  ];

const jsonl = RECORDS.map((record, index) => {
  const at = new Date(NOW - record.minutesAgo * 60_000).toISOString();
  const hookWrapped = record.text.startsWith('<task-notification>');
  return JSON.stringify({
    type: record.role,
    uuid: `rec-${index}`,
    timestamp: at,
    // The harness flags a hook delivery as its own; the chat must still show it as the ferret's message.
    ...(hookWrapped ? { origin: { kind: 'task-notification' }, isMeta: true } : {}),
    message: { role: record.role, content: record.text },
  });
}).join('\n');

const entries = transcriptEntriesFromLog(
  renderTranscript(new ClaudeTranscriptParser().parse({ text: `${jsonl}\n` }).events),
  NOW,
);

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="scene-chat">
    <ReferenceSurfaceProvider surface={{ onNavigate: () => undefined }}>
      <Transcript
        agentName="Janella"
        daemonId="daemon-chat"
        entries={entries}
        onSubmit={async () => true}
        sessionId="mvchat01-5e7d0b1e"
      />
    </ReferenceSurfaceProvider>
  </div>,
);
