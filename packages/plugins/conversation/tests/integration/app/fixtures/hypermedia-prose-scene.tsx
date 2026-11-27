/**
 * The browser entry for "an assistant message reads as Durian Hypermedia": the REAL `Transcript` over one fake exchange,
 * with the chat's reference surface faked (task `&F12` and ferret `:zelda` are provable; `&F99999` is not).
 *
 *   ?theme=<family>-<mode>
 *
 * The root says `data-mode` as the app's own root does (`theme/preferences.ts`); `window.__opened` records what a click on
 * a proved reference asked to open. Nothing here reads a network or a real home.
 */

import { ReferenceSurfaceProvider, ScreenHrefProvider } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import { Transcript } from '../../../../app/chat/transcript.tsx';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';

declare global {
  interface Window {
    __opened: string[];
  }
}
window.__opened = [];

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') ?? 'studio-light';
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.mode = theme.endsWith('dark') ? 'dark' : 'light';
// r12 H5: the three axes the app's root carries (`theme/preferences.ts`), for the theme audit; the matrix test then re-sets
// them in place for every combination. A scene opened with `?theme=` alone has the default style and palette, as before.
if (params.has('style')) document.documentElement.dataset.style = params.get('style') ?? 'studio';
if (params.has('palette')) document.documentElement.dataset.palette = params.get('palette') ?? 'studio';

const FENCE = '`'.repeat(3);
const MESSAGE = [
  '## Release check',
  '',
  'Release prep is done. Ask :zelda to read @src/api.ts before ^A3 closes, and see &F12 (and the unknown &F99999).',
  '',
  '- Run the tests with **bun test**',
  '- Read [the docs](https://example.com/docs) or the notes below',
  '',
  `${FENCE}terminal`,
  '$ bun test',
  'ok 12 tests',
  FENCE,
  '',
  '| Step | Result |',
  '| - | - |',
  '| lint | pass |',
  '| types | pass |',
  '',
  `${FENCE}ts`,
  'const ready: boolean = true;',
  FENCE,
  '',
  '> **Note:** nothing was deployed.',
].join('\n');

/** Author text for an LLM stays visible, and inline code keeps its typed bytes (r12 H2 fix; its own message, so the first stays free of character references). */
const AUTHOR_TEXT = [
  'Second check, with text written for an LLM:',
  '',
  `${FENCE}terminal`,
  '$ bun test --all',
  'ok 30 tests',
  FENCE,
  '',
  ':::llm',
  'Tests pass: 12 of 12.',
  ':::',
  '',
  'Inline code stays as typed: `&lt;demo&gt;` and `<demo>`.',
  '',
  ':::human llm=none',
  'Only people read this line.',
  ':::',
].join('\n');

/**
 * `?marks=1` adds the parts that draw SERIES colours (the app's `--viz-1…8`, reached through Durian's `--c1…8`): a tier list
 * (a tone per tier) and an alignment grid with one cell in each of the eight series colours. A ```chart fence is held as code
 * in chat and `mermaid` is drawn in a sandbox frame, so these are the series marks the message itself paints. Opt-in so the
 * other scene tests keep their two messages.
 */
const MARKS_TEXT = [
  'Series marks:',
  '',
  `${FENCE}tierlist title="Marks"`,
  'S: alpha, beta',
  'A: gamma',
  'B: delta',
  'C: epsilon',
  FENCE,
  '',
  `${FENCE}alignment title="Series"`,
  'x: left .. mid .. right .. far',
  'y: top .. bottom',
  'left / top "One" [c1]: first',
  'mid / top "Two" [c2]: second',
  'right / top "Three" [c3]: third',
  'far / top "Four" [c4]: fourth',
  'left / bottom "Five" [c5]: fifth',
  'mid / bottom "Six" [c6]: sixth',
  'right / bottom "Seven" [c7]: seventh',
  'far / bottom "Eight" [c8]: eighth',
  FENCE,
].join('\n');

const entries: readonly TranscriptEntry[] = [
  { id: 'u1', kind: 'user', text: 'Is the release ready?' },
  { id: 'a1', kind: 'assistant', text: MESSAGE },
  { id: 'a2', kind: 'assistant', text: AUTHOR_TEXT },
  ...(params.get('marks') === '1' ? [{ id: 'a3', kind: 'assistant', text: MARKS_TEXT } as const] : []),
];

const surface = {
  // A proof by callsign (when a token is read) and by session id (when a painted link is asked again).
  agentReferenceResolver: ({ name, sessionId }: { readonly name?: string; readonly sessionId?: string }) =>
    name === 'zelda' || sessionId === 's-zelda' ? { daemonId: 'd', sessionId: 's-zelda', name: 'zelda' } : null,
  taskReferenceResolver: (id: string) => id === 'F12',
  agendaReferenceResolver: (id: string) => id === 'A3',
  onTaskOpen: (id: string) => void window.__opened.push(`task:${id}`),
  onAgendaOpen: (id: string) => void window.__opened.push(`attention:${id}`),
  onNavigate: (to: string) => void window.__opened.push(`navigate:${to}`),
};

const href = (daemon: string, plugin: string, screen: string, search: Readonly<Record<string, string>> = {}) =>
  `/${daemon}/${plugin}/${screen}?${new URLSearchParams(search).toString()}`;

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
