/**
 * One ferret's chat header and Info side pane, drawn by the real `SessionTopBar`, `ChatCardChip`, `InfoPanel`
 * and `BoardSideTab` over a fake daemon (`board-chat-screenshot.ts` bundles this).
 *
 * `?state=card|none` picks a session with or without a focus card, and `?lanes=closed` collapses the lanes.
 */

import type { SessionView } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { SessionTopBar } from '../src/components/session-top-bar.tsx';
import { ChatCardChip } from '../src/features/board/chat-card-chip.tsx';
import { BoardSideTab } from '../src/features/board/board-side-tab.tsx';
import { InfoPanel } from '../src/features/session-info/info-panel.tsx';
import { INFO_TABS } from '../src/features/session-info/info-model.ts';
import { useChatCard } from '../src/hooks/use-chat-card.ts';
import { DaemonBoardStore } from '../src/lib/board-store.ts';
import { daemonBoardCardPath } from '../src/lib/pages/routes.ts';
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
const LEAD = 'mvuc7tsf-0c3d50df';
const OTTILIE = 'mvudnuly-ec442385';
const MARGOT = 'mvue2k3p-91ab77c0';
const CALLSIGNS = new Map([
  [LEAD, 'denisha'],
  [OTTILIE, 'ottilie'],
  [MARGOT, 'margot'],
]);

const session = (id: string, extra: Record<string, unknown> = {}): SessionView =>
  ({
    config: {
      id,
      name: `Session ${id}`,
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

const store = new DaemonBoardStore(
  fakePort({
    board: async () =>
      boardAnswer(OPEN, { projectId: PROJECT, laneSet: laneSetFor(), counts: { ...COUNTS, active: 3 } }),
    projects: async () => [{ id: PROJECT, name: 'Ferretry', path: null, laneSet: laneSetFor() }],
  }),
  fakeEnvironment(),
);

function Harness() {
  const chat = useChatCard({
    store,
    connection: laptop,
    machineName: 'laptop',
    session: lead,
    sessions: fleet,
    reading: true,
  });
  const compact = window.innerWidth < 640;
  const scope = { daemonId: laptop.daemonId, sessionId: LEAD };
  return (
    <div className="bg-bg text-fg" data-fixture={withCard ? 'card' : 'none'} style={{ minHeight: '100vh' }}>
      <SessionTopBar
        actions={
          <button className="kt-btn kt-btn--sm" type="button">
            Interrupt
          </button>
        }
        cardChip={
          chat === null ? null : (
            <ChatCardChip
              chip={chat.chip}
              href={chat.chip.kind === 'card' ? daemonBoardCardPath(laptop.daemonId, chat.chip.id) : ''}
              onNavigate={() => undefined}
            />
          )
        }
        compact={compact}
        infoOpen
        onToggleInfo={() => undefined}
        project="ferretry"
        session={lead}
        turn="working"
      />
      <div style={{ margin: compact ? '0' : '0 0 0 auto', maxWidth: compact ? 'none' : 460 }}>
        <InfoPanel
          name="Denisha"
          onClose={() => undefined}
          onTabChange={() => undefined}
          render={{
            overview: () => null,
            tasks: () =>
              chat === null ? null : (
                <BoardSideTab callsigns={CALLSIGNS} chat={chat} now={NOW} onNavigate={() => undefined} scope={scope} />
              ),
            runtime: () => null,
            usage: () => null,
            folder: () => null,
            signals: () => null,
            surfaces: () => null,
          }}
          tab={params.get('tab') === 'surfaces' ? 'surfaces' : 'tasks'}
          tabs={INFO_TABS}
        />
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Harness />);
