/**
 * One ferret's chat header and Info side pane, drawn by the real `SessionTopBar`, `InfoPanel`
 * and `BoardSideTab` over a fake daemon (`board-chat-screenshot.ts` bundles this).
 *
 * `?state=card|none` picks a session with or without a focus card, `?view=cards|kanban|list` the Tasks view (Kanban when
 * not given), `?totest=1` adds two cards waiting for a try (the moves the page is asked for are kept in `window.__moves`), `?cards=few`
 * the six-card fixture (the default is 70 cards), `?agents=1` turns "Internal" on, `?expanded=1` opens the
 * Tasks tab over the whole chat area (the desktop Info panel steps out of the way). `?origin=0` serves cards
 * the way an older daemon does, with no `origin`.
 */

import { type BoardTaskView, boardOk, type SessionView } from '@ferretry/protocol';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionTopBar } from '../src/components/session-top-bar.tsx';
import { ChatTasks } from '../src/features/board/chat-tasks.tsx';
import { InfoPanel } from '../src/features/session-info/info-panel.tsx';
import { INFO_TABS } from '../src/features/session-info/info-model.ts';
import { useChatCard } from '../src/hooks/use-chat-card.ts';
import { DaemonAgendaStore } from '../src/lib/agenda-store.ts';
import type { ChatTasksView } from '../src/lib/board-chat-url.ts';
import { boardSideView } from '../src/lib/board-side-view.ts';
import { DaemonBoardStore } from '../src/lib/board-store.ts';
import {
  boardAnswer,
  card,
  COUNTS,
  fakeEnvironment,
  fakePort,
  laneSetFor,
  laptop,
  originCard,
  PROJECT,
} from '../tests/unit/board-support.ts';

const NOW = Date.parse('2026-10-23T09:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const LEAD = 'mvuc7tsf-0c3d50df';
const OTTILIE = 'mvudnuly-ec442385';
const MARGOT = 'mvue2k3p-91ab77c0';
const CALLSIGNS = new Map([
  [LEAD, 'denisha'],
  [OTTILIE, 'ottilie'],
  [MARGOT, 'margot'],
]);

const NAMES: Readonly<Record<string, string>> = {
  [LEAD]: 'Board System Design',
  [OTTILIE]: 'Per-chat card tab',
  [MARGOT]: 'Header chip states',
};

const session = (id: string, extra: Record<string, unknown> = {}): SessionView =>
  ({
    config: {
      id,
      name: NAMES[id] ?? id,
      agent: 'claude-work',
      harness: 'claude',
      modelHint: 'claude-opus-5-5',
      mode: 'auto',
      cwd: '/home/kirin/Workspace/personal/ferretry',
      createdAt: '2026-10-23T02:00:00.000Z',
      updatedAt: '2026-10-23T02:00:00.000Z',
      boardAccess: 'none',
      projectId: PROJECT,
      ...extra,
    },
    state: { id, status: 'running', turn: 1, lastActivityAt: '2026-10-23T08:55:00.000Z', turnState: 'working' },
    directory: `/state/${id}`,
  }) as unknown as SessionView;

const params = new URLSearchParams(window.location.search);
const withCard = params.get('state') !== 'none';
const lead = session(LEAD, {
  teammate: 'denisha',
  label: 'Board: per-chat card view',
  ...(withCard ? { focusTask: { id: 'F18' } } : {}),
});
const fleet = [
  lead,
  session(OTTILIE, { teammate: 'ottilie', parent: LEAD }),
  session(MARGOT, { teammate: 'margot', parent: OTTILIE }),
];

const OPEN = [
  card('F18', {
    title: 'Board system',
    laneId: 'plan',
    owner: LEAD,
    summary: 'Cards, lanes and a page to move them on.',
    brief:
      '1. Cards and lanes live in one board per project.\n2. A gate lane stops a card until the owner answers.\n3. The task panel shows only the cards waiting on you.',
    lastTouchedAt: ago(3),
  }),
  card('C20', {
    title: 'Docs: how the board reads',
    laneId: 'todo',
    owner: LEAD,
    kind: 'chore',
    lastTouchedAt: ago(60 * 5),
    activity: 'idle',
  }),
  card('B21', {
    title: 'Retry a failed card move',
    laneId: 'review',
    owner: LEAD,
    kind: 'bug',
    lastTouchedAt: ago(45),
  }),
  card('F22', {
    title: 'Per-chat card tab',
    laneId: 'implement',
    owner: LEAD,
    assignee: OTTILIE,
    parent: { id: 'F18' },
    lastTouchedAt: ago(8),
  }),
  card('F23', {
    title: 'Header chip states',
    laneId: 'implement',
    owner: OTTILIE,
    assignee: MARGOT,
    parent: { id: 'F22' },
    lastTouchedAt: ago(60 * 40),
    activity: 'stale',
  }),
  card('F24', {
    title: 'Choose the chip wording',
    laneId: 'plan',
    owner: MARGOT,
    parent: { id: 'F22' },
    activity: 'waiting',
    waitingOnOwner: [{ sessionId: LEAD, id: 'A7' }],
    openAsks: [{ sessionId: LEAD, id: 'A7' }],
    lastTouchedAt: ago(30),
  }),
  card('F99', { title: 'Someone else’s card', laneId: 'implement', owner: 'mvzzzzzz-00000000', lastTouchedAt: ago(5) }),
];

const SHIPPED = { version: '5.4.0', tag: 'v5.4.0', at: ago(60) };
const TO_TEST =
  params.get('totest') === '1'
    ? [
        card('F30', {
          title: 'Pair a second phone',
          laneId: 'tested',
          owner: LEAD,
          shippedIn: SHIPPED,
          howToTest:
            '1. Open Settings and choose Pair a device.\n2. Scan the code from a second phone.\n3. Check both phones show in Devices.',
          lastTouchedAt: ago(55),
        }),
        card('F31', {
          title: 'Faster board loading',
          laneId: 'tested',
          owner: LEAD,
          shippedIn: { ...SHIPPED, version: '5.3.2', tag: 'v5.3.2', at: ago(60 * 26) },
          howToTest: '1. Open the Board on a phone.\n2. It should draw in under a second.',
          lastTouchedAt: ago(60 * 25),
        }),
      ]
    : [];

const TITLES = [
  'Retry a failed move',
  'Drawer opens wrong card',
  'Pair a second phone',
  'Relay fallback copy',
  'Show lane in footer',
  'Keyboard move between lanes',
  'Daemon returns 502',
  'Dark contrast on counts',
  'Release notes for 0.14',
  'Archive search is slow',
  'Sub-ferret cards hidden',
  'Rename Attention to Agenda',
  'Warden remedy needs reason',
  'Terminal loses focus',
  'Stale badge is wrong',
  'Move Done into footer',
  'Add a project picker',
  'Explain Not good',
  'Fix flaky relay test',
  'Document the grant model',
];
const LANES = ['todo', 'plan', 'implement', 'implement', 'review', 'merged', 'released', 'tested', 'tested', 'closed'];
const OWNERS = [LEAD, LEAD, LEAD, OTTILIE, OTTILIE, MARGOT];
const kindOf = (index: number) => (index % 5 === 0 ? 'bug' : index % 7 === 0 ? 'chore' : 'feature');
const PREFIX = { bug: 'B', chore: 'C', feature: 'F' } as const;
const MANY = Array.from({ length: 64 }, (_, index) =>
  card(`${PREFIX[kindOf(index)]}${100 + index}`, {
    title: `${TITLES[index % TITLES.length]}${index >= TITLES.length ? ` (${Math.floor(index / TITLES.length) + 1})` : ''}`,
    laneId: LANES[(index * 7) % LANES.length] ?? 'todo',
    owner: OWNERS[index % OWNERS.length] ?? LEAD,
    kind: kindOf(index),
    lastTouchedAt: ago(3 + ((index * 37) % 4000)),
    ...(index % 11 === 0 ? { activity: 'stale' } : {}),
  }),
);
const FEW = params.get('cards') === 'few';
const ORIGIN = params.get('origin') !== '0';
const originOf = (task: BoardTaskView, index: number): BoardTaskView => {
  if (!ORIGIN) return task;
  const human = task.owner === LEAD && task.id !== 'F22' && index % 3 !== 2;
  return originCard(
    task.id,
    human ? 'human' : 'agent',
    human ? undefined : task.owner === LEAD ? { id: 'F18' } : null,
    task,
  );
};
const CARDS = [...(FEW ? OPEN : [...OPEN, ...MANY]), ...TO_TEST].map(originOf);

const store = new DaemonBoardStore(
  fakePort({
    board: async () =>
      boardAnswer(CARDS, { projectId: PROJECT, laneSet: laneSetFor(), counts: { ...COUNTS, active: 3 } }),
    task: async (_daemon, id) => {
      const task = CARDS.find(candidate => candidate.id === id);
      return task === undefined ? null : { task, laneSet: laneSetFor() };
    },
    projects: async () => [{ id: PROJECT, name: 'Ferretry', path: null, laneSet: laneSetFor() }],
  }),
  fakeEnvironment(),
);

(window as unknown as { __moves: unknown[] }).__moves = [];
store.act = async (_daemon, id, request) => {
  (window as unknown as { __moves: unknown[] }).__moves.push({ id, to: (request as { to?: string }).to });
  return boardOk(card(id));
};

const agendaStore = new DaemonAgendaStore();
const agenda = {
  store: agendaStore,
  hydrate: async (_daemon: unknown, scope: { readonly sessionId: string }) => {
    agendaStore.applySnapshot(scope as never, {
      v: 1,
      sessionId: scope.sessionId,
      items: [],
      resolved: [],
      count: 0,
      parseErrors: 0,
      updatedAt: ago(1),
    });
  },
  respond: async () => undefined,
};
const requested = params.get('view');
boardSideView.set(requested === 'list' || requested === 'cards' ? requested : 'kanban');

function Harness() {
  const [expanded, setExpanded] = useState(params.get('expanded') === '1');
  const [agents, setAgents] = useState(params.get('agents') === '1');
  const tasks: ChatTasksView = { expanded, agents, setExpanded, setAgents };
  const chat = useChatCard({
    store,
    connection: laptop,
    machineName: 'laptop',
    session: lead,
    sessions: fleet,
    reading: true,
    agents,
  });
  const compact = window.innerWidth < 640;
  const scope = { daemonId: laptop.daemonId, sessionId: LEAD };
  const tab = params.get('tab') === 'surfaces' ? 'surfaces' : 'tasks';
  const board = (isExpanded: boolean) =>
    chat === null ? null : (
      <ChatTasks
        agenda={agenda as never}
        callsigns={CALLSIGNS}
        chat={chat}
        expanded={isExpanded}
        machine={{ connection: laptop, name: 'laptop' }}
        now={NOW}
        onAgents={tasks.setAgents}
        onExpand={() => tasks.setExpanded(!isExpanded)}
        phone={compact}
        ports={{ sendMessage: async () => undefined }}
        scope={scope}
        store={store}
        taskNames={new Map(Object.entries(NAMES))}
      />
    );
  const info = (
    <InfoPanel
      name="Denisha"
      onClose={() => undefined}
      onTabChange={() => undefined}
      render={{
        overview: () => null,
        tasks: () => board(false),
        runtime: () => null,
        usage: () => null,
        folder: () => null,
        surfaces: () => null,
      }}
      tab={tab}
      tabs={INFO_TABS}
    />
  );
  return (
    <div className="bg-bg text-fg" data-fixture={withCard ? 'card' : 'none'} style={{ minHeight: '100vh' }}>
      <SessionTopBar
        actions={
          <button className="kt-btn kt-btn--sm" type="button">
            Interrupt
          </button>
        }
        compact={compact}
        infoOpen
        onToggleInfo={() => undefined}
        session={lead}
        turn="working"
      />
      {expanded ? (
        <div style={{ display: 'flex', height: 'calc(100vh - 56px)' }}>
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-chat-tasks-full="">
            <div className="flex-1 p-4 text-muted" inert>
              The conversation sits under the board.
            </div>
            <section aria-label="Tasks" className="fy-board-full" data-board-full="">
              {board(true)}
            </section>
          </div>
        </div>
      ) : (
        <div style={{ margin: compact ? '0' : '0 0 0 auto', maxWidth: compact ? 'none' : 460 }}>{info}</div>
      )}
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Harness />);
