/**
 * The Board page, drawn by the real `BoardPage` over a fake daemon (`board-screenshot.ts` bundles this):
 * about twenty-five cards across Ferretry's lanes — working, stale, orphaned, waiting on the owner, to test —
 * with PR chips, a lead with sub-ferrets, blockers, and closed and dropped work for the Archive.
 *
 * `?view=kanban|list|tree|dependencies|archive` picks the view; nothing leaves the page.
 */

import type { BoardTaskView } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { BoardPage } from '../src/features/board/board-page.tsx';
import { AppTabBar } from '../src/shell/app-bar.tsx';
import { DaemonBoardStore } from '../src/lib/board-store.ts';
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
const links = (prs: readonly Record<string, unknown>[], branch: string | null = null) => ({
  prs,
  branch,
  commits: [],
  docs: [],
});
const ASK = { ref: { sessionId: DENISHA, id: 'A7' } };
const rollup = (children: number, active: number) => ({
  children,
  byCategory: { backlog: 1, active: 1, review: 1, shipped: 0, verify: 0, closed: 0 },
  active,
  lastTouchedAt: ago(20),
});

const OPEN = [
  card('F1', {
    title: 'Board: data layer and store',
    laneId: 'released',
    owner: DENISHA,
    summary: 'Cards read, merged and moved from the page.',
    links: links([
      pr(930, {
        state: 'merged',
        mergedAt: ago(900),
        mergeSha: SHA,
        releasedIn: { version: '4.110.0', tag: 'v4.110.0', at: ago(600) },
      }),
    ]),
    lastTouchedAt: ago(600),
    activity: 'idle',
  }),
  card('F2', {
    title: 'Board page and compact cards',
    laneId: 'implement',
    owner: DENISHA,
    assignee: OTTILIE,
    summary: 'Kanban, List, Tree, Dependencies and Archive from one card renderer.',
    links: links([pr(944, { checks: 'pending' })], 'feat/board-u11'),
    lastTouchedAt: ago(4),
    rollup: rollup(3, 1),
  }),
  card('F3', {
    title: 'Card drawer with history',
    laneId: 'plan',
    owner: DENISHA,
    parent: { id: 'F2' },
    assignee: MARGOT,
    summary: 'Opens over the board at /d/:id/board/:taskId.',
    lastTouchedAt: ago(40),
  }),
  card('F4', {
    title: 'Phone board with side pane',
    laneId: 'todo',
    owner: DENISHA,
    parent: { id: 'F2' },
    summary: 'Reuses the compact card at side density.',
    lastTouchedAt: ago(300),
    activity: 'idle',
  }),
  card('F5', {
    title: 'Wire PR watcher to cards',
    laneId: 'review',
    owner: DENISHA,
    parent: { id: 'F2' },
    assignee: OTTILIE,
    summary: 'Checks and merge state refresh without a reload.',
    links: links([pr(941, { checks: 'failing', draft: true })]),
    lastTouchedAt: ago(35),
  }),
  card('B6', {
    title: 'Relay key rotation',
    laneId: 'implement',
    owner: DENISHA,
    assignee: MARGOT,
    kind: 'bug',
    summary: 'Old key was pasted into a chat.',
    activity: 'stale',
    lastTouchedAt: ago(60 * 52),
    links: links([], 'fix/relay-key'),
  }),
  card('F7', {
    title: 'Agenda rename sweep',
    laneId: 'implement',
    owner: DENISHA,
    assignee: null,
    summary: 'No session owns this since its ferret ended.',
    activity: 'orphaned',
    lastTouchedAt: ago(60 * 30),
  }),
  card('F8', {
    title: 'Choose the finished-items database',
    laneId: 'plan',
    owner: DENISHA,
    assignee: OTTILIE,
    summary: 'SQLite or Postgres: waiting on a decision.',
    activity: 'waiting',
    openAsks: [ASK.ref],
    waitingOnOwner: [ASK.ref],
    lastTouchedAt: ago(180),
  }),
  card('F9', {
    title: 'Pairing QR drawn locally',
    laneId: 'tested',
    owner: DENISHA,
    assignee: OTTILIE,
    summary: 'Try it on your phone.',
    links: links([
      pr(920, {
        state: 'merged',
        mergedAt: ago(2000),
        mergeSha: SHA,
        releasedIn: { version: '4.109.0', tag: 'v4.109.0', at: ago(1500) },
      }),
    ]),
    activity: 'idle',
    lastTouchedAt: ago(1400),
  }),
  card('F10', {
    title: 'Device tokens stay on host',
    laneId: 'tested',
    owner: DENISHA,
    assignee: MARGOT,
    summary: 'Check the settings page after pairing.',
    links: links([
      pr(918, {
        state: 'merged',
        mergedAt: ago(2600),
        mergeSha: SHA,
        releasedIn: { version: '4.109.0', tag: 'v4.109.0', at: ago(1500) },
      }),
    ]),
    activity: 'idle',
    lastTouchedAt: ago(2200),
  }),
  card('F11', {
    title: 'Hosted relay advertisement',
    laneId: 'merged',
    owner: DENISHA,
    assignee: OTTILIE,
    summary: 'Merged, waiting for the next release.',
    links: links([pr(937, { state: 'merged', mergedAt: ago(120), mergeSha: SHA })]),
    lastTouchedAt: ago(120),
  }),
  card('F12', {
    title: 'Palette: jump to any destination',
    laneId: 'merged',
    owner: DENISHA,
    assignee: MARGOT,
    summary: 'Global destination finder.',
    links: links([pr(935, { state: 'merged', mergedAt: ago(300), mergeSha: SHA })]),
    lastTouchedAt: ago(300),
  }),
  card('F13', {
    title: 'Terminal links open right tab',
    laneId: 'review',
    owner: DENISHA,
    assignee: OTTILIE,
    summary: 'Wrapped links resolve to one target.',
    links: links([pr(939)]),
    lastTouchedAt: ago(90),
  }),
  card('F14', {
    title: 'Authorize warden remedies early',
    laneId: 'review',
    owner: DENISHA,
    assignee: MARGOT,
    summary: 'Remedies are authorised before they run.',
    links: links([pr(938, { checks: 'pending' })]),
    lastTouchedAt: ago(25),
  }),
  card('C15', {
    title: 'Speed up the first paint',
    laneId: 'implement',
    owner: DENISHA,
    assignee: OTTILIE,
    kind: 'chore',
    summary: 'Split the settings bundle.',
    lastTouchedAt: ago(15),
    links: links([], 'perf/first-paint'),
  }),
  card('C16', {
    title: 'Docs: self-hosting a relay',
    laneId: 'todo',
    owner: DENISHA,
    kind: 'chore',
    summary: '',
    lastTouchedAt: ago(60 * 20),
    activity: 'idle',
  }),
  card('B17', {
    title: 'Dark-mode contrast on pills',
    laneId: 'todo',
    owner: DENISHA,
    kind: 'bug',
    summary: 'Pill text is hard to read in dark.',
    lastTouchedAt: ago(60 * 8),
    activity: 'idle',
  }),
  card('F18', {
    title: 'Device revocation reaches the relay',
    laneId: 'plan',
    owner: DENISHA,
    assignee: MARGOT,
    summary: 'A revoked phone drops within seconds.',
    lastTouchedAt: ago(70),
    blockedBy: [{ id: 'F2' }],
  }),
  card('F19', {
    title: 'Upload progress for large files',
    laneId: 'implement',
    owner: DENISHA,
    assignee: OTTILIE,
    summary: 'A progress bar in the composer.',
    lastTouchedAt: ago(10),
    links: links([pr(943, { draft: true, checks: 'none' })]),
  }),
  card('C20', {
    title: 'Replay pairing in a test',
    laneId: 'todo',
    owner: DENISHA,
    kind: 'chore',
    summary: 'A scripted pairing run.',
    lastTouchedAt: ago(60 * 12),
    blocks: [{ id: 'F18' }],
  }),
  card('F21', {
    title: 'Fold access into one page',
    laneId: 'plan',
    owner: DENISHA,
    assignee: OTTILIE,
    summary: 'One list for what a remote caller may do.',
    lastTouchedAt: ago(110),
  }),
  card('F22', {
    title: 'Release notes in the app',
    laneId: 'released',
    owner: DENISHA,
    assignee: MARGOT,
    summary: 'Shown once after an update.',
    links: links([
      pr(910, {
        state: 'merged',
        mergedAt: ago(5000),
        mergeSha: SHA,
        releasedIn: { version: '4.108.0', tag: 'v4.108.0', at: ago(4000) },
      }),
    ]),
    activity: 'idle',
    lastTouchedAt: ago(4000),
  }),
  card('B23', {
    title: 'Retry a failed push notification',
    laneId: 'implement',
    owner: DENISHA,
    assignee: MARGOT,
    kind: 'bug',
    summary: 'Failures vanish without a retry.',
    activity: 'stale',
    lastTouchedAt: ago(60 * 80),
  }),
  card('F24', {
    title: 'Search across all sessions',
    laneId: 'todo',
    owner: DENISHA,
    summary: 'One box for conversations and files.',
    lastTouchedAt: ago(60 * 5),
    activity: 'idle',
  }),
  card('B25', {
    title: 'Flaky terminal reconnect',
    laneId: 'review',
    owner: DENISHA,
    assignee: OTTILIE,
    kind: 'bug',
    summary: 'Reconnect after sleep drops the first key.',
    links: links([pr(942, { checks: 'failing' })]),
    lastTouchedAt: ago(55),
  }),
];

const LANES = ['todo', 'plan', 'implement', 'review', 'merged', 'released', 'tested'] as const;
const WORDS = [
  'Reconcile',
  'relay-directory',
  'advertisement',
  'fingerprints',
  'authorisation',
  'notifications',
  'pairing',
  'migration',
];
const LONG_SUMMARY =
  'Imported from the old task list: rework the settings page, the daemon route and the wording of every message a person sees.';

/** `?big=1`: sixty more cards in every lane, with long titles, long summaries and imported ones. */
const BIG = Array.from({ length: 40 }, (_, index) => {
  const lane = LANES[index % LANES.length] ?? 'todo';
  const merged = lane === 'merged' || lane === 'released' || lane === 'tested';
  const imported = index % 4 === 0;
  return card(`F${300 + index}`, {
    title: `${WORDS[index % WORDS.length]} ${WORDS[(index + 3) % WORDS.length]} follow-up ${index}`,
    laneId: lane,
    owner: DENISHA,
    assignee: index % 5 === 0 ? null : [OTTILIE, MARGOT][index % 2],
    summary: imported ? LONG_SUMMARY : 'Short and to the point.',
    ...(imported ? { legacyRef: `old:F${index + 1}` } : {}),
    links: merged
      ? links([pr(1_000 + index, { state: 'merged', mergedAt: ago(60 + index * 40), mergeSha: SHA })])
      : index % 3 === 0
        ? links([pr(1_000 + index, { checks: index % 2 === 0 ? 'passing' : 'pending' })])
        : links([]),
    activity: index % 6 === 0 ? 'stale' : index % 3 === 0 ? 'idle' : 'active',
    lastTouchedAt: ago(10 + index * 55),
    shippedIn:
      lane === 'released' || lane === 'tested'
        ? { version: `4.141.${index % 4}`, tag: `v4.141.${index % 4}`, at: ago(90 + index * 35) }
        : null,
  });
});
/** What a newer daemon says about each card: every fourth big card was made by a ferret for the one before it. */
const withOrigin = (cards: readonly BoardTaskView[], firstId: number): BoardTaskView[] =>
  cards.map((item, index) =>
    index % 4 === 1 && firstId >= 300
      ? Object.assign(item, { origin: 'agent', humanParent: { id: `F${firstId + index - 1}` } })
      : Object.assign(item, { origin: 'human', humanParent: null }),
  );
const BIG_ON = new URLSearchParams(window.location.search).get('big') !== null;

const closed = (id: string, title: string, minutes: number, extra: Record<string, unknown> = {}) =>
  card(id, {
    title,
    laneId: 'closed',
    owner: DENISHA,
    assignee: OTTILIE,
    activity: 'idle',
    lastTouchedAt: ago(minutes),
    summary: 'Shipped and checked.',
    ...extra,
  });
const CLOSED = [
  closed('F101', 'Pairing codes expire quickly', 60 * 24 * 2),
  closed('F102', 'Secret store: use, never read', 60 * 24 * 5),
  closed('F103', 'Daemon discovers the hosted relay', 60 * 24 * 9, {
    links: links([pr(901, { state: 'merged', mergedAt: ago(60 * 24 * 10), mergeSha: SHA })]),
  }),
  closed('F104', 'One reference grammar', 60 * 24 * 12),
  closed('F105', 'Tab titles name the machine', 60 * 24 * 15),
];
const DROPPED = [
  card('F201', {
    title: 'A third carrier chooser',
    laneId: 'todo',
    owner: DENISHA,
    activity: 'idle',
    dropped: { at: ago(60 * 24 * 3), reason: 'The relay has no chooser any more.' },
    lastTouchedAt: ago(60 * 24 * 3),
  }),
];

const store = new DaemonBoardStore(
  fakePort({
    board: async (_daemon, query) => {
      const cards = (
        query.state === 'closed'
          ? CLOSED
          : query.state === 'dropped'
            ? DROPPED
            : BIG_ON
              ? [...withOrigin(OPEN, 0), ...withOrigin(BIG, 300)]
              : OPEN
      ).filter(item => query.ferret === null || item.owner === query.ferret || item.assignee === query.ferret);
      return boardAnswer(cards, {
        projectId: PROJECT,
        laneSet: laneSetFor(),
        counts: {
          ...COUNTS,
          closedHidden: CLOSED.length,
          stale: 2,
          orphaned: 1,
          active: 8,
          toTest: cards.filter(item => item.laneId === 'tested').length,
          waitingOnYou: 1,
        },
      });
    },
    projects: async () => [{ id: PROJECT, name: 'Ferretry', path: null, laneSet: laneSetFor() }],
  }),
  fakeEnvironment(),
);

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const [search, setSearch] = useState(() => {
    const view = params.get('view');
    const start = view === null || view === 'kanban' ? [] : [`view=${view}`];
    const passed = ['at', 'agents', 'window'].flatMap(key => {
      const value = params.get(key);
      return value === null ? [] : [`${key}=${value}`];
    });
    return [...start, ...passed].join('&');
  });
  const phone = window.innerWidth < 640;
  return (
    <div className="bg-bg text-fg" data-fixture={params.get('view') ?? 'kanban'} style={{ minHeight: '100vh' }}>
      <BoardPage
        agenda={{ respond: async () => undefined }}
        callsigns={CALLSIGNS}
        origin={params.get('from') === null ? null : { daemonId: laptop.daemonId, sessionId: params.get('from') ?? '' }}
        phone={phone}
        machines={[{ connection: laptop, name: 'laptop' }]}
        now={NOW}
        onNavigate={() => undefined}
        onSearch={setSearch}
        search={search}
        store={store}
      />
      {phone && params.get('bar') !== null ? (
        <div style={{ position: 'fixed', insetInline: 0, bottom: 0 }}>
          <AppTabBar active="board" boardCount={3} daemon={laptop.daemonId} onOpenPalette={() => undefined} />
        </div>
      ) : null}
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Harness />);
