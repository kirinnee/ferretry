/**
 * The browser entry for "the board and a card's Agenda asks": the REAL `BoardPage` over fake data, with the card the
 * address names (`/d/<id>/board/F3`) open as a drawer, or as a page on a phone.
 *
 *   ?theme=<family>-<mode>
 *   ?open=F3|none      the card the address names (default F3)
 */

import { createRoot } from 'react-dom/client';
import { DaemonBoardStore } from '../../../../app/lib/board-store.ts';
import { BoardPage } from '../../../../app/views/board-page.tsx';
import { THIS_MACHINE } from '../../../../app/lib/machine.ts';
import { boardAnswer, card, fakeEnvironment, fakePort, laneSetFor, PROJECT } from '../../../unit/app/board-support.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const LEAD = 'mvuc7tsf-0c3d50df';
const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const cards = [
  card('F3', {
    title: 'Rich CI cache summary',
    laneId: 'plan',
    owner: LEAD,
    openAsks: [{ ferret: LEAD, id: 'A6' }],
    premise: 'The CI summary lists every cache miss.',
    context: '- The cache key hashes the lockfile.',
    ask: { text: 'Show cache hits and misses in the CI summary', source: `session:${LEAD}` },
  }),
  card('F4', { title: 'Release notes for 4.111', laneId: 'implement', owner: LEAD }),
  card('F5', { title: 'Retire the old inbox route', laneId: 'review', owner: LEAD }),
  card('F6', { title: 'Lane editor copy', laneId: 'todo', owner: LEAD }),
];

const agenda = {
  items: [
    {
      id: 'A6',
      title: 'OK to build? Rich CI cache summary',
      subject: 'OK to build? Rich CI cache summary',
      blockingNow: true,
    },
  ],
  resolved: [
    {
      id: 'A2',
      title: 'Which cache layout?',
      subject: 'Which cache layout?',
      task: { id: 'F3' },
      resolvedAt: '2026-08-01T09:00:00.000Z',
      disposition: 'done',
      resolutionNote: 'Per-job layout',
    },
  ],
} as never;

const store = new DaemonBoardStore(
  fakePort({
    board: async () => boardAnswer(cards, { laneSet: laneSetFor(), projectId: PROJECT }),
    card: async (_daemon, id) => {
      const found = cards.find(entry => entry.id === id);
      return found === undefined ? null : { card: found, laneSet: laneSetFor() };
    },
    agenda: async () => agenda,
  }),
  fakeEnvironment(),
);

const open = params.get('open') ?? 'F3';
const phone = window.innerWidth < 700;

createRoot(document.getElementById('root') as HTMLElement).render(
  <BoardPage
    callsigns={new Map([[LEAD, 'Denisha']])}
    machines={[{ connection: THIS_MACHINE, name: 'This machine' }]}
    now={NOW}
    onNavigate={() => undefined}
    onSearch={() => undefined}
    openCard={open === 'none' ? null : { daemonId: THIS_MACHINE.daemonId, taskId: open }}
    phone={phone}
    search=""
    store={store}
  />,
);
