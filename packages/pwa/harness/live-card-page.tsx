/**
 * A `card` block and a `board` block as a ferret writes them, drawn by the REAL chat renderer (`ChatProse`) and the
 * REAL agenda renderer (`agendaProse`) over a REAL `DaemonBoardStore` that reads an invented board. `?scene=`:
 * `chat` (a message with a card and a mini board), `agenda` (an agenda body with a parent's children grouped by lane),
 * `error` (a card that does not exist and one that cannot be read). `window.__moveCard()` moves a card the way the
 * fleet feed does, by telling the store a `board.changed` arrived; no timer is involved.
 */

import { createRoot } from 'react-dom/client';
import { agendaProse } from '../src/features/agenda/agenda-prose.tsx';
import { ChatProse } from '../src/components/chat-prose.tsx';
import { ReferenceSurfaceProvider } from '../src/components/reference-surface.tsx';
import { DaemonBoardStore } from '../src/lib/board-store.ts';
import { boardAnswer, card, laneSetFor, laptop, PROJECT } from '../tests/unit/board-support.ts';

const PR = {
  url: 'https://github.com/kirinnee/ferretry/pull/321',
  number: 321,
  repo: 'kirinnee/ferretry',
  state: 'open',
  draft: false,
  checks: 'passing',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: '2026-08-01T10:00:00.000Z',
} as const;

const cards = new Map([
  [
    'F412',
    card('F412', {
      title: 'Live cards in chat',
      laneId: 'implement',
      links: { prs: [PR], branch: null, commits: [], docs: [] },
      rollup: {
        children: 3,
        byCategory: { backlog: 1, active: 1, review: 0, shipped: 1, verify: 0, closed: 0 },
        active: 1,
        lastTouchedAt: null,
      },
    }),
  ],
  ['F413', card('F413', { title: 'Parse card and board', parent: { id: 'F412' }, laneId: 'merged' })],
  ['F414', card('F414', { title: 'Draw the real card', parent: { id: 'F412' }, laneId: 'implement' })],
  ['F415', card('F415', { title: 'Teach the prompt line', parent: { id: 'F412' }, laneId: 'todo' })],
  ['F420', card('F420', { title: 'Relay directory discovery', laneId: 'review' })],
]);

const lanes = laneSetFor();
const store = new DaemonBoardStore({
  board: async () => boardAnswer([...cards.values()], { projectId: PROJECT, laneSet: lanes }),
  task: async (_daemon, id) => {
    if (id === 'F500') throw new Error('unreadable');
    const task = cards.get(id);
    return task === undefined ? null : { task, laneSet: lanes };
  },
  ids: async () => null,
  projects: async () => null,
  version: async () => '4.110.0',
  lanes: async () => {
    throw new Error('not served');
  },
  act: async () => {
    throw new Error('not served');
  },
  create: async () => {
    throw new Error('not served');
  },
  start: async () => {
    throw new Error('not served');
  },
});

const surface = { cardEmbed: { store, connection: laptop }, onTaskOpen: () => undefined };
const block = (type: string, alt: string, payload: string) =>
  ['```fy-render', `type: ${type}`, `alt: ${alt}`, '---', payload, '```'].join('\n');

const CHAT = [
  'The card for this work is live below, and so are the pieces under it. They move on their own as the work does.',
  '',
  block('card', 'F412, the work this chat is about', '&F412'),
  '',
  block('board', 'Two cards to look at next', '&F420\n&F414'),
].join('\n');
const AGENDA = [
  'The sub-cards of &F412 by lane. Nothing needs you; this is where each piece stands.',
  '',
  block('board', 'Pieces of F412 by lane', 'parent: &F412'),
].join('\n');
const ERROR = [
  'Two cards I was asked to show:',
  '',
  block('card', 'A card that does not exist', '&F999'),
  '',
  block('card', 'A card that cannot be read', '&F500'),
].join('\n');

const scene = new URLSearchParams(location.search).get('scene') ?? 'chat';
const prose = agendaProse();

declare global {
  interface Window {
    __moveCard: () => void;
  }
}
window.__moveCard = () => {
  cards.set('F412', card('F412', { ...cards.get('F412'), laneId: 'review' }));
  cards.set('F414', card('F414', { title: 'Draw the real card', parent: { id: 'F412' }, laneId: 'review' }));
  cards.set('F415', card('F415', { title: 'Teach the prompt line', parent: { id: 'F412' }, laneId: 'implement' }));
  store.noteEvent(laptop.daemonId, {
    type: 'board.changed',
    data: { projectId: PROJECT, taskIds: ['F412', 'F414', 'F415'] },
  });
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <ReferenceSurfaceProvider surface={surface}>
    <main data-fixture style={{ maxWidth: 640, margin: '0 auto', padding: 16 }}>
      {scene === 'agenda' ? (
        <section className="rounded-lg border border-border bg-surface p-4" data-scene="agenda">
          {prose(AGENDA)}
        </section>
      ) : (
        <div data-scene={scene}>
          <ChatProse text={scene === 'error' ? ERROR : CHAT} />
        </div>
      )}
    </main>
  </ReferenceSurfaceProvider>,
);
