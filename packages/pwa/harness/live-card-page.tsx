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
import { DaemonFleetStore } from '../src/lib/fleet-store.ts';
import { type AppStore, StoreProvider } from '../src/lib/store.tsx';
import { sessionView } from '../tests/support/sessions.ts';
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
  polledAt: new Date().toISOString(),
} as const;

const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const NIMBUS = 'mvuc7tsf-0c3d50df';
const EMBER = 'mvudnuly-ec442385';

// The ferret names come the way production gets them: the app's fleet, through `useFerretCallsigns`.
const fleet = new DaemonFleetStore({ list: async () => [], get: async () => sessionView(NIMBUS) });
fleet.seed(
  laptop,
  [sessionView(NIMBUS, { config: { teammate: 'nimbus' } }), sessionView(EMBER, { config: { teammate: 'ember' } })],
  Date.now(),
);
const appStore = { fleet } as unknown as AppStore;

const CATEGORY: Record<string, 'backlog' | 'active' | 'review' | 'shipped'> = {
  todo: 'backlog',
  implement: 'active',
  review: 'review',
  merged: 'shipped',
};
const KIDS = ['F413', 'F414', 'F415'] as const;
const rollupOf = (lastTouchedAt: string) => {
  const byCategory = { backlog: 0, active: 0, review: 0, shipped: 0, verify: 0, closed: 0 };
  for (const id of KIDS) byCategory[CATEGORY[cards.get(id)?.laneId ?? 'todo'] ?? 'backlog'] += 1;
  return { children: KIDS.length, byCategory, active: byCategory.active, lastTouchedAt };
};
const child = (id: string, title: string, laneId: string, touchedAgo: number, assignee: string | null) =>
  card(id, { title, parent: { id: 'F412' }, laneId, assignee, owner: NIMBUS, lastTouchedAt: ago(touchedAgo) });

const cards = new Map<string, ReturnType<typeof card>>([
  [
    'F412',
    card('F412', {
      title: 'Live cards in chat',
      laneId: 'implement',
      owner: NIMBUS,
      lastTouchedAt: ago(4 * MINUTE),
      links: { prs: [PR], branch: null, commits: [], docs: [] },
    }),
  ],
  ['F413', child('F413', 'Parse card and board', 'merged', 3 * 24 * 60 * MINUTE, EMBER)],
  ['F414', child('F414', 'Draw the real card', 'implement', 2 * 60 * MINUTE, NIMBUS)],
  ['F415', child('F415', 'Teach the prompt line', 'todo', 3 * 24 * 60 * MINUTE, null)],
  [
    'F420',
    card('F420', {
      title: 'Relay directory discovery',
      laneId: 'review',
      owner: EMBER,
      lastTouchedAt: ago(35 * MINUTE),
    }),
  ],
]);
const withRollup = () => cards.set('F412', card('F412', { ...cards.get('F412'), rollup: rollupOf(ago(MINUTE)) }));
withRollup();

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
  block('board', 'Three cards to look at next', '&F415\n&F420\n&F414'),
].join('\n');
const AGENDA = [
  'The sub-cards of &F412 by lane. Nothing needs you; this is where each piece stands.',
  '',
  block('card', 'F412, the parent', '&F412'),
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
  cards.set('F414', child('F414', 'Draw the real card', 'review', MINUTE, NIMBUS));
  cards.set('F415', child('F415', 'Teach the prompt line', 'implement', MINUTE, EMBER));
  cards.set('F412', card('F412', { ...cards.get('F412'), laneId: 'review', lastTouchedAt: ago(MINUTE) }));
  withRollup();
  store.noteEvent(laptop.daemonId, {
    type: 'board.changed',
    data: { projectId: PROJECT, taskIds: ['F412', 'F414', 'F415'] },
  });
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <StoreProvider store={appStore}>
    <ReferenceSurfaceProvider surface={surface}>
      <main data-fixture style={{ maxWidth: 640, margin: '0 auto', padding: 16 }}>
        {scene === 'agenda' ? (
          <section
            className="fy-attn-sec fy-attn-sec--open rounded-lg border border-border bg-surface p-4"
            data-scene="agenda"
          >
            <div className="fy-attn-sec__body">{prose(AGENDA)}</div>
          </section>
        ) : (
          <div data-scene={scene}>
            <ChatProse text={scene === 'error' ? ERROR : CHAT} />
          </div>
        )}
      </main>
    </ReferenceSurfaceProvider>
  </StoreProvider>,
);
