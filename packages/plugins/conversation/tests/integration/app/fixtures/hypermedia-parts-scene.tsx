/**
 * The browser entry for "every Durian part draws inside an assistant message, under the app's real policy": the REAL
 * `Transcript` over ONE fake assistant message whose text is the page's own `?fixture=<name>` (fetched from the test's
 * server, so a message is never baked into the bundle), with the chat's own reference surface.
 *
 *   ?fixture=<name>   a Durian fixture, `format/<file>` or `hostile/<file>`, as the server names it
 *   ?text=<message>   the message itself, instead of a fixture
 *   ?theme=<family>-<mode>
 *
 * It reports `window.fyPartsReady = true` once the message is on the page. Nothing here reads a network but its own origin.
 */

import { ReferenceSurfaceProvider } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import { chatReferenceSurface } from '../../../../app/chat/reference-surface.ts';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';
import { Transcript } from '../../../../app/chat/transcript.tsx';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') ?? 'studio-light';
// The look the app reads is three root attributes (the shell's own pre-paint sets them); this scene is Indigo (`studio`) in
// the asked mode. (`data-theme` is kept for the stale watchers that still read it.)
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.style = 'studio';
document.documentElement.dataset.palette = 'studio';
document.documentElement.dataset.mode = theme.endsWith('dark') ? 'dark' : 'light';

const entriesOf = (text: string): readonly TranscriptEntry[] => [
  { id: 'u1', kind: 'user', text: 'Show me.' },
  { id: 'a1', kind: 'assistant', text },
];

const surface = chatReferenceSurface({ daemonId: 'daemon-h4', ferretId: 'mvh4scene-5e7d0b1e' });

const view = (text: string) => (
  <ReferenceSurfaceProvider surface={surface}>
    <div className="kt-chat-surface scene-chat">
      <div className="fy-chat-log">
        <div className="fy-chat-log__messages">
          <Transcript agentName="Zoe" daemonId="daemon-h4" entries={entriesOf(text)} sessionId="mvh4scene-5e7d0b1e" />
        </div>
      </div>
    </div>
  </ReferenceSurfaceProvider>
);

const root = document.getElementById('root');
const fixture = params.get('fixture');
if (root !== null) {
  const app = createRoot(root);
  Object.assign(window, { fyStream: (text: string) => app.render(view(text)) });
  const literal = params.get('text');
  const text =
    literal !== null
      ? Promise.resolve(literal)
      : fixture === null
        ? Promise.resolve('')
        : fetch(`/fixture/${fixture}`).then(response => response.text());
  void text.then(body => {
    app.render(view(body));
    Object.assign(window, { fyPartsReady: true });
  });
}
