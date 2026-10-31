/**
 * The browser entry for "Jump to latest covers the last row": the REAL `Transcript` over a conversation
 * whose newest message ends in a block that must stay readable beside the pill, with a stand-in composer
 * under it so the pill is checked against the whole stack.
 *
 *   ?theme=<family>-<mode>
 *   ?last=table|code|diagram   what the newest message ends in (default table)
 */

import { createRoot } from 'react-dom/client';
import { Transcript } from '../../../src/components/transcript.tsx';
import type { TranscriptEntry } from '../../../src/lib/session-screens.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const TABLE = [
  'Where each part of the work stands:',
  '',
  '| Area | Status |',
  '| --- | --- |',
  '| Daemon routes | Merged (#1140) |',
  '| Terminal rename | Waits for the tab bar (#1141) |',
  '| Agenda drawer | Ready for review (#1143) |',
  '| Browser copy and paste | Waits for browser logins (#1147 and the follow-up) |',
].join('\n');

const CODE = [
  'The failing check, as run:',
  '',
  '```ts',
  ...Array.from({ length: 7 }, (_, i) => `const row${i} = run(${i});`),
  '```',
].join('\n');

const DIAGRAM = [
  'The path a message takes:',
  '',
  '```mermaid',
  'flowchart LR',
  '  phone --> relay --> daemon --> ferret',
  '```',
].join('\n');

const LAST = { table: TABLE, code: CODE, diagram: DIAGRAM }[params.get('last') ?? 'table'] ?? TABLE;

const entries: readonly TranscriptEntry[] = [
  ...Array.from(
    { length: 14 },
    (_, index): TranscriptEntry => ({
      id: `m${String(index)}`,
      kind: index % 2 === 0 ? 'user' : 'assistant',
      text: `${index % 2 === 0 ? 'Question' : 'Answer'} ${String(index)}: a line long enough to wrap on a phone screen and fill the log.`,
    }),
  ),
  { id: 'last', kind: 'assistant', text: LAST },
];

function Scene() {
  return (
    <div className="kt-chat-surface scene-chat">
      <div className="scene-messages">
        <Transcript agentName="Lizzette" daemonId="d" entries={entries} sessionId="s" />
      </div>
      <div className="scene-composer">Message Lizzette</div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
