/**
 * The browser entry for "an `fy-render` block draws inside an assistant message that Durian reads": the REAL `Transcript`
 * over one fake assistant message, with the chat's own reference surface (`chatReferenceSurface`), which is where the
 * `fy-render` fences come from. The message holds a drawn `svg`, a scripted `html` block (its own frame), a fence opened
 * as `fy-render notes` (plain code) and a block with no boundary line (plain code). Nothing here reads a network.
 *
 *   ?theme=<family>-<mode>
 */

import { ReferenceSurfaceProvider } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import { chatReferenceSurface } from '../../../../app/chat/reference-surface.ts';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';
import { Transcript } from '../../../../app/chat/transcript.tsx';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') ?? 'studio-light';
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.mode = theme.endsWith('dark') ? 'dark' : 'light';

const FENCE = '`'.repeat(3);

const SQUARE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="120" height="60" rx="8" fill="#2b5cff"/><circle cx="30" cy="30" r="16" fill="#ffd23f"/></svg>';

const PAGE = [
  '<style>body{font:14px system-ui,sans-serif;margin:0;padding:12px}button{border:1px solid #8884;border-radius:6px;padding:6px 14px}</style>',
  '<button id="t">Day 2</button> <span id="a">Day 1: arrive in Lisbon.</span>',
  '<script>t.onclick=()=>{a.textContent="Day 2: Belem tower."}</script>',
];

const MESSAGE = [
  '## Plan',
  '',
  'Here is the shape of it, then the agenda:',
  '',
  `${FENCE}fy-render`,
  'type: svg',
  'alt: A blue banner with a yellow dot',
  '---',
  SQUARE,
  FENCE,
  '',
  `${FENCE}fy-render`,
  'type: html',
  'alt: A small agenda with a day button',
  '---',
  ...PAGE,
  FENCE,
  '',
  'A block that is only code stays code:',
  '',
  `${FENCE}fy-render notes`,
  'type: svg',
  'alt: not drawn',
  '---',
  SQUARE,
  FENCE,
  '',
  `${FENCE}fy-render`,
  'type: html',
  '<b>no boundary line</b>',
  FENCE,
].join('\n');

const entriesOf = (text: string): readonly TranscriptEntry[] => [
  { id: 'u1', kind: 'user', text: 'Show me the plan.' },
  { id: 'a1', kind: 'assistant', text },
];

const surface = chatReferenceSurface({ daemonId: 'daemon-h3', ferretId: 'mvh3scene-5e7d0b1e' });

const view = (text: string) => (
  <ReferenceSurfaceProvider surface={surface}>
    <div className="kt-chat-surface scene-chat">
      <div className="fy-chat-log">
        <div className="fy-chat-log__messages">
          <Transcript agentName="Zoe" daemonId="daemon-h3" entries={entriesOf(text)} sessionId="mvh3scene-5e7d0b1e" />
        </div>
      </div>
    </div>
  </ReferenceSurfaceProvider>
);

const root = document.getElementById('root');
if (root !== null) {
  const app = createRoot(root);
  app.render(view(MESSAGE));
  // STREAMING: the SAME assistant message grows (same entry id), the way a reply arrives; a test drives it step by step.
  Object.assign(window, { fyStream: (text: string) => app.render(view(text)), fyMessage: MESSAGE });
}
