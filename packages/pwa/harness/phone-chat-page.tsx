/**
 * THE OWNER'S PHONE, 2026-10-30: the REAL `SessionChatPage` (not a stand-in transcript) with a long conversation,
 * an agenda item open from a `!A55` link, and the ferret's card chip in the header (`phone-chat-screenshot.ts`
 * bundles and drives this).
 *
 *   ?agenda=A55   the item is open on arrival (a `!A55` link, a notification tap)
 *   ?turn=idle    the ferret is waiting on the owner instead of working
 *
 * The stand-in transcript the agenda harness draws carried its own `grid-area: 1 / 1`, so that harness stayed green
 * while the real transcript fell into a second grid row: the item view was squeezed to nothing and the inert
 * conversation could not be scrolled or tapped. This page is the real one so that cannot happen twice.
 */

import type { AgendaId, AgendaItem, AgendaSnapshot, SessionView } from '@ferretry/protocol';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionSearchProvider } from '../src/features/session-search/session-search.tsx';
import { useAppViewport } from '../src/hooks/use-app-viewport.ts';
import { useLayoutMode } from '../src/hooks/use-layout-mode.ts';
import { DaemonAgendaClient } from '../src/lib/agenda-client.ts';
import { agendaTargetFromSearch } from '../src/lib/agenda-inbox.ts';
import { DaemonBoardStore } from '../src/lib/board-store.ts';
import { daemonSessionScope } from '../src/lib/daemon-scope.ts';
import type { SessionChatClient } from '../src/lib/pages/session-chat-page.tsx';
import { SessionChatPage } from '../src/lib/pages/session-chat-page.tsx';
import type { TranscriptEntry } from '../src/lib/session-screens.ts';
import { DEFAULT_STT_SETTINGS } from '../src/lib/stt/stt-settings.ts';
import {
  boardAnswer,
  COUNTS,
  card,
  fakeEnvironment,
  fakePort,
  laneSetFor,
  laptop,
  PROJECT,
} from '../tests/unit/board-support.ts';

const NOW = Date.parse('2026-10-30T06:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const ID = 'mvgt2oz9-04e28935';
const params = new URLSearchParams(window.location.search);
const idle = params.get('turn') === 'idle';
const withInfo = params.get('info');
const alone = params.has('alone');

const A55 = {
  id: 'A55',
  source: 'agent-raised',
  sourceRef: null,
  title: 'Update your Mac to 4.119.1',
  subject: 'Update your Mac to 4.119.1 with fy daemon update --yes',
  why: 'Today’s daemon fixes only reach your Mac once it runs the new release.',
  waitingSince: ago(90),
  howToResolve: 'Run fy daemon update --yes on the Mac, then say done.',
  raisedBy: 'agent',
  raisedBySession: ID,
  raisedByName: 'lizzette',
  ask: { kind: 'multiple-choice', options: [{ label: 'Done' }, { label: 'Later' }] },
  answers: [
    { direction: 'right', does: 'choose', label: 'Done' },
    { direction: 'left', does: 'choose', label: 'Later' },
  ],
} as unknown as AgendaItem;

const SNAPSHOT: AgendaSnapshot = {
  v: 1,
  sessionId: ID,
  items: [A55],
  resolved: [],
  count: 1,
  parseErrors: 0,
  updatedAt: ago(1),
} as unknown as AgendaSnapshot;

const SESSION = {
  config: {
    id: ID,
    name: 'Ferretry lead',
    teammate: 'lizzette',
    agent: 'claude-work',
    harness: 'claude',
    modelHint: 'claude-opus-5-5',
    mode: 'auto',
    cwd: '/home/kirin/Workspace/personal/ferretry',
    createdAt: ago(600),
    updatedAt: ago(600),
    boardAccess: 'none',
    projectId: PROJECT,
    focusTask: { id: 'F11' },
  },
  state: {
    id: ID,
    status: 'running',
    turn: 40,
    startedAt: ago(600),
    lastActivityAt: ago(1),
    turnState: idle ? 'your-turn' : 'working',
    turnStateAt: ago(2),
    promptReady: idle,
    agenda: { open: 1, first: 'A55', ask: A55.subject, latestAt: ago(90), agendaMode: true },
  },
  directory: '/home/kirin/Workspace/personal/ferretry',
  outdated: { sections: ['pack'] },
} as unknown as SessionView;

const CHILD_STATES = [
  'working',
  'working',
  'working',
  'working',
  'working',
  'working',
  'done',
  'done',
  'done',
] as const;
/** Nine sub-ferrets the lead started (six at work, three done): the owner's "9 sub-ferrets" header. */
const CHILDREN: readonly SessionView[] = alone
  ? []
  : CHILD_STATES.map((state, index) => {
      const base = SESSION as unknown as { config: object; state: object };
      return {
        ...base,
        config: {
          ...base.config,
          id: `child-${index}`,
          name: `Unit ${index + 1}`,
          teammate: `sub${index + 1}`,
          parent: ID,
          focusTask: undefined,
          createdAt: ago(300 - index),
        },
        state: {
          ...base.state,
          id: `child-${index}`,
          status: state === 'done' ? 'stopped' : 'running',
          turnState: state === 'done' ? 'your-turn' : 'working',
          promptReady: state === 'done',
          agenda: undefined,
        },
      } as unknown as SessionView;
    });

const LINES = [
  'Picked up the daemon problems from this morning and split them across the pack.',
  'The tmux crash was a stale socket path after a restart; the fix re-reads it on every attach.',
  'The launch jam behind app reconnects was one lock held across a network call.',
  'Ferrets stuck at "starting" were waiting on a probe that never answered; it now times out.',
  'The login-scan CPU burn was a watcher on the whole home folder. It watches the three files it needs now.',
  'The polling storm came from every open tab asking for the fleet on its own; they share one feed.',
];
const ENTRIES: readonly TranscriptEntry[] = Array.from({ length: 36 }, (_, index): TranscriptEntry => {
  const mine = index % 3 === 0;
  return {
    id: `line-${index}`,
    kind: mine ? 'user' : 'assistant',
    label: mine ? 'You' : 'Lizzette',
    text: mine
      ? `Status on item ${index / 3 + 1}?`
      : `${LINES[index % LINES.length]}\n\n- checked on the Mac\n- checked on the box\n- released in 4.12${index % 7}.0`,
  } as TranscriptEntry;
}).concat([
  {
    id: 'last',
    kind: 'assistant',
    label: 'Lizzette',
    text: 'Next steps:\n\n- **You:** update your Mac to **4.124.0** with `fy daemon update --yes` (!A55).\n- **Me:** report the import check once it lands.',
  } as TranscriptEntry,
]);

const board = new DaemonBoardStore(
  fakePort({
    board: async () =>
      boardAnswer(
        [
          card('F11', {
            title: 'Daemon morning fixes',
            laneId: 'implement',
            owner: ID,
            lastTouchedAt: ago(3),
          }),
        ],
        { projectId: PROJECT, laneSet: laneSetFor(), counts: { ...COUNTS, active: 1 } },
      ),
    projects: async () => [{ id: PROJECT, name: 'Ferretry', path: null, laneSet: laneSetFor() }],
  }),
  fakeEnvironment(),
);

const noop = async (): Promise<void> => undefined;
const AGENDA_CLIENT = {
  respond: noop,
  resolve: noop,
  dismiss: noop,
  needsInfo: noop,
  discuss: noop,
  snooze: noop,
  unsnooze: noop,
  progress: noop,
};
const CLIENT: SessionChatClient = {
  answer: async () => SESSION,
  interrupt: async () => SESSION,
  resume: async () => SESSION,
  send: async () => ({ ...SESSION, disposition: 'queued' }) as never,
  stop: async () => SESSION,
  runtime: async () => SESSION,
} as unknown as SessionChatClient;

function Harness() {
  useAppViewport();
  const presentation = useLayoutMode() === 'drawer' ? 'sheet' : 'pane';
  const [session, setSession] = useState(SESSION);
  return (
    <div className="kt-shell flex flex-col overflow-hidden" id="harness-phone-chat">
      <div className="relative min-h-0 min-w-0 flex-1 px-1 sm:px-3" data-shell-main="">
        <SessionChatPage
          agendaTarget={agendaTargetFromSearch(window.location.search) as AgendaId | null}
          attention={{ client: AGENDA_CLIENT, snapshot: SNAPSHOT, status: 'ready' }}
          board={board}
          chatWidth="readable"
          client={CLIENT}
          connection={laptop}
          context={{
            attention: new DaemonAgendaClient(undefined, async () => Response.json({}, { status: 503 })),
            createFleetClient: async () => {
              throw new Error('the harness has no fleet');
            },
            machineName: 'laptop',
          }}
          daemonSessions={[session, ...CHILDREN]}
          dictationSettings={DEFAULT_STT_SETTINGS}
          entries={ENTRIES}
          {...(withInfo === null ? {} : { initialInfo: 'overview' as const })}
          onNavigate={to => window.history.pushState(null, '', `#nav=${to}`)}
          onOpenSessions={() => undefined}
          onSessionChange={setSession}
          presentation={presentation}
          project="ferretry"
          readSnapshot={async () => ''}
          session={session}
        />
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <SessionSearchProvider connection={laptop} focusSignal={0} scope={daemonSessionScope(laptop, ID)}>
      <Harness />
    </SessionSearchProvider>,
  );
