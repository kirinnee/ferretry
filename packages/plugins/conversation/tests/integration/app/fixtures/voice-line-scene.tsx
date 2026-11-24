/**
 * The browser entry for "a spoken line of a reply": the REAL `Transcript` over one fake exchange whose answer opens and closes
 * with `<voice>` lines around written work, a second answer that only SHOWS the tag in code, and a third with a long line.
 *
 *   ?theme=<family>-<mode>
 *
 * The root says `data-mode` as the app's own root does. Nothing here reads a network or a real home.
 */
import { ReferenceSurfaceProvider, ScreenHrefProvider } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import { Transcript } from '../../../../app/chat/transcript.tsx';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') ?? 'studio-light';
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.mode = theme.endsWith('dark') ? 'dark' : 'light';

const FENCE = '`'.repeat(3);
const SPOKEN = [
  '<voice>Let me check the build.</voice>',
  '',
  'Running the tests now.',
  '',
  `${FENCE}terminal`,
  '$ bun test',
  'ok 12 tests',
  FENCE,
  '',
  '- lint: pass',
  '- types: pass',
  '',
  '<voice>All twelve tests pass and the build is green, so it is safe to ship whenever you are ready to go ahead.</voice>',
].join('\n');

const TEACHING = [
  'To speak a line, write it like `<voice>hello</voice>`:',
  '',
  `${FENCE}md`,
  '<voice>hello</voice>',
  FENCE,
].join('\n');

const entries: readonly TranscriptEntry[] = [
  { id: 'u1', kind: 'user', text: '(voice) Is the release ready?' },
  { id: 'a1', kind: 'assistant', text: SPOKEN },
  { id: 'u2', kind: 'user', text: 'How do I make you speak?' },
  { id: 'a2', kind: 'assistant', text: TEACHING },
];

const surface = {
  agentReferenceResolver: () => null,
  taskReferenceResolver: () => false,
  agendaReferenceResolver: () => false,
  onTaskOpen: () => undefined,
  onAgendaOpen: () => undefined,
  onNavigate: () => undefined,
};

const href = (daemon: string, plugin: string, screen: string) => `/${daemon}/${plugin}/${screen}`;

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <ScreenHrefProvider href={href}>
      <ReferenceSurfaceProvider surface={surface}>
        <div className="kt-chat-surface scene-chat">
          <div className="fy-chat-log">
            <div className="fy-chat-log__messages">
              <Transcript agentName="Zoe" daemonId="d" entries={entries} sessionId="s" />
            </div>
          </div>
        </div>
      </ReferenceSurfaceProvider>
    </ScreenHrefProvider>,
  );
