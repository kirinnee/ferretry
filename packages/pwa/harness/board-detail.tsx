/**
 * The Board's card detail, drawn by the real `BoardPage` with a card open over a fake daemon
 * (`board-detail-screenshot.ts` bundles this): a drawer beside the Board on a wide screen, a page of its own
 * on a phone.
 *
 * `?view=card|tested|ask|empty` picks the card: a card in review with a PR, children, dependencies, links and
 * history; a 🧪 To test card with the two verdict buttons; a card stopped by a blocking ask with answer buttons;
 * a brand-new card with nothing on it yet.
 * Nothing leaves the page.
 */

import type { AgendaItem } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { BoardPage } from '../src/features/board/board-page.tsx';
import { DaemonAgendaStore } from '../src/lib/agenda-store.ts';
import { DaemonBoardStore } from '../src/lib/board-store.ts';
import type { daemonSessionScope } from '../src/lib/daemon-scope.ts';
import {
  boardAnswer,
  card,
  COUNTS,
  fakeEnvironment,
  fakePort,
  laneSetFor,
  laptop,
  PROJECT,
} from '../tests/unit/board-support.ts';

const NOW = Date.parse('2026-10-23T09:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const DENISHA = 'mvuc7tsf-0c3d50df';
const OTTILIE = 'mvudnuly-ec442385';
const MARGOT = 'mvue2k3p-91ab77c0';
const CALLSIGNS = new Map([
  [DENISHA, 'denisha'],
  [OTTILIE, 'ottilie'],
  [MARGOT, 'margot'],
]);
const ferret = (sessionId: string) => ({ kind: 'ferret' as const, sessionId });
const owner = { kind: 'owner' as const };
const daemon = { kind: 'daemon' as const };

const SHA = 'a'.repeat(40);
const pr = (number: number, extra: Record<string, unknown> = {}) => ({
  url: `https://github.com/ferretry/ferretry/pull/${number}`,
  number,
  repo: 'ferretry/ferretry',
  state: 'open',
  draft: false,
  checks: 'passing',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: ago(5),
  ...extra,
});
const links = (
  prs: readonly Record<string, unknown>[],
  branch: string | null = null,
  docs: readonly string[] = [],
) => ({
  prs,
  branch,
  commits: [],
  docs,
});
const rollup = (children: number, active: number) => ({
  children,
  byCategory: { backlog: children - active, active, review: 0, shipped: 0, verify: 0, closed: 0 },
  active,
  lastTouchedAt: ago(20),
});

const ASK_REF = { sessionId: OTTILIE, id: 'A2' };
const BLOCKING_ASK = {
  id: 'A2',
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Which database should keep the board’s finished items across restarts?',
  title: 'Database for the board',
  why: 'The board forgets every finished item when the app restarts.',
  waitingSince: ago(9),
  howToResolve: 'Choose an option.',
  raisedBy: 'agent',
  raisedBySession: OTTILIE,
  raisedByName: 'ottilie',
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'SQLite', description: 'One file, no server.' },
      { label: 'Postgres', description: 'A server to run and patch.' },
    ],
  },
  questions: [
    {
      question: 'Which database should hold the board?',
      options: [
        { label: 'SQLite', description: 'One file, no server.' },
        { label: 'Postgres', description: 'A server to run and patch.' },
      ],
      recommended: 'SQLite',
    },
  ],
  kind: 'choice',
} as unknown as AgendaItem;

const REVIEW_CARD = card('F2', {
  createdAt: ago(900),
  title: 'Card detail drawer and page',
  laneId: 'review',
  owner: DENISHA,
  assignee: OTTILIE,
  summary: 'Open any card from the Board: its ask, asks waiting on you, children, links and history in one place.',
  ask: {
    text: '(sada, found live) Open a card to see everything about it, and act on it from there.',
    source: 'owner (board)',
  },
  clarifications: [
    { text: 'On a phone this is a full page, and Back must work.', source: 'owner (board)', at: ago(300), by: owner },
  ],
  premise: 'Today the owner reads a card in a terminal; the Board shows only a compact card.',
  context: 'The Board page (#972) is merged; this builds on its compact card and its move path.',
  terms: [
    { term: 'Card', meaning: 'The only record of a piece of work; it replaces the per-session task.' },
    { term: 'Lane', meaning: 'A stage on the way from backlog to closed.' },
  ],
  brief:
    'Side drawer over the Board on desktop. Full-screen page on a phone.\n\n- Sections fold\n- Asks answer in place',
  parent: { id: 'F1' },
  dependsOn: [{ task: { id: 'F5' }, until: 'released' }],
  blockedBy: [],
  blocks: [{ id: 'F9' }],
  links: links([pr(944, { checks: 'pending' })], 'feat/board-u12-card-detail', ['docs/reference-standard.md']),
  openAsks: [{ sessionId: OTTILIE, id: 'A9' }],
  rollup: rollup(2, 1),
  lastTouchedAt: ago(4),
  history: [
    { seq: 1, at: ago(900), actor: ferret(DENISHA), type: 'created', laneId: 'todo' },
    { seq: 2, at: ago(880), actor: ferret(DENISHA), type: 'assigned', from: null, to: OTTILIE },
    {
      seq: 3,
      at: ago(860),
      actor: ferret(OTTILIE),
      type: 'moved',
      from: 'todo',
      to: 'plan',
      backward: false,
      reason: null,
    },
    {
      seq: 4,
      at: ago(700),
      actor: ferret(OTTILIE),
      type: 'moved',
      from: 'plan',
      to: 'implement',
      backward: false,
      reason: null,
    },
    { seq: 5, at: ago(640), actor: ferret(OTTILIE), type: 'field-edited', field: 'summary' },
    { seq: 6, at: ago(630), actor: ferret(OTTILIE), type: 'field-edited', field: 'brief' },
    {
      seq: 7,
      at: ago(620),
      actor: ferret(OTTILIE),
      type: 'file-claimed',
      path: 'packages/pwa/src/features/board/detail/board-detail.tsx',
    },
    { seq: 8, at: ago(300), actor: owner, type: 'note', text: 'Looks good so far; keep the sections compact.' },
    {
      seq: 9,
      at: ago(120),
      actor: ferret(OTTILIE),
      type: 'moved',
      from: 'implement',
      to: 'plan',
      backward: true,
      reason: 'the brief changed, replanning the sections',
    },
    {
      seq: 10,
      at: ago(60),
      actor: daemon,
      type: 'moved',
      from: 'implement',
      to: 'review',
      backward: false,
      reason: null,
      auto: true,
      trigger: 'pr.opened',
    },
  ],
});

const TESTED_CARD = card('F10', {
  createdAt: ago(4000),
  title: 'Device tokens stay on host',
  laneId: 'tested',
  owner: DENISHA,
  assignee: MARGOT,
  summary: 'Pair a phone, then check Settings: no token is shown anywhere.',
  ask: { text: 'A paired device must never be able to read a token back.', source: `session:${DENISHA}` },
  links: links([
    pr(918, {
      state: 'merged',
      mergedAt: ago(2600),
      mergeSha: SHA,
      releasedIn: { version: '4.109.0', tag: '4.109.0', at: ago(1500) },
    }),
  ]),
  activity: 'idle',
  lastTouchedAt: ago(2200),
  history: [
    { seq: 1, at: ago(4000), actor: ferret(DENISHA), type: 'created', laneId: 'todo' },
    {
      seq: 2,
      at: ago(2200),
      actor: daemon,
      type: 'moved',
      from: 'released',
      to: 'tested',
      backward: false,
      reason: null,
      auto: true,
      trigger: 'release.running',
    },
  ],
});

const EMPTY_CARD = card('F11', {
  createdAt: ago(3),
  title: 'Try the new card page',
  laneId: 'todo',
  owner: DENISHA,
  assignee: null,
  summary: '',
  ask: { text: 'Make a card here and see how it reads.', source: 'owner (board)' },
  activity: 'idle',
  lastTouchedAt: ago(3),
  history: [{ seq: 1, at: ago(3), actor: owner, type: 'created', laneId: 'todo' }],
});

const WAITING_CARD = card('F8', {
  createdAt: ago(30),
  title: 'Choose the finished-items database',
  laneId: 'plan',
  owner: DENISHA,
  assignee: OTTILIE,
  summary: 'SQLite or Postgres: the ferret stopped to ask you.',
  ask: { text: 'Keep finished board items across restarts.', source: `session:${DENISHA}` },
  activity: 'waiting',
  openAsks: [ASK_REF],
  waitingOnOwner: [ASK_REF],
  lastTouchedAt: ago(9),
});

const BOARD_CARDS = [
  REVIEW_CARD,
  TESTED_CARD,
  WAITING_CARD,
  EMPTY_CARD,
  card('F1', { title: 'Board v2', laneId: 'implement', owner: DENISHA, rollup: rollup(4, 2), lastTouchedAt: ago(30) }),
  card('F3', {
    title: 'Detail: sections',
    laneId: 'implement',
    owner: DENISHA,
    parent: { id: 'F2' },
    assignee: OTTILIE,
    lastTouchedAt: ago(8),
  }),
  card('F4', {
    title: 'Detail: actions',
    laneId: 'todo',
    owner: DENISHA,
    parent: { id: 'F2' },
    lastTouchedAt: ago(200),
  }),
  card('F5', { title: 'Board page and compact cards', laneId: 'released', owner: DENISHA, lastTouchedAt: ago(500) }),
  card('F9', { title: 'Phone board with side pane', laneId: 'todo', owner: DENISHA, lastTouchedAt: ago(300) }),
];

const view = new URLSearchParams(window.location.search).get('view') ?? 'card';
const OPEN_ID = view === 'tested' ? 'F10' : view === 'ask' ? 'F8' : view === 'empty' ? 'F11' : 'F2';

const store = new DaemonBoardStore(
  fakePort({
    board: async () =>
      boardAnswer(BOARD_CARDS, {
        projectId: PROJECT,
        laneSet: laneSetFor(),
        counts: { ...COUNTS, active: 3, toTest: 1, waitingOnYou: 1 },
      }),
    task: async (_daemon, id) => {
      const task = BOARD_CARDS.find(candidate => candidate.id === id);
      return task === undefined ? null : { task, laneSet: laneSetFor() };
    },
    projects: async () => [{ id: PROJECT, name: 'Ferretry', path: null, laneSet: laneSetFor() }],
    // A move stays on its way, so an answer's spinner can be captured.
    act: async () => await new Promise<never>(() => undefined),
  }),
  fakeEnvironment(),
);

const agendaStore = new DaemonAgendaStore();
const agenda = {
  store: agendaStore,
  hydrate: async (connection: typeof laptop, scope: ReturnType<typeof daemonSessionScope>) => {
    agendaStore.applySnapshot(scope, {
      v: 1,
      sessionId: scope.sessionId,
      items: scope.sessionId === OTTILIE ? [BLOCKING_ASK] : [],
      resolved: [],
      count: scope.sessionId === OTTILIE ? 1 : 0,
      parseErrors: 0,
      updatedAt: ago(1),
    });
    void connection;
  },
  respond: async () => undefined,
};

function Harness() {
  const phone = window.innerWidth < 640;
  return (
    <div className="bg-bg text-fg" data-fixture={view} style={{ minHeight: '100vh' }}>
      <BoardPage
        agenda={agenda as never}
        callsigns={CALLSIGNS}
        phone={phone}
        machines={[{ connection: laptop, name: 'laptop' }]}
        now={NOW}
        onNavigate={() => undefined}
        onSearch={() => undefined}
        openCard={{ daemonId: laptop.daemonId, taskId: OPEN_ID }}
        ports={{
          sendMessage: async () => undefined,
          startFerret: async () => OTTILIE,
          sendBackFiles: async () => true,
          uploadAttachment: async (_daemon, _session, file) => ({
            id: `att_${'a'.repeat(64)}`,
            filename: file.name,
            mime: file.type,
            size: file.size,
            sha256: '0'.repeat(64),
            createdAt: ago(0),
          }),
        }}
        search=""
        store={store}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Harness />);
