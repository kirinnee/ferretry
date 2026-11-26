/**
 * The browser entry for "a stepped mermaid diagram in an old message keeps its steps and captions" (U1 review, item 3): the REAL
 * `Transcript` over one fake assistant message holding a stepped diagram (three `%% @step` lines) and a plain one.
 *
 *   ?theme=<family>-<mode>
 *
 * The diagram's own sandbox (the opaque-origin frame the chat lends through `fences.draw`) is not what changed and is not in the
 * scene: its door is stood in for by one that returns the picture of the source it was given (a box per name, an arrow per `-->`), as
 * the `<img>` the real door ends in, so what is measured is the stepper around it: captions, controls, the stage that keeps its height.
 * `window.__asked` records every source the door was asked to draw.
 */

import { ReferenceSurfaceProvider } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';
import { Transcript } from '../../../../app/chat/transcript.tsx';

declare global {
  interface Window {
    __asked: string[];
  }
}
window.__asked = [];

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') ?? 'studio-light';
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.mode = theme.endsWith('dark') ? 'dark' : 'light';

const FENCE = '`'.repeat(3);

const MESSAGE = [
  '## How a request travels',
  '',
  'Written for an older Ferretry, so the diagram builds up one arrow at a time:',
  '',
  `${FENCE}mermaid`,
  'flowchart LR',
  '%% @step The browser asks the daemon',
  '  Browser --> Daemon',
  '%% @step The daemon asks the relay when the browser is far away',
  '  Daemon --> Relay',
  '%% @step The relay answers the browser, and the story ends',
  '  Relay --> Browser',
  FENCE,
  '',
  'And one with no steps:',
  '',
  `${FENCE}mermaid`,
  'flowchart LR',
  '  Plan --> Build',
  FENCE,
].join('\n');

const entries: readonly TranscriptEntry[] = [
  { id: 'u1', kind: 'user', text: 'How does a request travel?' },
  { id: 'a1', kind: 'assistant', text: MESSAGE },
];

/** The picture of a source: one box per name, left to right, one arrow per `A --> B` line. */
function pictureOf(source: string): string {
  const names: string[] = [];
  const edges: [string, string][] = [];
  for (const line of source.split('\n')) {
    const edge = /^\s*(\w+)\s*-->\s*(\w+)\s*$/u.exec(line);
    if (edge === null) continue;
    const [, from = '', to = ''] = edge;
    for (const name of [from, to]) if (!names.includes(name)) names.push(name);
    edges.push([from, to]);
  }
  const at = (name: string): number => 20 + names.indexOf(name) * 130;
  const boxes = names
    .map(
      name =>
        `<rect x="${at(name)}" y="20" width="100" height="36" rx="8" fill="#2b5cff"/><text x="${at(name) + 50}" y="43" font-family="sans-serif" font-size="14" text-anchor="middle" fill="#fff">${name}</text>`,
    )
    .join('');
  const arrows = edges
    .map(([from, to]) => {
      const forward = names.indexOf(to) > names.indexOf(from);
      const start = at(from) + (forward ? 100 : 0);
      const end = at(to) + (forward ? 0 : 100);
      return `<path d="M${start} ${forward ? 38 : 50} L${end} ${forward ? 38 : 50}" stroke="#2b5cff" stroke-width="2" fill="none"/>`;
    })
    .join('');
  const width = 40 + names.length * 130;
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 80" width="${width}" height="80">${boxes}${arrows}</svg>`)}`;
}

const surface = {
  fences: {
    draw: ({
      node,
    }: {
      readonly node?: { readonly children?: readonly { readonly children?: readonly { readonly value?: string }[] }[] };
    }) => {
      const body = (node?.children?.[0]?.children?.[0]?.value ?? '').replace(/\n$/u, '');
      window.__asked.push(body);
      const [, alt = '', , ...source] = body.split('\n');
      return <img alt={alt.replace(/^alt: /u, '')} src={pictureOf(source.join('\n'))} style={{ maxWidth: '100%' }} />;
    },
  },
};

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <ReferenceSurfaceProvider surface={surface as never}>
      <div className="kt-chat-surface scene-chat">
        <div className="fy-chat-log">
          <div className="fy-chat-log__messages">
            <Transcript agentName="Zoe" daemonId="d" entries={entries} sessionId="s" />
          </div>
        </div>
      </div>
    </ReferenceSurfaceProvider>,
  );
