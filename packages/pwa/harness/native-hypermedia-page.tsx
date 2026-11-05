/**
 * HYPERMEDIA THAT LOOKS NATIVE (&B163): one message that holds the three kinds of `fy-render` picture side by
 * side — an interactive `html` page that uses the app's theme kit, a Mermaid flowchart and a Chart.js bar chart —
 * drawn in two real surfaces (`native-hypermedia-screenshot.ts` bundles this and drives it):
 *
 *   ?scene=chat     the REAL `SessionChatPage` with the message as an assistant turn in the transcript
 *   ?scene=agenda   the REAL agenda item view (`AgendaChatHarness`) with the message as one of the item's own tabs
 *
 * Only the data is invented. The interactive page is the guide's "slider that redraws bars" plus a segmented
 * control that switches what the bars measure, so both a range input and a button can be driven.
 */

import type { AgendaId, AgendaItem, AgendaSnapshot, SessionView } from '@ferretry/protocol';
import { type ReactElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionSearchProvider } from '../src/features/session-search/session-search.tsx';
import { useAppViewport } from '../src/hooks/use-app-viewport.ts';
import { useStateChatTasks } from '../src/hooks/use-chat-tasks-url.ts';
import { useLayoutMode } from '../src/hooks/use-layout-mode.ts';
import { DaemonAgendaClient } from '../src/lib/agenda-client.ts';
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
import { AgendaChatHarness } from './agenda-chat.tsx';

const NOW = Date.parse('2026-10-30T06:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const ID = 'mvgt2oz9-04e28935';
const FENCE = '```';

/** The interactive page: the guide's slider that redraws bars, plus a segmented control that changes the series. */
const INTERACTIVE_PAGE = `<div class="fy-stack">
  <div class="fy-row">
    <div class="fy-segmented" role="group" aria-label="Series">
      <button class="fy-btn" id="b-rev" aria-pressed="true" type="button">Revenue</button>
      <button class="fy-btn" id="b-cost" aria-pressed="false" type="button">Cost</button>
    </div>
    <label class="fy-toggle"><input id="t-round" type="checkbox"> Round</label>
  </div>
  <label class="fy-field">Growth <input class="fy-range" id="g" type="range" min="0" max="50" value="20"> <output id="o"></output></label>
  <div class="fy-bars" id="bars"></div>
  <div class="fy-legend"><span><i class="fy-swatch" id="sw"></i><span id="lg">Revenue, year 1 = 1.00</span></span></div>
</div>
<script>
  const g = document.getElementById('g'), o = document.getElementById('o'), bars = document.getElementById('bars');
  const rev = document.getElementById('b-rev'), cost = document.getElementById('b-cost');
  const round = document.getElementById('t-round'), sw = document.getElementById('sw'), lg = document.getElementById('lg');
  let series = 'rev';
  function draw() {
    const rate = series === 'rev' ? g.value / 100 : g.value / 200;
    // Round is one decision: the heights, the labels and the legend all use the rounded value (1 decimal, so the bars still differ).
    const digits = round.checked ? 1 : 2;
    const values = [1, 2, 3, 4, 5].map(year => Number(Math.pow(1 + rate, year - 1).toFixed(digits)));
    const top = Math.max(...values);
    o.textContent = g.value + '%';
    sw.setAttribute('data-tone', series === 'rev' ? '1' : '3');
    lg.textContent = (series === 'rev' ? 'Revenue' : 'Cost') + ', year 1 = ' + values[0].toFixed(digits);
    bars.innerHTML = values.map((v, i) => '<div class="fy-bar" data-tone="' + (series === 'rev' ? '1' : '3') +
      '" style="--v:' + (v / top) * 100 + '" data-value="' + v.toFixed(digits) +
      '" data-label="Y' + (i + 1) + '"></div>').join('');
  }
  function pick(next) {
    series = next;
    rev.setAttribute('aria-pressed', String(next === 'rev'));
    cost.setAttribute('aria-pressed', String(next === 'cost'));
    draw();
  }
  g.addEventListener('input', draw);
  round.addEventListener('change', draw);
  rev.addEventListener('click', () => pick('rev'));
  cost.addEventListener('click', () => pick('cost'));
  draw();
</script>`;

const MERMAID = [
  'flowchart TB',
  '  A[Ask the ferret] --> B{Needs a picture?}',
  '  B -- yes --> C[Write an fy-render block]',
  '  B -- no --> D[Answer in prose]',
  '  C --> E[Reader sees it in the app theme]',
].join('\n');

const CHART =
  '{kind: bar, title: Weekly cost, x: [Mon, Tue, Wed, Thu, Fri], y: {format: money}, series: [{name: Cost, data: [12, 18, 9, 22, 15]}]}';

/** The one message: a line of prose, then the three pictures, then a closing line. */
const MESSAGE = [
  'Here is how growth plays out — move the slider or switch the series, then the flow and last week’s cost.',
  '',
  `${FENCE}fy-render\ntype: html\nalt: Revenue bars that redraw as the growth slider moves\n---\n${INTERACTIVE_PAGE}\n${FENCE}`,
  '',
  `${FENCE}fy-render\ntype: mermaid\nalt: How a request becomes a picture\n---\n${MERMAID}\n${FENCE}`,
  '',
  `${FENCE}fy-render\ntype: chart\nalt: Cost per weekday as bars\n---\n${CHART}\n${FENCE}`,
  '',
  'That is all three in one message.',
].join('\n');

const params = new URLSearchParams(window.location.search);
const scene = params.get('scene') ?? 'chat';

const noop = async (): Promise<void> => undefined;

/** The chat scene: the real page, one user turn and the assistant's message. */
const chatScene = (): ReactElement => {
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
    },
    state: {
      id: ID,
      status: 'running',
      turn: 4,
      startedAt: ago(600),
      lastActivityAt: ago(1),
      turnState: 'your-turn',
      turnStateAt: ago(2),
      promptReady: true,
    },
    directory: '/home/kirin/Workspace/personal/ferretry',
  } as unknown as SessionView;
  const ENTRIES = [
    { id: 'u1', kind: 'user', label: 'You', text: 'Show me growth, the flow and the cost in one go?' },
    { id: 'a1', kind: 'assistant', label: 'Lizzette', text: MESSAGE },
  ] as unknown as readonly TranscriptEntry[];
  const SNAPSHOT = {
    v: 1,
    sessionId: ID,
    items: [],
    resolved: [],
    count: 0,
    parseErrors: 0,
    updatedAt: ago(1),
  } as unknown as AgendaSnapshot;
  const board = new DaemonBoardStore(
    fakePort({
      board: async () =>
        boardAnswer([card('F11', { title: 'Hypermedia', laneId: 'implement', owner: ID, lastTouchedAt: ago(3) })], {
          projectId: PROJECT,
          laneSet: laneSetFor(),
          counts: { ...COUNTS, active: 1 },
        }),
      projects: async () => [{ id: PROJECT, name: 'Ferretry', path: null, laneSet: laneSetFor() }],
    }),
    fakeEnvironment(),
  );
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
  const CLIENT = {
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
    const tasks = useStateChatTasks();
    return (
      <div className="kt-shell flex flex-col overflow-hidden" id="harness-native-chat">
        <div className="relative min-h-0 min-w-0 flex-1 px-1 sm:px-3" data-shell-main="">
          <SessionChatPage
            agendaTarget={null}
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
            daemonSessions={[session]}
            dictationSettings={DEFAULT_STT_SETTINGS}
            entries={ENTRIES}
            onNavigate={to => window.history.pushState(null, '', `#nav=${to}`)}
            onOpenSessions={() => undefined}
            onSessionChange={setSession}
            presentation={presentation}
            project="ferretry"
            readSnapshot={async () => ''}
            session={session}
            tasksView={tasks}
          />
        </div>
      </div>
    );
  }
  return (
    <SessionSearchProvider connection={laptop} focusSignal={0} scope={daemonSessionScope(laptop, ID)}>
      <Harness />
    </SessionSearchProvider>
  );
};

/** The agenda scene: one explainer whose own tab holds the message. */
const agendaScene = (): ReactElement => {
  const ITEM = {
    id: 'A200',
    source: 'agent-raised',
    sourceRef: null,
    title: 'How growth plays out',
    subject: 'Read how growth plays out, then say when you have seen it.',
    why: 'A picture you can change tells it faster than a table.',
    waitingSince: ago(10),
    howToResolve: 'Look at the tab, then say got it.',
    raisedBy: 'agent',
    raisedBySession: 'fr',
    raisedByName: 'ottilie',
    kind: 'info',
    stage: 'explainer',
    stages: [{ stage: 'explainer', at: ago(10) }],
    whereWeAre: 'The three pictures are in the Pictures tab. Nothing needs a decision.',
    answers: [{ direction: 'right', does: 'done', label: 'Got it' }],
    tabs: [{ id: 'pictures', name: 'Pictures', body: MESSAGE }],
  } as unknown as AgendaItem;
  const board: AgendaSnapshot = {
    v: 1,
    sessionId: 'fr',
    items: [ITEM],
    resolved: [],
    count: 1,
    parseErrors: 0,
    updatedAt: ago(1),
  } as unknown as AgendaSnapshot;
  return (
    <div className="h-dvh" data-fixture="">
      <AgendaChatHarness agendaMode board={board} now={NOW} target={'A200' as AgendaId} />
    </div>
  );
};

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(scene === 'agenda' ? agendaScene() : chatScene());
