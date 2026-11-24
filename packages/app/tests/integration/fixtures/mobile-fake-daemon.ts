/**
 * The fake machine's answers for `mobile-scene.tsx`: every name, number and word is made up, and the names are on
 * purpose a little long, because a phone's width is judged against real-looking text, not "Item 1".
 */
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { json } from '../../unit/client/fixtures.ts';

const grants = {
  capabilities: ['fleet', 'terminal', 'browser', 'filesystem', 'warden', 'pairing', 'secrets'].map(capability => ({
    capability,
    use: true,
    configure: true,
    granted: { use: true, configure: true },
    useRefusal: 'granted',
    configureRefusal: 'granted',
    mayGrant: false,
    origin: 'default',
  })),
  governed: true,
  hostLocal: false,
  steppedUp: false,
};

const NOW = Date.UTC(2026, 10, 17, 20, 0, 0);
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

// ─── ferrets ────────────────────────────────────────────────────────────────────────────────────────────────────
const ferret = (id: string, title: string, state: string, minutes: number, folder: string, extra = {}) => ({
  id,
  name: id,
  role: 'lead',
  mode: 'interactive',
  harness: 'claude-code',
  runner: 'tmux',
  runtime: 'claude-personal',
  folder,
  state,
  createdAt: ago(minutes + 300),
  stateAt: ago(minutes),
  title,
  model: 'claude-opus-5-5',
  effort: 'high',
  ...extra,
});
const FERRETS = [
  ferret('zoe', 'Fix the login redirect loop on the settings page', 'working', 2, '/work/fixture'),
  ferret('kai', 'Release train for the 5.0 preview', 'idle', 25, '/work/release'),
  ferret('hadi', 'Docs sweep: rewrite the pairing guide', 'idle', 190, '/work/docs'),
  ferret('piper', 'Ledger rewrite', 'stopped', 1_900, '/work/ledger', { mode: 'auto' }),
];
const summaryOf = (id: string) => ({
  ...(FERRETS.find(entry => entry.id === id) ?? FERRETS[0]),
  quota: { fiveHourPercent: 12, weeklyPercent: 38, provider: 'claude' },
});

// ─── a conversation, in the daemon's normalized log form (one record per header line) ──────────────────────────
const clock = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString().slice(11, 19);
const LOG = [
  `[${clock(40)}] user/message: The settings page keeps bouncing me back to the sign-in screen after I save. Can you find out why?`,
  `[${clock(39)}] assistant/message: Looking at the redirect now. I will read the session guard first, then the save handler.`,
  `[${clock(39)}] assistant/tool-call: Bash({"command":"rg -n redirect packages/app/src/session/guard.ts"})`,
  `[${clock(38)}] tool/tool-result: guard.ts:41:  return redirectTo(\`/sign-in?return=\${location.pathname}\`);`,
  `[${clock(30)}] assistant/message: Found it: the guard compares the unlock time against a clock in seconds, but the saved value is in milliseconds, so every save looks expired. The fix is one line in guard.ts; I will also add a test that saves twice in a row so it cannot come back unnoticed.`,
  `[${clock(12)}] user/message: Great, go ahead. Keep the change small.`,
  `[${clock(2)}] assistant/message: Done. The guard now reads milliseconds, and the new test fails without the fix. Running the suite next.`,
].join('\n');

// ─── the machine's other answers ──────────────────────────────────────────────────────────────────────────────────
// ─── the agenda: asks the ferrets are waiting on the owner for ───────────────────────────────────────────────────
const ask = (id: string, subject: string, why: string, who: string, minutes: number, labels: readonly string[]) => ({
  id,
  source: 'agent-raised',
  sourceRef: null,
  sourceSeq: 1,
  subject,
  why,
  waitingSince: ago(minutes),
  howToResolve: 'Answer it.',
  raisedBy: 'agent',
  raisedBySession: who,
  raisedByName: who,
  ask: { kind: 'multiple-choice', options: labels.map(label => ({ label })) },
});
const AGENDA = {
  zoe: [
    ask(
      'A1',
      'Which fix should I apply to the redirect loop?',
      'Two fixes are possible and they touch different files.',
      'zoe',
      14,
      ['Patch the guard', 'Rewrite the reader', 'Leave it'],
    ),
    ask('A2', 'Spend limit reached: pause, switch or warn?', 'The weekly budget is at 92 percent.', 'zoe', 50, [
      'Pause',
      'Switch',
      'Warn',
    ]),
  ],
  kai: [ask('A3', 'Ship the relay fix today?', 'CI is green and the notes are written.', 'kai', 190, ['Ship', 'Hold'])],
};

const quotaCard = { fiveHourPercent: 12, weeklyPercent: 38 };

// ─── the project board: one registered project, its lanes and six cards ──────────────────────────────────────────
const MACHINE = 'ws';
const PROJECT = '9f3c2a54-7b1e-4d6a-9c11-2f8e77d3b901';
// The lane set the first ferret proposed and the owner confirmed: one lane per category, gates written out.
const LANES = [
  {
    id: 'todo',
    name: 'Todo',
    category: 'backlog',
    staleAfter: '3d',
    emphasis: 'progress',
    stage: { kind: 'auto', triggers: [] },
  },
  {
    id: 'implement',
    name: 'In progress',
    category: 'active',
    enterOn: ['work.started', 'pr.opened'],
    staleAfter: '4h',
    emphasis: 'progress',
    stage: { kind: 'auto', triggers: ['work.started', 'pr.opened'] },
  },
  {
    id: 'in-review',
    name: 'In review',
    category: 'review',
    enterOn: ['pr.ready'],
    staleAfter: '18h',
    emphasis: 'progress',
    stage: { kind: 'auto', triggers: ['pr.ready'] },
  },
  {
    id: 'merged',
    name: 'Merged',
    category: 'shipped',
    enterOn: ['pr.merged'],
    staleAfter: '3d',
    emphasis: 'info',
    stage: { kind: 'auto', triggers: ['pr.merged'] },
  },
  {
    id: 'released',
    name: 'Released',
    category: 'verify',
    enterOn: ['release.published'],
    ownerGate: true,
    emphasis: 'action',
    stage: {
      kind: 'gate',
      options: [
        { id: 'done', label: 'Done', outcome: { kind: 'close' } },
        { id: 'not-good', label: 'Not good', outcome: { kind: 'reopen-with-ask' } },
      ],
    },
  },
  {
    id: 'closed',
    name: 'Closed',
    category: 'closed',
    ownerGate: true,
    emphasis: 'info',
    stage: { kind: 'auto', triggers: [] },
  },
];
const LANE_IDS = LANES.map(lane => lane.id);
const laneSet = {
  projectId: PROJECT,
  version: 3,
  confirmedBy: 'owner',
  proposedBy: 'kai',
  lanes: LANES,
  variants: { quick: LANE_IDS, 'design-first': LANE_IDS, 'research-first': LANE_IDS, investigate: LANE_IDS },
  doneLane: 'closed',
  notGoodLane: 'implement',
};
const UNFILED_LANE_SET = {
  projectId: 'unfiled',
  version: 1,
  confirmedBy: 'owner',
  proposedBy: 'hadi',
  lanes: [
    {
      id: 'todo',
      name: 'Todo',
      category: 'backlog',
      staleAfter: '3d',
      emphasis: 'progress',
      stage: { kind: 'auto', triggers: [] },
    },
    {
      id: 'doing',
      name: 'Doing',
      category: 'active',
      enterOn: ['work.started'],
      staleAfter: '2h',
      emphasis: 'progress',
      stage: { kind: 'auto', triggers: ['work.started'] },
    },
    {
      id: 'to-test',
      name: 'Ready to try',
      category: 'verify',
      enterOn: ['pr.merged', 'release.published', 'signal.done'],
      ownerGate: true,
      emphasis: 'action',
      stage: {
        kind: 'gate',
        options: [
          { id: 'done', label: 'Done', outcome: { kind: 'close' } },
          { id: 'not-good', label: 'Not good', outcome: { kind: 'reopen-with-ask' } },
        ],
      },
    },
    {
      id: 'closed',
      name: 'Closed',
      category: 'closed',
      ownerGate: true,
      emphasis: 'info',
      stage: { kind: 'auto', triggers: [] },
    },
  ],
  variants: {
    quick: ['todo', 'doing', 'to-test', 'closed'],
    'design-first': ['todo', 'doing', 'to-test', 'closed'],
    'research-first': ['todo', 'doing', 'to-test', 'closed'],
    investigate: ['todo', 'doing', 'to-test', 'closed'],
  },
  doneLane: 'closed',
  notGoodLane: 'doing',
};
const emptyRollup = {
  children: 0,
  byCategory: { backlog: 0, active: 0, review: 0, shipped: 0, verify: 0, closed: 0 },
  active: 0,
  lastTouchedAt: null,
};
// The shared shape of a card; every field the daemon stores plus the view's derived half.
const card = (over: {
  id: string;
  kind: 'bug' | 'feature' | 'infra' | 'chore';
  title: string;
  summary: string;
  laneId: string;
  owner: string;
  askText: string;
  askSource: string;
  ageMinutes: number;
  history?: readonly unknown[];
  activity?: 'active' | 'idle' | 'stale' | 'orphaned';
  touchedAgo?: number;
  touchedBy?: string | null;
  openAsks?: readonly unknown[];
  pr?: unknown;
  branch?: string | null;
  shippedIn?: unknown;
  progress?: { now: string; doneSoFar: string; next: string };
  files?: readonly string[];
  assignee?: string | null;
  visibility?: 'public' | 'private';
}) => ({
  format: 1,
  id: over.id,
  machineId: MACHINE,
  projectId: PROJECT,
  laneId: over.laneId,
  kind: over.kind,
  title: over.title,
  summary: over.summary,
  ask: { text: over.askText, source: over.askSource },
  clarifications: [],
  premise: 'Customers pay through this queue, so a dropped charge is money that has to be chased by hand.',
  context: 'The retry ladder the export queue uses is already in `services/billing/queue.ts`; this work reuses it.',
  terms: [],
  brief: '',
  howToTest: '',
  ...(over.progress === undefined ? {} : { progress: over.progress }),
  owner: over.owner,
  assignee: over.assignee ?? over.owner,
  parent: null,
  dependsOn: [],
  blocked: null,
  dropped: null,
  workflow: 'quick',
  links: {
    prs: over.pr === undefined ? [] : [over.pr],
    branch: over.branch ?? null,
    commits: [],
    docs: [],
  },
  files: over.files ?? [],
  order: null,
  createdAt: ago(over.ageMinutes + 4_000),
  createdBy: { kind: 'owner' },
  history: [
    { seq: 1, at: ago(over.ageMinutes + 4_000), actor: { kind: 'owner' }, type: 'created', laneId: 'todo' },
    ...(over.history ?? []),
  ],
  askedBy: 'person',
  visibility: over.visibility ?? 'public',
  visibilitySource: 'default',
  lastTouchedAt: over.touchedAgo === undefined ? null : ago(over.touchedAgo),
  touchedBy: over.touchedBy ?? null,
  activity: over.activity ?? 'idle',
  rollup: emptyRollup,
  suggestedLane: null,
  openAsks: over.openAsks ?? [],
  blockedBy: [],
  blocks: [],
  shippedIn: over.shippedIn ?? null,
  origin: 'human',
  humanParent: null,
});
const daemon = (ferret: string) => ({ kind: 'daemon', ferret });
const moved = (seq: number, minutes: number, from: string, to: string, trigger: string, ferret: string) => ({
  seq,
  at: ago(minutes),
  actor: daemon(ferret),
  type: 'moved',
  from,
  to,
  backward: false,
  reason: null,
  auto: true,
  trigger,
});
const pr = (number: number, state: 'open' | 'merged', checks: 'pending' | 'passing', minutes: number) =>
  state === 'open'
    ? {
        url: `https://github.com/lighthouse-tools/billing/pull/${String(number)}`,
        number,
        repo: 'lighthouse-tools/billing',
        state,
        draft: false,
        checks,
        mergedAt: null,
        mergeSha: null,
        releasedIn: null,
        polledAt: ago(minutes),
      }
    : {
        url: `https://github.com/lighthouse-tools/billing/pull/${String(number)}`,
        number,
        repo: 'lighthouse-tools/billing',
        state,
        draft: false,
        checks,
        mergedAt: ago(minutes),
        mergeSha: '1f0b9ce7a4d2386f5bce90d2a17c4f6ea83b91d5',
        releasedIn: { version: '4.2.1', tag: 'v4.2.1', at: ago(minutes - 60) },
        polledAt: ago(20),
      };
const CARDS = [
  card({
    id: 'F12',
    kind: 'feature',
    title: 'Ship the billing retry queue',
    summary: 'Failed card charges retry with backoff instead of being dropped on the floor.',
    laneId: 'implement',
    owner: 'zoe',
    askText:
      'Failed card charges are dropped after one try. Make them retry the way the export queue does, and tell me what it costs.',
    askSource: 'chat, Tuesday morning',
    ageMinutes: 2_600,
    history: [moved(2, 40, 'todo', 'implement', 'work.started', 'zoe')],
    activity: 'active',
    touchedAgo: 4,
    touchedBy: 'zoe',
    pr: pr(482, 'open', 'pending', 30),
    branch: 'feat/billing-retry-queue',
    progress: {
      now: 'Waiting on the CI matrix; the retry ladder itself is done and reviewed once already.',
      doneSoFar: '- the ladder and its tests\n- the runbook paragraph about failed charges',
      next: '- watch one nightly cycle\n- then ask for Done',
    },
    files: [
      'services/billing/retry-queue.ts',
      'services/billing/__tests__/retry-queue.test.ts',
      'docs/runbooks/failed-card-charges.md',
    ],
  }),
  card({
    id: 'B7',
    kind: 'bug',
    title: 'Fix the invoice export crash',
    summary: 'The nightly export no longer dies on quote characters in customer names.',
    laneId: 'released',
    owner: 'kai',
    askText: 'The nightly invoice export crashed at 02:00 again. The log points at quote characters in customer names.',
    askSource: 'chat, Monday',
    ageMinutes: 3_800,
    history: [
      moved(2, 2_900, 'todo', 'implement', 'work.started', 'kai'),
      moved(3, 1_900, 'implement', 'merged', 'pr.merged', 'kai'),
      moved(4, 1_500, 'merged', 'released', 'release.published', 'kai'),
    ],
    touchedAgo: 1_450,
    touchedBy: 'kai',
    openAsks: [{ ferret: 'kai', id: 'A3' }],
    pr: pr(476, 'merged', 'passing', 1_900),
    branch: 'fix/invoice-export-quote-names',
    shippedIn: { version: '4.2.1', tag: 'v4.2.1', at: ago(1_500) },
  }),
  card({
    id: 'F9',
    kind: 'feature',
    title: 'Migrate the ledger import jobs',
    summary: '',
    laneId: 'todo',
    owner: 'hadi',
    askText: 'The old cron jobs still write the ledger. Move them to the scheduler before the crons are turned off.',
    askSource: 'call, 12 November',
    ageMinutes: 6_100,
  }),
  card({
    id: 'F15',
    kind: 'feature',
    title: 'Rewrite the settings navigation',
    summary: 'The settings tree is four menus deep and uses three different names for the same page.',
    laneId: 'todo',
    owner: 'piper',
    askText: 'I cannot find the API keys page any more without using search. Please untangle the settings tree.',
    askSource: 'chat, Thursday',
    ageMinutes: 5_200,
    files: [
      'packages/admin/src/features/settings/navigation/tree/split-by-domain.tsx',
      'packages/admin/src/features/settings/navigation/tree/__fixtures__/long-section-names.fixture.tsx',
    ],
  }),
  card({
    id: 'I3',
    kind: 'infra',
    title: 'Move CI to larger runners',
    summary: 'The release build fits the runner again; only the macOS job still times out on the small one.',
    laneId: 'in-review',
    owner: 'kai',
    askText: 'The release job has been evicted twice this week for memory. Move it to the larger runners.',
    askSource: 'chat, last week',
    ageMinutes: 8_000,
    history: [
      moved(2, 4_000, 'todo', 'implement', 'work.started', 'kai'),
      moved(3, 2_700, 'implement', 'in-review', 'pr.ready', 'kai'),
    ],
    activity: 'stale',
    touchedAgo: 2_700,
    touchedBy: 'kai',
    pr: pr(469, 'open', 'passing', 2_650),
    branch: 'chore/larger-ci-runners',
  }),
  card({
    id: 'C4',
    kind: 'chore',
    title: 'Trim the onboarding copy',
    summary: 'Every first-run screen reads three sentences shorter.',
    laneId: 'closed',
    owner: 'hadi',
    askText: 'The first-run text is too long for a phone. Cut it to what a person needs in the first minute.',
    askSource: 'chat, October',
    ageMinutes: 12_000,
    history: [
      moved(2, 11_000, 'todo', 'implement', 'work.started', 'hadi'),
      moved(3, 10_200, 'implement', 'released', 'release.published', 'hadi'),
      {
        seq: 4,
        at: ago(10_000),
        actor: { kind: 'owner' },
        type: 'moved',
        from: 'released',
        to: 'closed',
        backward: false,
        reason: null,
      },
    ],
    touchedAgo: 10_000,
    touchedBy: 'hadi',
  }),
];
const BOARD_COUNTS = { closedHidden: 1, stale: 1, orphaned: 0, active: 1 };

// ─── the registry: folders this machine deliberately launches ───────────────────────────────────────────────────
// The same ids the board's project list hands out, so the two pages cannot disagree about the machine's projects.
// `scratch-scripts` is the quiet row — no git, never active — and zoe's `/work/fixture` stays unregistered on
// purpose so the page also shows one discovery waiting to be confirmed.
const PROJECTS = [
  {
    id: PROJECT,
    name: 'lighthouse-billing',
    path: '/work/lighthouse',
    source: 'existing-folder',
    createdAt: ago(430_000),
    git: { commonDirectory: '/work/lighthouse' },
    lastActivity: ago(40),
  },
  {
    id: 'b71e0d92-4a3f-4c58-9d2e-6a90b1c8d403',
    name: 'customer-notifications-orchestration',
    path: '/work/notifications/customer-notifications-orchestration',
    source: 'clone',
    createdAt: ago(210_000),
    git: { commonDirectory: '/work/notifications/customer-notifications-orchestration' },
    lastActivity: ago(1_500),
  },
  {
    id: '5d94a1e7-2b6c-4f0a-8e51-c7d3f2a9b608',
    name: 'docs-hub',
    path: '/work/docs',
    source: 'confirmed-discovery',
    createdAt: ago(26_000),
    git: { commonDirectory: '/work/docs' },
    lastActivity: ago(9_000),
  },
  {
    id: 'e2f8c4b1-9d07-4a6e-b3c5-1f8a2e7d94c6',
    name: 'scratch-scripts',
    path: '/work/scratch/one-off-migration-scripts',
    source: 'new-folder',
    createdAt: ago(80_000),
  },
];
/** A project named by one unbroken word (`/d/ws/projects/<LONG_NAME_PROJECT_ID>`): the heading must wrap, never push the page sideways. */
export const LONG_NAME_PROJECT_ID = 'c3a5e7b9-1d2f-4a60-8b4c-9e0f1a2b3c4d';
const LONG_NAME_PROJECT = {
  id: LONG_NAME_PROJECT_ID,
  name: 'CustomerNotificationsService',
  path: '/work/notifications/CustomerNotificationsService',
  source: 'existing-folder',
  createdAt: ago(5_000),
  git: { commonDirectory: '/work/notifications/CustomerNotificationsService' },
  lastActivity: ago(30),
};
/** One page of the project's board, narrowed the way the page asked: state and project are honoured. */
const boardAnswer = (request: TransportRequest): unknown => {
  const state = request.query?.state ?? 'open';
  const cards = CARDS.filter(
    entry => state === 'all' || (state === 'closed' ? entry.laneId === 'closed' : entry.laneId !== 'closed'),
  );
  const project = request.query?.project;
  if (project === undefined)
    return { projectId: null, laneSet: null, cards, counts: BOARD_COUNTS, nextCursor: null, quarantined: [] };
  if (project === 'unfiled')
    return {
      projectId: 'unfiled',
      laneSet: UNFILED_LANE_SET,
      cards: [],
      counts: { closedHidden: 0, stale: 0, orphaned: 0, active: 0 },
      nextCursor: null,
      quarantined: [],
    };
  return { projectId: PROJECT, laneSet, cards, counts: BOARD_COUNTS, nextCursor: null, quarantined: [] };
};

// ─── insights: the sessions the usage pages read, as raw rows ───────────────────────────────────────────────────
// The overview asks for one raw page per calendar month its 14-day window touches (`{day="YYYY-MM-*"}`), so the
// rows are generated against the REAL clock — a fixed date would slide out of the window and the page would go
// blank as soon as the calendar moved. `truncated` stays false, which is also what keeps the page from re-reading
// one day at a time.
const REAL_NOW = Date.now();
const utcDay = (daysAgo: number): string => new Date(REAL_NOW - daysAgo * 86_400_000).toISOString().slice(0, 10);
/** The ISO week a UTC day falls in, spelled the way the daemon names a week bucket ("2026-W46"). */
const isoWeek = (day: string): string => {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 3 - weekday);
  const week = Math.floor((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 604_800_000) + 1;
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};
const FOLDERS: Readonly<Record<string, string>> = {
  zoe: '/work/fixture',
  kai: '/work/release',
  hadi: '/work/docs',
  piper: '/work/ledger',
};
const session = (
  daysAgo: number,
  hoursAgo: number,
  agent: string,
  label: string,
  costMicros: number | null,
  tokens: number,
  turns: number,
  activeMinutes: number,
  over = {},
) => {
  const day = utcDay(daysAgo);
  const model = 'model' in over && typeof over.model === 'string' ? over.model : 'claude-sonnet-5-5';
  return {
    id: `${day}-${agent}-${hoursAgo}`,
    agent,
    model,
    contextWindow: 200_000,
    harness: 'claude-code',
    mode: 'interactive',
    status: 'completed',
    label,
    cwd: FOLDERS[agent] ?? '/work/fixture',
    parent: null,
    tree: null,
    day,
    week: isoWeek(day),
    createdAt: new Date(REAL_NOW - daysAgo * 86_400_000 - hoursAgo * 3_600_000).toISOString(),
    pricingModel: model,
    equivalentApiCostUsdMicros: costMicros,
    equivalentApiCostCurrentUsdMicros: costMicros,
    tokens,
    inputTokens: Math.round(tokens * 0.82),
    outputTokens: Math.round(tokens * 0.11),
    cachedInputTokens: Math.round(tokens * 0.45),
    cacheWriteInputTokens: Math.round(tokens * 0.03),
    cacheWrite5mInputTokens: Math.round(tokens * 0.02),
    cacheWrite1hInputTokens: Math.round(tokens * 0.01),
    reasoningTokens: null,
    turns,
    durationMs: activeMinutes * 96_000,
    activeDurationMs: activeMinutes * 60_000,
    machine: 'ws',
    timeToFirstOutputMs: 1_400,
    contextEndPercent: 42,
    stalled: false,
    failed: false,
    completed: true,
    ...over,
  };
};
const INSIGHT_ROWS = [
  session(0, 9, 'zoe', 'Fix the login redirect loop', 412_000, 214_000, 18, 96),
  session(0, 4, 'kai', 'Release train for the 5.0 preview', 205_000, 121_000, 9, 40),
  session(1, 8, 'hadi', 'Docs sweep: rewrite the pairing guide', 38_000, 22_500, 14, 25, { model: 'claude-haiku-5-5' }),
  session(1, 6, 'zoe', 'Fix the login redirect loop', 566_000, 268_000, 22, 130),
  session(1, 2, 'piper', 'Ledger rewrite', 2_940_000, 1_240_000, 61, 480, {
    model: 'claude-opus-5-5',
    mode: 'auto',
    reasoningTokens: 214_000,
    contextEndPercent: 78,
  }),
  session(2, 9, 'zoe', 'Fix the login redirect loop', 173_000, 98_000, 11, 55),
  session(2, 5, 'kai', 'Bump the release notes template', 21_000, 15_800, 6, 12, { model: 'claude-haiku-5-5' }),
  session(3, 7, 'hadi', 'Rewrite the settings navigation tree splitter', 703_000, 402_000, 34, 210),
  session(3, 3, 'zoe', 'Try the webhook retry reproduction', 96_000, 54_000, 7, 30, {
    stalled: true,
    completed: false,
    status: 'stopped',
  }),
  session(4, 8, 'kai', 'Chase the flaky signing test', 331_000, 187_000, 17, 88),
  session(4, 2, 'piper', 'Ledger rewrite', 1_510_000, 640_000, 33, 300, {
    model: 'claude-opus-5-5',
    mode: 'auto',
    reasoningTokens: 96_000,
  }),
  session(5, 6, 'zoe', 'Reproduce the invoice export crash', 96_000, 54_000, 7, 30, {
    failed: true,
    completed: false,
    status: 'stopped',
  }),
  session(5, 3, 'hadi', 'Pairing guide: add the relay section', 44_000, 26_500, 9, 18, { model: 'claude-haiku-5-5' }),
  session(6, 9, 'zoe', 'Move the settings tree behind routes', 1_820_000, 890_000, 41, 260, {
    model: 'claude-opus-5-5',
    reasoningTokens: 118_000,
    contextEndPercent: 71,
  }),
  session(6, 4, 'kai', 'Release train for the 5.0 preview', 254_000, 130_000, 12, 60),
  session(7, 10, 'piper', 'Ledger rewrite', 3_610_000, 1_310_000, 57, 510, {
    model: 'claude-opus-5-5',
    mode: 'auto',
    reasoningTokens: 260_000,
    contextEndPercent: 88,
  }),
  session(7, 6, 'hadi', 'Docs sweep: rewrite the pairing guide', 12_000, 9_400, 4, 8, { model: 'claude-haiku-5-5' }),
  session(8, 8, 'zoe', 'Draft the carrier choice question', null, 76_000, 8, 35, { costGap: 'unknown_pricing_model' }),
  session(8, 5, 'kai', 'Tag the 4.2.1 patch release', 189_000, 102_000, 10, 47),
  session(9, 7, 'hadi', 'Pairing guide: add the relay section', 51_000, 29_000, 11, 21, { model: 'claude-haiku-5-5' }),
  session(9, 4, 'zoe', 'Fix the login redirect loop', 298_000, 165_000, 15, 74),
  session(10, 6, 'kai', 'Tidy the changelog drawer', 8_500, 6_900, 3, 6, { model: 'claude-haiku-5-5' }),
  session(11, 9, 'piper', 'Ledger rewrite', 1_270_000, 560_000, 29, 240, {
    model: 'claude-opus-5-5',
    mode: 'auto',
    reasoningTokens: 141_000,
  }),
  session(11, 5, 'zoe', 'Fix the login redirect loop', 344_000, 190_000, 16, 80),
  session(11, 2, 'kai', 'Release train for the 5.0 preview', 262_000, 144_000, 13, 63, {
    cwd: '/work/notifications/customer-notifications-orchestration',
  }),
];
const INSIGHT_INDEX = {
  schemaVersion: 6,
  sessions: 63,
  tokenSessions: 59,
  transcriptSources: 71,
  indexedTranscriptSources: 69,
  pendingTranscriptSources: 0,
  sourceErrors: 0,
  refreshing: false,
  lastTokenRefreshAt: new Date(REAL_NOW - 21 * 60_000).toISOString(),
};
/** One raw insights answer, narrowed by the `{day="..."}` matcher the page sends (a month glob or one day). */
const DAY_MATCHER = /\{day="([^"]*)"\}/u;
const insightsAnswer = (request: TransportRequest): unknown => {
  const glob = DAY_MATCHER.exec(request.query?.q ?? '')?.[1] ?? null;
  const rows =
    glob === null
      ? INSIGHT_ROWS
      : INSIGHT_ROWS.filter(row => (glob.endsWith('*') ? row.day.startsWith(glob.slice(0, -1)) : row.day === glob));
  return {
    kind: 'raw',
    query: request.query?.q ?? '{}',
    parsed: {
      groupBy: [],
      matchers: glob === null ? [] : [{ label: 'day', op: '=', value: glob, wildcard: glob.endsWith('*') }],
    },
    scope: { allSessions: true, indexed: INSIGHT_ROWS.length, matched: rows.length },
    index: INSIGHT_INDEX,
    limit: 500,
    truncated: false,
    results: rows,
  };
};

// ─── the machine's accounts: logins, profiles, components, runtimes ─────────────────────────────────────────────
// Shapes follow the runtimes' own test fixtures (packages/plugins/runtimes/tests/.../catalog-fixture.ts): one
// claude login in the host's own store, one codex login, and one environment login that still needs a sign-in —
// the tab's attention row. The runtime named `claude-personal` is the one the ferrets above run on.
const agoReal = (minutes: number): string => new Date(REAL_NOW - minutes * 60_000).toISOString();
const secretRef = (name: string): string => ['$', `{secret:${name}}`].join('');
const loginStatus = (word: string, label: string, reason: string, explanation: string, over = {}) => ({
  word,
  label,
  reason,
  explanation,
  lastCheckInconclusive: false,
  lastCheckedAt: agoReal(24),
  ...over,
});
const LOGINS = {
  format: 1,
  machine: 'workshop-host',
  logins: [
    {
      id: 'personal',
      harness: 'claude-code',
      harnesses: ['claude-code'],
      store: 'host',
      email: 'kirin@werkvorm.example',
      label: 'Kirin (personal)',
      needsLabel: false,
      sharedWithTerminal: true,
      status: loginStatus('ready', 'Ready', 'access_current', 'The access token is current.'),
      usage: { fiveHour: { usedPercent: 12, resetsAt: agoReal(95) }, weekly: { usedPercent: 38 } },
      usedBy: ['claude-personal', 'claude-side'],
      signIn: { available: false, reason: 'already signed in' },
      checkNow: { available: true },
      signOut: { available: true, sentence: 'Sign out of this login?', runtimesAffected: 2, signsOutTerminal: true },
    },
    {
      id: 'codex-work',
      harness: 'codex',
      harnesses: ['codex'],
      store: 'host',
      email: 'kirin@lighthouse-tools.example',
      label: 'Codex (work)',
      needsLabel: false,
      sharedWithTerminal: true,
      status: loginStatus('ready', 'Ready', 'access_current', 'The access token is current.', { planType: 'Plus' }),
      usage: { fiveHour: { usedPercent: 64, resetsAt: agoReal(41) }, weekly: { usedPercent: 31 } },
      usedBy: ['codex-work'],
      signIn: { available: false, reason: 'already signed in' },
      checkNow: { available: true },
      signOut: { available: true, sentence: 'Sign out of this login?', runtimesAffected: 1, signsOutTerminal: true },
    },
    {
      id: 'staging-env',
      harness: 'claude-code',
      harnesses: ['claude-code', 'codex'],
      store: 'environment',
      label: 'Staging token',
      needsLabel: false,
      sharedWithTerminal: false,
      status: loginStatus(
        'needs_sign_in',
        'Needs sign-in',
        'not_signed_in',
        'Nobody has signed in on this machine yet.',
        { since: agoReal(4_300) },
      ),
      usage: { fiveHour: {}, weekly: {} },
      usedBy: ['staging-tests'],
      signIn: { available: true },
      checkNow: { available: true },
      signOut: { available: false, sentence: 'Sign out of this login?', runtimesAffected: 0, signsOutTerminal: false },
    },
  ],
};
const stackFor = (harness: 'claude-code' | 'codex', applied: readonly string[] = [], over = {}) => ({
  harness,
  available: { available: true },
  applied,
  skipped: [],
  conflicts: [],
  partial: [],
  ...over,
});
const component = (input: Record<string, unknown>): Record<string, unknown> => ({
  scope: input.harness ?? 'generic',
  partial: [],
  warnings: [],
  usedBy: { profiles: [], runtimes: [] },
  editNote: 'Nothing uses it yet.',
  remove: { available: true },
  ...input,
});
const COMPONENTS = {
  format: 'present',
  kinds: [
    {
      kind: 'instructions',
      label: 'Instructions',
      description: 'Standalone instruction files a profile can layer in.',
      components: [
        component({
          reference: 'instructions/Working agreements',
          kind: 'instructions',
          name: 'Working agreements',
          detail: { kind: 'instructions', file: 'components/instructions/Working agreements.md' },
          content: {
            form: 'text',
            text: '# How we work\n- Small PRs, one feature each.\n- Say what you skipped.',
            redacted: false,
          },
          usedBy: { profiles: ['Agent work', 'Default'], runtimes: ['claude-personal', 'claude-side'] },
        }),
      ],
    },
    {
      kind: 'mcp',
      label: 'MCP servers',
      description: 'Model Context Protocol servers the profiles can call.',
      components: [
        component({
          reference: 'mcp/github',
          kind: 'mcp',
          name: 'github',
          detail: {
            kind: 'mcp',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: [
              { name: 'GITHUB_TOKEN', value: secretRef('GITHUB_TOKEN') },
              { name: 'LOG', value: 'info' },
            ],
          },
          usedBy: { profiles: ['Default', 'Release reviews'], runtimes: ['claude-side'] },
        }),
        component({
          reference: 'mcp/notes',
          kind: 'mcp',
          name: 'notes',
          detail: { kind: 'mcp', command: 'uvx', args: ['notes-mcp', '--vault', '/home/other/Notes'], env: [] },
          warnings: ['Command not found: uvx'],
          checkPath: '/home/other/Notes',
        }),
      ],
    },
    {
      kind: 'skills',
      label: 'Skills',
      description: 'Bundles of skills shipped as one component.',
      components: [
        component({
          reference: 'skills/Release skills',
          kind: 'skills',
          name: 'Release skills',
          detail: { kind: 'skills', items: ['release-notes', 'pr-review'] },
          partial: [
            {
              harness: 'codex',
              reason: 'release-notes limits which tools it may use. Codex ignores that limit and loads the rest.',
            },
          ],
          usedBy: { profiles: ['Release reviews'], runtimes: ['claude-personal'] },
        }),
      ],
    },
    {
      kind: 'settings',
      label: 'Settings',
      description: 'Harness settings files a profile can layer in.',
      components: [
        component({
          reference: 'settings/Claude settings',
          kind: 'settings',
          name: 'Claude settings',
          harness: 'claude-code',
          detail: {
            kind: 'settings',
            file: 'components/settings/Claude settings.json',
            flags: ['--verbose'],
            env: [{ name: 'API_KEY', hidden: true }],
          },
          content: {
            form: 'entries',
            entries: [
              { key: 'env.ANTHROPIC_API_KEY', hidden: true },
              { key: 'permissions.defaultMode', value: 'plan' },
              { key: 'statusLine', value: 'on' },
            ],
          },
          usedBy: { profiles: ['Default'], runtimes: ['claude-side'] },
        }),
      ],
    },
    {
      kind: 'hooks',
      label: 'Hooks',
      description: 'Harness hook files a profile can layer in.',
      components: [
        component({
          reference: 'hooks/Format on save',
          kind: 'hooks',
          name: 'Format on save',
          harness: 'claude-code',
          detail: { kind: 'hooks', file: 'components/hooks/Format on save.json' },
          content: { form: 'text', text: '{"PostToolUse": []}', redacted: false },
        }),
      ],
    },
    {
      kind: 'modelSets',
      label: 'Model sets',
      description: 'Which models a profile may pick.',
      components: [
        component({
          reference: 'modelSets/Claude models',
          kind: 'modelSets',
          name: 'Claude models',
          detail: {
            kind: 'modelSets',
            models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
            default: 'claude-sonnet-5-5',
          },
          usedBy: { profiles: ['Default', 'Agent work'], runtimes: ['claude-personal', 'claude-side'] },
        }),
      ],
    },
  ],
};
const PERMISSIONS_CONFLICT = {
  harness: 'claude-code',
  field: 'settings',
  key: 'permissions.defaultMode',
  sentence: '`permissions.defaultMode` · Claude Code: acceptEdits (from Agent work) overrides plan (from Default)',
  winner: 'Agent work',
  overridden: ['Default'],
};
const PROFILES = {
  format: 'present',
  profiles: [
    {
      name: 'Agent work',
      layers: ['profile/Default', 'instructions/Working agreements'],
      usedBy: ['claude-personal'],
      baseFor: [],
      wouldIncludeItself: ['Agent work', 'Default'],
      scope: { kind: 'scoped', scope: 'generic' },
      harnesses: [
        stackFor('claude-code', ['instructions/Working agreements', 'modelSets/Claude models'], {
          conflicts: [PERMISSIONS_CONFLICT],
        }),
        stackFor('codex', [], {
          skipped: [
            {
              reference: 'instructions/Working agreements',
              sentence: 'Working agreements names Claude Code files, so it is skipped on Codex.',
            },
          ],
        }),
      ],
      remove: { available: false, reason: 'claude-personal runs on it; pick it another profile first' },
    },
    {
      name: 'Default',
      layers: ['instructions/Working agreements', 'mcp/github', 'settings/Claude settings', 'modelSets/Claude models'],
      usedBy: ['claude-side', 'codex-work'],
      baseFor: ['Agent work'],
      wouldIncludeItself: ['Agent work', 'Default'],
      scope: { kind: 'scoped', scope: 'generic' },
      harnesses: [
        stackFor('claude-code', [
          'instructions/Working agreements',
          'mcp/github',
          'settings/Claude settings',
          'modelSets/Claude models',
        ]),
        stackFor('codex', ['instructions/Working agreements', 'mcp/github'], {
          skipped: [
            {
              reference: 'settings/Claude settings',
              sentence: 'Claude settings is for Claude Code only, so it is skipped on Codex.',
            },
          ],
        }),
      ],
      remove: { available: false, reason: 'Agent work builds on it' },
    },
    {
      name: 'Release reviews',
      layers: ['profile/Default', 'skills/Release skills'],
      usedBy: [],
      baseFor: [],
      wouldIncludeItself: ['Release reviews', 'Default'],
      scope: { kind: 'scoped', scope: 'generic' },
      harnesses: [stackFor('claude-code', ['mcp/github', 'skills/Release skills']), stackFor('codex', ['mcp/github'])],
      remove: { available: true },
    },
  ],
};
const RUNTIMES = {
  format: 'present',
  runtimes: [
    {
      id: 'rt-claude-personal',
      name: 'claude-personal',
      wrapper: 'claude',
      harness: 'claude-code',
      credential: { id: 'personal', store: 'host' },
      profile: 'Agent work',
      stack: stackFor('claude-code', ['instructions/Working agreements', 'modelSets/Claude models']),
      modelSet: { source: 'harness-default' },
      launch: { available: true },
      sameAs: [],
    },
    {
      id: 'rt-claude-side',
      name: 'claude-side',
      wrapper: 'claude',
      harness: 'claude-code',
      credential: { id: 'personal', store: 'host' },
      profile: 'Default',
      stack: stackFor('claude-code', ['instructions/Working agreements', 'mcp/github', 'settings/Claude settings']),
      modelSet: { source: 'harness-default' },
      launch: { available: true },
      sameAs: ['claude-personal'],
    },
    {
      id: 'rt-codex-work',
      name: 'codex-work',
      wrapper: 'codex',
      harness: 'codex',
      credential: { id: 'codex-work', store: 'host' },
      profile: 'Default',
      stack: stackFor('codex', ['instructions/Working agreements', 'mcp/github']),
      modelSet: { source: 'harness-default' },
      launch: { available: true },
      sameAs: [],
    },
    {
      id: 'rt-staging-tests',
      name: 'staging-tests',
      wrapper: 'claude',
      harness: 'claude-code',
      credential: { id: 'staging-env', store: 'environment' },
      profile: 'Default',
      stack: stackFor('claude-code', ['instructions/Working agreements']),
      modelSet: { source: 'harness-default' },
      launch: { available: false, reason: 'Sign in to launch' },
      sameAs: [],
    },
  ],
};
const MACHINE_VIEW = {
  name: 'workshop-host',
  format: 'present',
  setUp: true,
  agentPermissions: 'auto',
  defaultRuntime: 'claude-personal',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  browserMode: 'headless',
  browserProxy: null,
  browserPorts: 'random',
  browserFirewallFailure: 'warn',
  autoResume: true,
  agendaMode: false,
  publicUsageFeed: false,
  lastAutoResume: {
    at: agoReal(600),
    resumed: 3,
    skipped: [{ sessionId: 'piper', reason: 'its folder is gone' }],
  },
  tools: [
    { harness: 'claude-code', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' },
    { harness: 'codex', label: 'Codex', installed: true, command: '/usr/local/bin/codex' },
  ],
  runtimeCount: 4,
  runningSessions: 1,
  authority: { mayApply: true, applyRefusal: 'granted' },
};

// ─── devices (Settings › Devices: the paired-device list; `Liftoff Browser` is the one this phone is) ───────────
const capabilityGrants = (narrow: (capability: string) => { use: boolean; configure: boolean }) =>
  Object.fromEntries(
    ['fleet', 'terminal', 'browser', 'filesystem', 'warden', 'pairing', 'secrets', 'sharing', 'voice'].map(
      capability => [capability, narrow(capability)],
    ),
  );
const FULL_DEVICE_GRANTS = capabilityGrants(() => ({ use: true, configure: true }));
const LIMITED_DEVICE_GRANTS = capabilityGrants(capability => ({ use: capability === 'fleet', configure: false }));
const PAIRED_DEVICES = {
  devices: [
    {
      id: 'fy_device_id_7Kd9mZqT3vNwXrP2bLh5Ys',
      name: 'Liftoff Browser',
      platform: 'browser',
      createdAt: agoReal(45 * 24 * 60),
      lastSeenAt: agoReal(4),
      idleExpiresAt: agoReal(-30 * 24 * 60),
      pairedOver: 'direct',
      grants: FULL_DEVICE_GRANTS,
    },
    {
      id: 'fy_device_id_Qw8eRtY1uIoP3aS5dF7gHj',
      name: 'Pixel 8a — kitchen-table stand',
      platform: 'browser',
      createdAt: agoReal(20 * 24 * 60),
      lastSeenAt: agoReal(2 * 24 * 60 + 95),
      idleExpiresAt: agoReal(-27 * 24 * 60),
      pairedOver: 'relay',
      grants: FULL_DEVICE_GRANTS,
    },
    {
      id: 'fy_device_id_Zx4cVb6nM8kL1jH3gF5dSa',
      name: 'Old iPad mini',
      platform: 'browser',
      createdAt: agoReal(150 * 24 * 60),
      lastSeenAt: agoReal(27 * 24 * 60),
      idleExpiresAt: agoReal(-3 * 24 * 60),
      grants: LIMITED_DEVICE_GRANTS,
    },
  ],
  hostLocal: false,
  thisDeviceId: 'fy_device_id_7Kd9mZqT3vNwXrP2bLh5Ys',
  mayWiden: FULL_DEVICE_GRANTS,
};

// ─── security (Settings › Security: the machine's gate settings and this device's passkeys) ─────────────────────
// Standing sign-in rules: none — the honest empty state for a machine that pre-approves nothing.
const SIGN_IN_RULES = { health: 'ok', rules: [], stages: [] };

const SECURITY_VIEW = {
  settings: {
    unlockOnOpen: true,
    unlockValidityHours: 12,
    stepUpOnActions: false,
    stepUpWindowMinutes: 30,
    deviceKeyRotationDays: 45,
    idleExpiryDays: 30,
  },
  source: 'document',
  mayWiden: true,
  widenCommand: 'fy config edit gate',
  updatedAt: agoReal(96 * 24 * 60),
};

const PASSKEYS_VIEW = {
  passkeys: [
    {
      id: 'kQ8vX2mXnR4sT6uW8yA0bC2dE4fG6hI8jK0lM2nO4pQ',
      origin: 'https://app.ferretry.example',
      createdAt: agoReal(44 * 24 * 60),
    },
  ],
  registration: 'confirm-existing',
  deviceName: 'Liftoff Browser',
  clientName: 'fy',
};

// ─── budgets (Settings › Budgets: each budgeted login's standing; `personal` sits over its weekly trigger) ──────
const dayStart = (hoursAgo: number): string => agoReal(hoursAgo * 60);
const BUDGETS_VIEW = {
  budgets: [
    {
      login: 'personal',
      budget: {
        timeZone: 'America/Los_Angeles',
        timeZoneSet: false,
        daily: { trigger: 8, hard: 15, spentUsd: 4.62, level: 'ok', startsAt: dayStart(9), resetsAt: dayStart(-15) },
        weekly: {
          trigger: 40,
          hard: 75,
          spentUsd: 31.4,
          level: 'over_trigger',
          startsAt: dayStart(3 * 24),
          resetsAt: dayStart(-4 * 24),
        },
        level: 'over_trigger',
        unpriced: 1,
        measured: true,
      },
    },
    {
      login: 'codex-work',
      budget: {
        timeZone: 'America/Los_Angeles',
        timeZoneSet: true,
        daily: { hard: 10, spentUsd: 1.87, level: 'ok', startsAt: dayStart(9), resetsAt: dayStart(-15) },
        weekly: {
          trigger: 25,
          hard: 50,
          spentUsd: 12.05,
          level: 'ok',
          startsAt: dayStart(3 * 24),
          resetsAt: dayStart(-4 * 24),
        },
        level: 'ok',
        unpriced: 0,
        measured: true,
      },
    },
  ],
};

// ─── audit (Settings › Audit: what this machine records about who reached it — names and ids only) ────────────────
const AUDIT_VIEW = {
  records: [
    {
      at: agoReal(38),
      event: 'device.paired',
      actor: { kind: 'host' },
      subject: 'Pixel 8a — kitchen-table stand',
      outcome: 'succeeded',
      detail: { pairedOver: 'relay' },
    },
    {
      at: agoReal(26),
      event: 'terminal.opened',
      actor: { kind: 'device', deviceId: 'fy_device_id_7Kd9mZqT3vNwXrP2bLh5Ys', deviceName: 'Liftoff Browser' },
      outcome: 'succeeded',
      detail: { ferret: 'zoe' },
    },
    {
      at: agoReal(19),
      event: 'secrets.used',
      actor: { kind: 'device', deviceId: 'fy_device_id_7Kd9mZqT3vNwXrP2bLh5Ys', deviceName: 'Liftoff Browser' },
      subject: 'LIGHTHOUSE_STRIPE_TEST_KEY',
      outcome: 'succeeded',
      detail: { by: 'zoe' },
    },
    {
      at: agoReal(11),
      event: 'step-up.failed',
      actor: { kind: 'device', deviceId: 'fy_device_id_Zx4cVb6nM8kL1jH3gF5dSa', deviceName: 'Old iPad mini' },
      outcome: 'refused',
    },
    {
      at: agoReal(6),
      event: 'grants.changed',
      actor: { kind: 'host' },
      subject: 'Old iPad mini',
      outcome: 'succeeded',
      detail: { capabilities: 'fleet.use', kept: false },
    },
    {
      at: agoReal(2),
      event: 'device.revoked',
      actor: { kind: 'host' },
      subject: 'Old iPad mini',
      outcome: 'succeeded',
    },
  ],
  // Nothing has rotated out of the live window yet, and nothing failed to parse — the honest zeroes.
  kept: [],
  keptTotal: 0,
  unreadable: 0,
};

// ─── model pricing (Settings › Model pricing: what a token costs here, and who said so) ───────────────────────────
const MICRO = 1_000_000; // $1.00, in integer USD micros
const rates = (slots: Record<string, number | null>) => ({
  input: null,
  output: null,
  cachedInput: null,
  cacheWrite: null,
  cacheWrite5m: null,
  cacheWrite1h: null,
  reasoning: null,
  image: null,
  tool: null,
  ...slots,
});
const PRICING_VIEW = {
  catalog: [
    {
      pricingKey: 'claude-sonnet-4-5',
      modelId: 'claude-sonnet-4-5',
      aliases: ['claude-sonnet-4-2025'],
      provider: 'anthropic',
      currency: 'USD',
      rates: rates({
        input: 3 * MICRO,
        output: 15 * MICRO,
        cachedInput: MICRO / 10,
        cacheWrite5m: 3.75 * MICRO,
        cacheWrite1h: 30 * MICRO,
      }),
      source: { kind: 'manual' },
      validFrom: agoReal(80 * 24 * 60),
      validThrough: null,
      verifiedAt: agoReal(12 * 24 * 60),
      lastSyncedAt: null,
    },
    {
      pricingKey: 'claude-opus-4-6-long-reasoning-preview',
      modelId: 'claude-opus-4-6-long-reasoning-preview',
      aliases: [],
      provider: 'anthropic',
      currency: 'USD',
      rates: rates({ input: 15 * MICRO, output: 75 * MICRO, cachedInput: 1.5 * MICRO, cacheWrite: 18.75 * MICRO }),
      source: { kind: 'provider_sync', provider: 'anthropic', sourceUrl: 'https://api.anthropic.com/v1/pricing' },
      validFrom: agoReal(30 * 24 * 60),
      validThrough: null,
      verifiedAt: agoReal(3 * 24 * 60),
      lastSyncedAt: agoReal(3 * 24 * 60),
    },
    {
      pricingKey: 'gpt-5.1',
      modelId: 'gpt-5.1',
      aliases: ['gpt-5.1-2026-08'],
      provider: 'openai',
      currency: 'USD',
      rates: rates({ input: 1.25 * MICRO, output: 10 * MICRO, cachedInput: MICRO / 8, reasoning: 10 * MICRO }),
      source: { kind: 'provider_sync', provider: 'openai', sourceUrl: 'https://api.openai.com/v1/pricing' },
      validFrom: agoReal(60 * 24 * 60),
      validThrough: null,
      verifiedAt: agoReal(2 * 24 * 60),
      lastSyncedAt: agoReal(2 * 24 * 60),
    },
  ],
  // The daemon derived these from the fleet's model catalogs — rows an operator's file cannot hold.
  modelCatalogRates: [
    {
      pricingKey: 'catalog:anthropic/claude-haiku-4-5',
      modelId: 'claude-haiku-4-5',
      aliases: [],
      provider: 'anthropic',
      currency: 'USD',
      rates: rates({
        input: MICRO,
        output: 5 * MICRO,
        cachedInput: MICRO / 10,
        cacheWrite5m: 1.25 * MICRO,
        cacheWrite1h: 10 * MICRO,
      }),
      source: { kind: 'model_catalog', catalog: 'anthropic', sourceUrl: 'https://api.anthropic.com/v1/pricing' },
      validFrom: agoReal(45 * 24 * 60),
      validThrough: null,
      verifiedAt: agoReal(45 * 24 * 60),
      lastSyncedAt: null,
    },
    {
      pricingKey: 'catalog:deepseek/deepseek-chat-v3.2',
      modelId: 'deepseek-chat-v3.2',
      aliases: ['deepseek-v3.2'],
      provider: 'deepseek',
      currency: 'USD',
      rates: rates({ input: MICRO / 4, output: MICRO, cachedInput: MICRO / 40, cacheWrite: MICRO / 8 }),
      source: { kind: 'model_catalog', catalog: 'deepseek', sourceUrl: 'https://api.deepseek.com/v1/pricing' },
      validFrom: agoReal(45 * 24 * 60),
      validThrough: null,
      verifiedAt: agoReal(45 * 24 * 60),
      lastSyncedAt: null,
    },
  ],
  catalogFingerprint: 'sha256:0f2c9d71ab',
  sourcesFingerprint: 'sha256:5b81e2f4c9',
  sources: [
    {
      id: 'anthropic-list',
      provider: 'anthropic',
      url: 'https://api.anthropic.com/v1/pricing',
      enabled: true,
      lastSyncedAt: agoReal(3 * 24 * 60),
    },
    {
      id: 'openai-list',
      provider: 'openai',
      url: 'https://api.openai.com/v1/pricing',
      enabled: true,
      lastSyncedAt: agoReal(2 * 24 * 60),
    },
  ],
  rateApplicability: {
    input: 'applied_when_evidenced',
    output: 'applied_when_evidenced',
    cachedInput: 'applied_when_evidenced',
    cacheWrite: 'applied_when_evidenced',
    cacheWrite5m: 'applied_when_evidenced',
    cacheWrite1h: 'applied_when_evidenced',
    reasoning: 'applied_when_evidenced',
    image: 'stored_not_applied',
    tool: 'stored_not_applied',
  },
};

// ─── doctor (Settings › Doctor: what the daemon could establish about its host without running anything) ────────
const DOCTOR_VIEW = {
  checks: [
    {
      name: 'claude',
      requirement: 'required',
      status: 'present',
      summary: 'found at /opt/homebrew/bin/claude',
      impact: 'Claude Code ferrets can start',
    },
    {
      name: 'codex',
      requirement: 'required',
      status: 'present',
      summary: 'found at /opt/homebrew/bin/codex',
      impact: 'Codex ferrets can start',
    },
    {
      name: 'git',
      requirement: 'required',
      status: 'present',
      summary: 'found at /usr/bin/git',
      impact: 'boards and worktrees work',
    },
    {
      name: 'rg (ripgrep)',
      requirement: 'capability',
      status: 'missing',
      summary: 'not found on PATH',
      impact: 'search inside sessions falls back to plain grep',
    },
    {
      name: 'gh',
      requirement: 'optional',
      status: 'missing',
      summary: 'not found on PATH',
      impact: 'the GitHub watcher is unavailable; boards move only on a push',
    },
  ],
  harnesses: [
    { kind: 'claude', launchable: ['claude-personal', 'claude-side'], blocked: [] },
    { kind: 'codex', launchable: ['codex-work'], blocked: ['staging-tests — its login needs a fresh sign-in'] },
  ],
  ready: true,
  limitation: 'Presence is PATH presence; nothing was run to establish it.',
};

// ─── secrets (Settings › Secrets: the store's inventory — names and references only, never a value) ──────────────
const SECRETS_VIEW = {
  v: 1,
  health: 'ready',
  secrets: [
    { name: 'LIGHTHOUSE_STRIPE_TEST_KEY', createdAt: agoReal(30 * 24 * 60), updatedAt: agoReal(9 * 24 * 60) },
    { name: 'JEV_API_KEY', createdAt: agoReal(60 * 24 * 60), updatedAt: agoReal(60 * 24 * 60) },
    { name: 'WORKSHOP_NPM_PUBLISH_TOKEN', createdAt: agoReal(21 * 24 * 60), updatedAt: agoReal(4 * 24 * 60) },
    { name: 'TRANSIENT_DEMO_KEY', createdAt: agoReal(2 * 24 * 60), updatedAt: agoReal(2 * 24 * 60) },
  ],
  references: [
    { name: 'JEV_API_KEY', origin: 'config/warden.yaml → jev.key', resolved: true },
    {
      name: 'LIGHTHOUSE_STRIPE_TEST_KEY',
      origin: 'config/agents.yaml → agentEnvironment.STRIPE_TEST_KEY',
      resolved: true,
    },
    { name: 'WORKSHOP_NPM_PUBLISH_TOKEN', origin: 'config/agents.yaml → agentEnvironment.NPM_TOKEN', resolved: true },
  ],
};

// ─── mcp (Settings › MCP servers: the inventory of every server any runtime could reach) ─────────────────────────
const MCP_VIEW = {
  servers: [
    {
      id: 'user:github',
      name: 'github',
      scope: 'user',
      harness: 'claude-code',
      transport: 'http',
      target: 'https://api.githubcopilot.com/mcp/',
      source: '~/.claude.json',
      runtimes: [
        { runtime: 'claude-personal', approval: 'approved' },
        { runtime: 'claude-side', approval: 'approved' },
      ],
      connection: {
        component: 'github',
        state: 'signed-in',
        issuer: 'https://github.com',
        signedInAt: agoReal(12 * 24 * 60),
        expiresAt: agoReal(-18 * 24 * 60),
        renewable: true,
        secrets: ['GITHUB_MCP_TOKEN'],
      },
    },
    {
      id: 'project:lighthouse-billing:stripe-dev',
      name: 'stripe-dev',
      scope: 'project',
      harness: 'claude-code',
      transport: 'stdio',
      target: 'npx -y @stripe/mcp --tools products',
      source: '/work/lighthouse/.mcp.json',
      project: { root: '/work/lighthouse', name: 'lighthouse-billing' },
      runtimes: [{ runtime: 'claude-personal' }],
      shadowedBy: 'local',
      signIn: { subject: 'stripe-dev', required: true },
    },
    {
      id: 'ferretry:browser-automation',
      name: 'browser-automation',
      scope: 'ferretry',
      harness: 'codex',
      transport: 'sse',
      target: 'http://127.0.0.1:9222/sse',
      runtimes: [],
    },
  ],
  problems: [
    {
      source: '/work/lighthouse/.mcp.json',
      message: 'server "stripe-dev" is shadowed by a same-named local server, which wins',
    },
  ],
};

const MCP_AUTH_VIEW = {
  connections: [
    {
      component: 'github',
      state: 'signed-in',
      issuer: 'https://github.com',
      signedInAt: agoReal(12 * 24 * 60),
      expiresAt: agoReal(-18 * 24 * 60),
      renewable: true,
      secrets: ['GITHUB_MCP_TOKEN'],
    },
    { component: 'linear', state: 'needs-sign-in', renewable: false, secrets: [] },
  ],
};

// ─── skills (Settings › Skills: what every runtime home and registered project offers) ───────────────────────────
const SKILLS_VIEW = {
  homes: [
    {
      runtime: 'claude-personal',
      harness: 'claude-code',
      home: '/Users/kirin/.ferretry/homes/claude-personal',
      skills: [
        {
          name: 'babysit-pr',
          description: 'Keep a PR green until it merges',
          harness: 'claude-code',
          scope: 'ferretry',
          path: '/Users/kirin/.ferretry/skills/babysit-pr/SKILL.md',
          runtimes: ['claude-personal'],
          toggle: { supported: true, enabled: true },
        },
        {
          name: 'liftoff-ops',
          description: 'Run Liftoff operations through loctl, never raw kubectl',
          harness: 'claude-code',
          scope: 'ferretry',
          path: '/Users/kirin/.ferretry/skills/liftoff-ops/SKILL.md',
          runtimes: ['claude-personal', 'claude-side'],
        },
        {
          name: 'dataviz',
          description: 'Charts that read as one system, in light and dark',
          harness: 'claude-code',
          scope: 'user',
          path: '/Users/kirin/.claude/skills/dataviz/SKILL.md',
          runtimes: ['claude-personal'],
          shadowedBy: 'ferretry',
        },
      ],
    },
    // The empty home is the honest thing: this runtime's home has no skills of its own yet.
    { runtime: 'codex-work', harness: 'codex', home: '/Users/kirin/.ferretry/homes/codex-work', skills: [] },
  ],
  projects: [
    {
      name: 'lighthouse-billing',
      root: '/work/lighthouse',
      skills: [
        {
          name: 'deploy-lighthouse',
          description: 'Deploy the billing service without dropping a request',
          harness: 'claude-code',
          scope: 'project',
          path: '/work/lighthouse/.claude/skills/deploy-lighthouse/SKILL.md',
          runtimes: ['claude-personal'],
          project: { root: '/work/lighthouse' },
        },
      ],
    },
  ],
  truncated: false,
};

// ─── terminals (Settings › Terminals: one session's panes — zoe is mid-task with a viewer attached) ─────────────
const TERMINALS_VIEW = {
  sessionId: 'zoe',
  terminals: [
    {
      id: 'a1b2c3d4e5f6',
      sessionId: 'zoe',
      title: 'dev server — lighthouse billing',
      state: 'running',
      cols: 120,
      rows: 32,
      viewers: 1,
      createdAt: agoReal(95),
      lastActivityAt: agoReal(2),
    },
    {
      id: '0f9e8d7c6b5a',
      sessionId: 'zoe',
      title: 'psql',
      state: 'running',
      cols: 80,
      rows: 24,
      viewers: 0,
      idleDeadline: agoReal(-25),
      createdAt: agoReal(300),
      lastActivityAt: agoReal(65),
    },
  ],
  limits: { perSession: 6, global: 24, runningGlobal: 5, idleTimeoutSeconds: 1800, scrollbackLines: 5000 },
};

// ─── warden (Settings › Warden: the supervisor's effective settings, standing and what it last noticed) ──────────
const WARDEN_CONFIG = {
  enabled: true,
  revive: {
    enabled: true,
    windowMinutes: 15,
    cooldownMinutes: 30,
    waveSize: 3,
    waveGapSeconds: 10,
    breakerMinutes: 30,
  },
  autoMove: {
    enabled: true,
    when: ['rate_limited', 'budget_exceeded'],
    targets: [],
    forceStopBackground: false,
    waitMinutes: 10,
    maxMovesPerHour: 1,
    minHeadroomPercent: 20,
  },
  layers: { jev: false, llm: true },
  guard: { threshold: 0.7, model: 'jev-latest', usdPerMillionInputTokens: 0.042 },
  caps: { jevUsdPerDay: 0.5, investigationUsdPerDay: 2, maxInvestigationsPerHour: 6 },
  mayActAlone: { nudge: true, resume: true, restart: true, failover: true, stop: false, closeLeftovers: true },
  jevActs: { nudge: 0.7, resume: 0.7, restart: 0.7, stop: 0.8 },
  events: { turnEnd: true, question: true, paneDied: true },
  investigation: { effort: 'low' },
  accounts: [{ agent: 'personal', model: 'claude-sonnet-4-5' }, { agent: 'codex-work' }],
  failover: { policy: 'fallback', failureThreshold: 2, cooldownMinutes: 30 },
  providerOutage: { minDistinctFerrets: 2, persistenceSweeps: 2, tailLines: 24 },
  intervalMinutes: 2,
  unattendedMinutes: 30,
  minSpawnGapMinutes: 15,
  susThinkingSeconds: 900,
  susSubprocessSeconds: 600,
  maxAssignedWardens: 1,
  assignedCooldownMinutes: 30,
  blessMinutes: 15,
};
const WARDEN_CONFIG_VIEW = {
  config: WARDEN_CONFIG,
  accounts: [{ agent: 'personal' }, { agent: 'codex-work' }],
  warnings: [],
  jevKey: 'not_named',
};
const WARDEN_STATUS_VIEW = {
  config: WARDEN_CONFIG,
  lastSweepAt: agoReal(3),
  nextSweepAt: agoReal(-2),
  flags: [
    {
      kind: 'unattended_question',
      ferret: 'kai',
      state: 'idle',
      detail: 'waiting on a question since 14 minutes ago',
      since: agoReal(14),
      idleMinutes: 14,
    },
    {
      kind: 'report_overdue',
      ferret: 'piper',
      state: 'working',
      detail: 'its card has not moved in 3 hours',
      since: agoReal(180),
    },
  ],
  fingerprint: 'warden:f1e0d2c3',
  lastReport: { reportId: 'wr-4821', head: 'Two ferrets need eyes: kai waits on a question, piper has gone quiet.' },
  triage: {
    jev: { configured: false, active: false, reason: 'disabled' },
    llm: { configured: true, active: true, reason: 'configured' },
  },
  investigations: [],
  actions: [],
  blessings: [],
};
const DIALOG_RULES_VIEW = {
  builtIn: [
    { id: 'builtin-codex-update', harness: 'codex', kind: 'update_available', does: 'chooses "No, not now"' },
    { id: 'builtin-claude-trust', harness: 'claude', kind: 'trust_folder', does: 'presses Esc' },
  ],
  taught: [{ id: 'taught-lighthouse-env', harness: 'claude', kind: 'env_overwrite', does: 'chooses "Keep existing"' }],
  pending: [],
};

// ─── speed-ups (Settings › Speed-ups: the optional third-party keys — set/unset by NAME, never a value) ──────────
const SPEEDUPS_VIEW = {
  vault: 'ok',
  providers: [
    {
      provider: 'jev',
      label: 'Jev',
      purpose: 'The Warden’s triage guard decides faster with it.',
      costNote: 'About $0.04 per million tokens checked.',
      privacyNote: 'Flag text leaves this machine to TypeSafe AI.',
      keyUrl: 'https://typesafe.ai/keys',
      testNote: 'A test spends under a cent.',
      secretName: 'JEV_API_KEY',
      set: true,
      secretUpdatedAt: agoReal(60 * 24 * 60),
      testStale: false,
      lastTest: {
        provider: 'jev',
        secretName: 'JEV_API_KEY',
        ok: true,
        code: 'ok',
        message: 'The key worked.',
        latencyMs: 412,
        at: agoReal(60 * 24 * 60),
      },
    },
    {
      provider: 'groq',
      label: 'Groq',
      purpose: 'Cleans up dictated transcripts in a blink.',
      costNote: 'Fractions of a cent per transcript.',
      privacyNote: 'Transcript text leaves to Groq.',
      keyUrl: 'https://console.groq.com/keys',
      testNote: 'A test spends under a cent.',
      secretName: 'GROQ_API_KEY',
      set: false,
      testStale: false,
    },
    {
      provider: 'cerebras',
      label: 'Cerebras',
      purpose: 'A second fast pair of hands for transcripts.',
      costNote: 'Fractions of a cent per transcript.',
      privacyNote: 'Transcript text leaves to Cerebras.',
      keyUrl: 'https://cloud.cerebras.ai',
      testNote: 'A test spends under a cent.',
      secretName: 'CEREBRAS_API_KEY',
      set: false,
      testStale: false,
    },
  ],
};

// ─── lessons (Settings › Lessons: what the fleet is taught, who files, and the Global document) ──────────────────
const LESSONS_CONFIG_VIEW = {
  enabled: false,
  agent: 'personal',
  model: 'claude-haiku-4-5',
  intervalMinutes: 240,
  batchSize: 20,
  maxMinersPerRun: 2,
  maxFerretsPerRun: 6,
  minSpawnGapMinutes: 15,
  passiveDefault: true,
};
const LESSONS_GLOBAL_VIEW = {
  name: 'Global lessons document',
  text: [
    '- Never push a commit that mentions a customer name; use the account id.',
    '- Reviews block only on broken or high-impact findings; batch the small stuff.',
    '- Every time shown to the owner is in their own timezone, never UTC.',
  ].join('\n'),
  etag: 'lessons-global-3',
  notes: [],
};
const LESSONS_FERRETS_VIEW = [
  { ferretId: 'zoe', passive: true, since: agoReal(20 * 24 * 60), setBy: 'default' },
  { ferretId: 'kai', passive: false, since: agoReal(6 * 24 * 60), setBy: 'owner' },
  { ferretId: 'hadi', passive: true, since: agoReal(3 * 24 * 60), setBy: 'default' },
];
const LESSONS_DIRECTORY_VIEW = [
  { ferretId: 'zoe', name: 'Zoe', folder: '/work/fixture' },
  { ferretId: 'kai', name: 'Kai', folder: '/work/release' },
  { ferretId: 'hadi', name: 'Hadi', folder: '/work/docs' },
  { ferretId: 'piper', folder: '/work/ledger' },
];

// ─── updates (Settings › Updates: the daemon's own version story — one release behind, checked minutes ago) ──────
const UPDATES_VIEW = {
  current: '5.0.0',
  method: { kind: 'homebrew', cask: 'ferretry' },
  plan: {
    kind: 'self',
    steps: [{ command: 'brew upgrade --cask ferretry', note: 'Ferretry can do this itself.' }],
    rollback: 'automatic',
  },
  check: {
    state: 'ok',
    checkedAt: agoReal(5 * 60),
    latest: {
      version: '5.0.1',
      url: 'https://github.com/ferretry/ferretry/releases/tag/v5.0.1',
      publishedAt: agoReal(26 * 60),
    },
  },
  available: true,
  midTurn: 2,
  autoInstall: false,
  job: null,
};

const byRoute: Readonly<Record<string, (request: TransportRequest) => unknown>> = {
  'GET /v1/health': () => ({ protocol: 1, version: '5.0.0' }),
  'GET /v1/grants': () => grants,
  'GET /v1/ferrets': () => FERRETS,
  'GET /v1/agenda/open': () => ({
    sessions: Object.entries(AGENDA).map(([sessionId, items]) => ({ sessionId, items })),
  }),
  'GET /v1/machine/agenda': () => ({ items: [] }),
  'GET /v1/carriers': () => ({ carriers: [] }),
  'GET /v1/usage': () => quotaCard,
  'GET /v1/usage/insights': insightsAnswer,
  // `?longProject=1`: one more project whose name is a single unbroken word, so a page's heading is judged against it.
  'GET /v1/projects': () =>
    new URLSearchParams(globalThis.location?.search ?? '').get('longProject') === '1'
      ? [LONG_NAME_PROJECT, ...PROJECTS]
      : PROJECTS,
  'GET /v1/logins': () => LOGINS,
  'GET /v1/runtimes': () => RUNTIMES,
  'GET /v1/runtimes/profiles': () => PROFILES,
  'GET /v1/runtimes/components': () => COMPONENTS,
  'GET /v1/runtimes/machine': () => MACHINE_VIEW,
  'GET /v1/pair/devices': () => PAIRED_DEVICES,
  'GET /v1/sign-in-rules': () => SIGN_IN_RULES,
  'GET /v1/security': () => SECURITY_VIEW,
  'GET /v1/passkeys': () => PASSKEYS_VIEW,
  'GET /v1/usage/budgets': () => BUDGETS_VIEW,
  'GET /v1/audit': () => AUDIT_VIEW,
  'GET /v1/usage/pricing': () => PRICING_VIEW,
  'GET /v1/doctor': () => DOCTOR_VIEW,
  'GET /v1/secrets': () => SECRETS_VIEW,
  'GET /v1/mcp': () => MCP_VIEW,
  'GET /v1/mcp/auth': () => MCP_AUTH_VIEW,
  'GET /v1/skills': () => SKILLS_VIEW,
  'GET /v1/terminals': () => TERMINALS_VIEW,
  'GET /v1/warden/config': () => WARDEN_CONFIG_VIEW,
  'GET /v1/warden/status': () => WARDEN_STATUS_VIEW,
  'GET /v1/warden/dialog/rules': () => DIALOG_RULES_VIEW,
  'GET /v1/speedups': () => SPEEDUPS_VIEW,
  'GET /v1/lessons/config': () => LESSONS_CONFIG_VIEW,
  'GET /v1/lessons/global': () => LESSONS_GLOBAL_VIEW,
  'GET /v1/lessons/ferrets': () => LESSONS_FERRETS_VIEW,
  'GET /v1/lessons/directory': () => LESSONS_DIRECTORY_VIEW,
  'GET /v1/daemon/update': () => UPDATES_VIEW,
  'GET /v1/board': boardAnswer,
  'GET /v1/board/ids': () => ({ ids: CARDS.map(entry => entry.id) }),
  'GET /v1/board/projects': () => ({
    projects: [
      { id: PROJECT, name: 'lighthouse-billing', path: '/work/lighthouse', laneSet },
      { id: 'unfiled', name: 'Unfiled', path: null, laneSet: UNFILED_LANE_SET },
    ],
    current: null,
  }),
};

const FERRET_PATH = /^\/v1\/ferrets\/([^/]+)(\/.*)?$/u;
const BOARD_TASK_PATH = /^\/v1\/board\/tasks\/([^/]+)$/u;

export const answerFor = (request: TransportRequest): TransportAnswer | undefined => {
  const direct = byRoute[`${request.method} ${request.path}`];
  if (direct !== undefined) return json(direct(request));
  const task = request.method === 'GET' ? BOARD_TASK_PATH.exec(request.path) : null;
  if (task !== null) {
    const found = CARDS.find(entry => entry.id === task[1]);
    if (found !== undefined) return json({ card: found, laneSet });
    return json({ code: 'not-found', error: 'no such card on the fake board' }, 404);
  }
  const match = FERRET_PATH.exec(request.path);
  if (match !== null && request.method === 'GET') {
    const [, id = 'zoe', rest = ''] = match;
    if (rest === '') return json(summaryOf(id));
    if (rest === '/log-page')
      return json({ v: 1, ferret: id, log: `${LOG}\n`, start: 0, file: 'transcript.jsonl', offsets: [] });
    if (rest === '/prompt') return json({ turnState: 'your-turn', turnStateAt: ago(2) });
    if (rest === '/sends') return json([]);
    if (rest === '/queue') return json({ items: [] });
    if (rest === '/agenda')
      return json({
        v: 1,
        sessionId: id,
        items: AGENDA[id as keyof typeof AGENDA] ?? [],
        resolved: [],
        count: (AGENDA[id as keyof typeof AGENDA] ?? []).length,
        parseErrors: 0,
        updatedAt: ago(1),
      });
  }
  return undefined;
};
