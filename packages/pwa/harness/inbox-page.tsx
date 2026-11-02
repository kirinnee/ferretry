/**
 * The Inbox as the owner meets it, one view per URL (`agenda-screenshot.ts` bundles this and drives it):
 *
 *   ?view=sections        all three sections: Stopped on you, Needs you, With ferrets (folded), plus a notice
 *   ?view=sections-open   the same with "With ferrets" unfolded
 *   ?view=warden          `/inbox?from=warden`: the "From Warden" chip and only what the Warden raised
 *   ?view=open            an item OPEN: who and what, the chat's full item view and the ferret's REAL composer
 *                         under it (`inbox-v2-screenshot.ts` drags it mid-swipe up and down)
 *   ?view=open-long       a LONG item open (premise, context, options, terms, a picture): one scroll for all of it
 *   ?view=to-test         the Needs you section with cards waiting for the owner's try among the agenda items
 *   ?view=quick-to-test   the quick-answer run already on the first card waiting for a try (a wide screen has no button)
 *   ?view=open-5|open-7   an item with five or seven options: the row of three, the rest in full-width rows
 *   ?view=gate            a GATE item open ("Try it", the card's How to test as its body, Done / Not good)
 *   ?view=gate-list       the list with that gate item first among the question items (one stream)
 *   ?view=form            a FORM item open: radios, checkboxes, Yes/No and a text field, the composer its one Send
 *
 * The REAL `AgendaInboxPage` and `Composer`; only the data is invented and nothing is sent anywhere.
 */

import { type AgendaItem, boardOk, type SessionView } from '@ferretry/protocol';
import { type ReactElement, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { AgendaInboxComposer } from '../src/features/agenda/agenda-inbox-composer.tsx';
import { AgendaInboxPage } from '../src/features/agenda/agenda-inbox-page.tsx';
import type { ToTestHost } from '../src/features/agenda/to-test-rows.tsx';
import type { AgendaInbox } from '../src/hooks/use-agenda-inbox.ts';
import type { ClearPort } from '../src/lib/agenda-clear-agents.ts';
import { DeferredAgendaActions, type InboxCard, inboxCardKey } from '../src/lib/agenda-inbox.ts';
import { type DaemonConnection, daemonConnection, daemonId } from '../src/lib/daemon-connection.ts';
import { ScrollMemory } from '../src/lib/scroll-memory.ts';
import type { TranscriptEntry } from '../src/lib/session-screens.ts';
import { toTestCards, withProjectName, withTaskName } from '../src/lib/to-test-inbox.ts';
import { AppBar, AppTabBar } from '../src/shell/app-bar.tsx';
import { PageScrollRegion } from '../src/shell/page-scroll-region.tsx';
import { PullToPaletteRegion } from '../src/shell/pull-to-palette-region.tsx';
import { healthOf } from '../tests/support/health.ts';
import { sessionView } from '../tests/support/sessions.ts';
import {
  card as boardCard,
  laptop as boardLaptop,
  boardModelOf,
  OTHER_PROJECT,
  PROJECT,
} from '../tests/unit/board-support.ts';
import { RICH_HOW_TO_TEST, richRequested } from './rich-how-to-test.ts';

const NOW = Date.parse('2026-10-29T09:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const ahead = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
const STUDIO = daemonId('studio');
const LAPTOP = daemonId('laptop');

const item = (id: string, minutes: number, by: string, patch: Partial<AgendaItem>): AgendaItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}`,
    why: 'Needs a decision.',
    waitingSince: ago(minutes),
    howToResolve: 'Answer it.',
    raisedBy: 'agent',
    raisedBySession: 'fr',
    raisedByName: by,
    ...patch,
  }) as AgendaItem;

/** The board card each conversation works on. */
const CARDS: Readonly<Record<string, string>> = { rc: 'F41', ra: 'F38', fr: 'F52', mg: 'F47' };

const ferret = (
  id: string,
  teammate: string,
  label: string,
  agenda?: { readonly open: number; readonly first: string; readonly ask: string; readonly stopped?: boolean },
): SessionView =>
  sessionView(id, {
    config: {
      teammate: teammate as never,
      label,
      name: label,
      cwd: `/home/kirin/Workspace/${id}`,
      ...(CARDS[id] === undefined ? {} : { focusTask: { id: CARDS[id] } }),
    } as never,
    state: {
      lastActivityAt: ago(1),
      ...(agenda === undefined ? {} : { attention: { ...agenda, latestAt: ago(2) } }),
    } as never,
  });

const card = (it: AgendaItem, view: SessionView, machine: string, daemon = STUDIO): InboxCard => ({
  key: inboxCardKey(daemon, view.config.id, it.id),
  daemonId: daemon,
  machineName: machine,
  view,
  item: it,
});

/** The owner's own chats; every other ferret here is an agent (`mode: 'auto'`), what the Agents filter keeps. */
const chat = (view: SessionView): SessionView => ({ ...view, config: { ...view.config, mode: 'interactive' } });

const LEDGER = chat(ferret('rc', 'ottilie', 'Ledger storage', { open: 1, first: 'A5', ask: 'storage', stopped: true }));
const RELAY = ferret('ra', 'hadi', 'Relay advertisement', { open: 2, first: 'A2', ask: 'relay' });
const RELEASE = chat(ferret('fr', 'johnnie', 'Release cut', { open: 1, first: 'A3', ask: 'rebase' }));
const RUNTIME = ferret('mg', 'maryah', 'Runtime migration', { open: 1, first: 'A6', ask: 'login' });
const NIGHTLY = ferret('nl', 'zelda', 'Nightly benchmarks');
const CARE = ferret('wd', 'warden', 'Machine care');

const A5 = item('A5', 12, 'ottilie', {
  title: 'Which storage engine for the ledger?',
  subject: 'Which storage engine should keep the ledger: SQLite or Postgres?',
  blockingNow: true,
  premise: '- The ledger keeps every finished task, forever\n- It is read when the board opens, and rarely after',
  context:
    '- The storage layer lands this week, so the choice is **now**\n- Postgres is one more service to run and patch',
  recommendation: { decision: 'SQLite', why: 'One file next to the daemon, nothing new to run.' },
  terms: [{ term: 'WAL', meaning: 'write-ahead log: how SQLite keeps a write safe if the machine stops' }],
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'SQLite', description: 'One file, no server to run' },
      { label: 'Postgres', description: 'A server to run and patch' },
    ],
  },
} as Partial<AgendaItem>);
const A2 = item('A2', 9, 'hadi', {
  title: 'Restart the staging relay?',
  subject: 'Can I restart the staging relay? It drops live sessions for about ten seconds.',
  neededBy: ahead(480),
  ask: { kind: 'permission' },
} as Partial<AgendaItem>);
const A3 = item('A3', 2, 'johnnie', {
  title: 'Rebase onto main now?',
  subject: 'Rebase onto main now, or wait for #768 to merge?',
  willBlock: 'the release cut',
  ask: { kind: 'multiple-choice', options: [{ label: 'Rebase now' }, { label: 'Wait' }] },
} as Partial<AgendaItem>);
const A6 = item('A6', 25, 'maryah', {
  title: 'Which login should the runtime use?',
  subject: 'Which login should the new runtime use, the personal one or the team one?',
  ask: { kind: 'open-question' },
});
const N1 = item('A22', 4, 'hadi', {
  subject: 'The relay latency benchmark is back under 40 ms after the cache fix.',
  why: 'The relay latency benchmark is back under 40 ms after the cache fix.',
  notice: true,
  kind: 'info',
} as Partial<AgendaItem>);
const WITH = (id: string, minutes: number, title: string): AgendaItem =>
  item(id, minutes + 20, 'zelda', {
    title,
    subject: title,
    ask: { kind: 'open-question' },
    waitingOn: 'ferret',
    waitingFor: 'discussion',
    askedAt: ago(minutes),
  } as Partial<AgendaItem>);
const warden = (id: string, minutes: number, title: string, subject: string, key: string): AgendaItem =>
  item(id, minutes, 'warden', {
    title,
    subject,
    why: subject,
    raisedBy: 'daemon',
    sourceRef: `warden:ask:fleet:cleanup:${key}`,
    ask: { kind: 'permission' },
  } as Partial<AgendaItem>);
const W1 = warden(
  'A30',
  40,
  'Clear 14 stale worktrees?',
  'Fourteen worktrees have not been touched for 30 days.',
  'wt',
);
const W2 = warden('A31', 70, 'Drop two old build caches?', 'Two caches are 18 GB and unused since August.', 'cache');

const options = (labels: readonly string[]) => ({
  kind: 'multiple-choice' as const,
  options: labels.map(label => ({ label })),
});
const LONG = item('A40', 6, 'ottilie', {
  title: 'Move the ledger to SQLite?',
  subject: 'Should the ledger move from flat files to SQLite before the board ships on Friday?',
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'Move now', description: 'One evening of work; the board ships on SQLite' },
      { label: 'After Friday', description: 'Ship on flat files, move next week' },
      { label: 'Postgres', description: 'A server to run, patch and back up' },
    ],
  },
  recommendation: { decision: 'Move now', why: 'Nothing new to run, and every read gets faster.' },
  premise:
    '- The ledger keeps every finished task, forever\n- It is read in full each time the board opens\n- On the studio machine that read now takes **1.8 s**\n- The files are rewritten whole on every change',
  context:
    '- The board ships on **Friday** and opens the ledger first\n- A slow first paint is the first thing the owner sees\n- SQLite is already a dependency of the daemon\n- Moving later means migrating live data twice',
  decided: '- Finished tasks are kept forever\n- The ledger stays on the machine',
  stillOpen: '- When to move\n- Whether a server database is worth running',
  terms: [
    { term: 'WAL', meaning: 'write-ahead log: how SQLite keeps a write safe if the machine stops' },
    { term: 'ledger', meaning: "the board's record of every finished task" },
    { term: 'first paint', meaning: 'the moment the board first shows anything' },
  ],
  body: 'How the read time grew as the ledger did:\n\n![Read time by ledger size](/fleet-grid.svg)\n\nThe move is a one-off copy; the old files stay as a backup for a month.',
} as Partial<AgendaItem>);
const FIVE = item('A41', 8, 'hadi', {
  title: 'Which region for the relay?',
  subject: 'Which region should the second relay run in?',
  ask: options(['Frankfurt', 'London', 'Virginia', 'Oregon', 'Singapore']),
  recommendation: { decision: 'Frankfurt', why: 'Closest to most of the fleet.' },
  premise: '- One relay serves every phone today',
  context: '- A second one halves the round trip for half the fleet',
} as Partial<AgendaItem>);
const SEVEN = item('A42', 10, 'johnnie', {
  title: 'Which day for the release?',
  subject: 'Which day should the next release go out?',
  ask: options(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']),
  recommendation: { decision: 'Tuesday', why: 'Everyone is around for two days after it.' },
  premise: '- The release train is ready',
  context: '- A release needs two quiet days after it',
} as Partial<AgendaItem>);
const FORM = item('A43', 5, 'ottilie', {
  title: 'Set up the new relay',
  kind: 'form',
  subject: 'Four things I need before I can set up the second relay.',
  ask: { kind: 'open-question' },
  premise:
    '- The second relay halves the round trip for half the fleet\n- It needs a region, its alerts and a restart window',
  context: '- Restarting drops live sessions for about ten seconds',
  fields: [
    {
      id: '1',
      type: 'one',
      label: 'Which region should it run in?',
      name: 'Region',
      options: [
        { label: 'EU', description: 'data stays in Europe' },
        { label: 'US', description: 'cheapest' },
        { label: 'Asia', description: 'closest to the build box' },
      ],
      recommended: ['EU'],
    },
    {
      id: '2',
      type: 'many',
      label: 'Which alerts should page you?',
      name: 'Alerts',
      options: [
        { label: 'Relay down', description: 'no session can connect' },
        { label: 'High latency', description: 'over 200 ms for five minutes' },
        { label: 'Disk full', description: 'logs stop being kept' },
      ],
    },
    { id: '3', type: 'yesno', label: 'OK to restart the old relay tonight?', name: 'Restart', recommended: ['Yes'] },
    { id: '4', type: 'text', label: 'Anything else I should know?', name: 'Notes', required: false },
  ],
} as unknown as Partial<AgendaItem>);
/** A board card waiting at the "Try it" gate, as the daemon raises it: an ordinary choice item plus `gate`. */
const GATE = item('G61', 3, 'daemon', {
  title: 'Pairing a second phone',
  subject: 'Try it: open Settings and choose Pair a device',
  why: 'Pairing a second phone is in To test.',
  premise: 'Pairing a second phone',
  body: '1. Open Settings and choose **Pair a device**.\n2. Scan the code from a second phone.\n3. Check both phones show in Devices.',
  kind: 'choice',
  raisedBy: 'daemon',
  raisedBySession: null,
  raisedByName: null,
  ask: { kind: 'multiple-choice', options: [{ label: 'Done' }, { label: 'Not good' }] },
  gate: {
    cardId: 'F61',
    laneId: 'tested',
    laneName: 'To test',
    entry: 1,
    projectId: 'p1',
    projectName: 'ferretry',
    options: [
      { id: 'o0', label: 'Done', outcome: 'close' },
      { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
    ],
  },
} as Partial<AgendaItem>);
const GATE_CARD = card(GATE, chat(ferret('gt', 'judson', 'Pairing a second phone')), 'studio');
/** The items the open-* views open: drawn first, so each is the top card. */
const OPENED: Readonly<Record<string, InboxCard>> = {
  'open-long': card(LONG, LEDGER, 'studio'),
  'open-5': card(FIVE, RELAY, 'studio'),
  'open-7': card(SEVEN, RELEASE, 'studio'),
  form: card(FORM, RELAY, 'studio'),
  gate: GATE_CARD,
  'gate-list': GATE_CARD,
};

/** `?only=A5,A2` keeps just those open items: a short run that can be finished from the keyboard. */
const ONLY = new URLSearchParams(location.search).get('only')?.split(',') ?? null;
const OWNER: readonly InboxCard[] = (
  [
    card(A5, LEDGER, 'studio'),
    card(A2, RELAY, 'studio'),
    card(N1, RELAY, 'studio'),
    card(A3, RELEASE, 'studio'),
    card(A6, RUNTIME, 'laptop', LAPTOP),
    card(W1, CARE, 'studio'),
    card(W2, CARE, 'studio'),
  ] as readonly InboxCard[]
).filter(entry => ONLY === null || ONLY.includes(entry.item.id));
const FERRET: readonly InboxCard[] = [
  card(WITH('A9', 11, 'Pick the staging region'), NIGHTLY, 'studio'),
  card(WITH('A10', 4, 'Which cache to drop?'), NIGHTLY, 'studio'),
];

const PARKED_SNOOZED = (id: string, title: string, until: number): AgendaItem =>
  item(id, 90, 'hadi', {
    title,
    subject: title,
    ask: { kind: 'permission' },
    parked: { reason: 'snoozed', at: ago(60), until: new Date(until).toISOString() },
  } as Partial<AgendaItem>);
/** Parked items come from the boards the page read, not the daemon summary: snoozed, then replied. */
const PARKED: readonly InboxCard[] = [
  card(PARKED_SNOOZED('A50', 'Waiting for the deploy approval', NOW + 5 * 3_600_000), RELEASE, 'studio'),
  card(PARKED_SNOOZED('A51', 'Check the nightly benchmark', NOW + 27 * 3_600_000), NIGHTLY, 'studio'),
  card(
    item('A52', 120, 'ottilie', {
      title: 'Which storage engine for the ledger?',
      subject: 'Which storage engine should keep the ledger: SQLite or Postgres?',
      ask: { kind: 'open-question' },
      parked: { reason: 'replied', at: ago(18) },
    } as Partial<AgendaItem>),
    LEDGER,
    'studio',
  ),
];

const memory = new ScrollMemory(null);

/** The open item's composer talks to this machine: a fake one, whose sends go nowhere. */
const MACHINE: DaemonConnection = daemonConnection({
  daemonId: 'studio',
  baseUrl: 'https://studio.example.test',
  deviceId: 'harness',
});
/** What the conversation holds about the open item (a daemon-raised gate item is mentioned by nobody: none). */
const conversationAbout = async (open: InboxCard): Promise<readonly TranscriptEntry[]> =>
  open.item.gate !== undefined
    ? []
    : [
        {
          id: 'c1',
          kind: 'assistant',
          text: `I need a call on !${open.item.id}: **SQLite** is quick to ship, Postgres is safer long term.`,
          at: NOW - 50 * 60_000,
        },
        {
          id: 'c2',
          kind: 'user',
          text: `Is Postgres overkill for !${open.item.id}? Lean toward SQLite.`,
          at: NOW - 30 * 60_000,
        },
        {
          id: 'c3',
          kind: 'assistant',
          text: `Not overkill, but the ledger is read in full once a day, so SQLite fits !${open.item.id}. I will wait for your answer.`,
          at: NOW - 20 * 60_000,
        },
      ];
/** Studio offers clearing; the laptop's daemon is older and does not — so the dialog shows both cases. */
const CLEAR_PORT: ClearPort = {
  readHealth: async connection => ({
    kind: 'read',
    health: healthOf('5.0.0', connection.daemonId === STUDIO ? ['agenda.clear-agents.1'] : []),
  }),
  fetcher: async () =>
    new Response(JSON.stringify({ cleared: 5, sessions: 3 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
};
/** Cards waiting for the owner's try, from a real board model; nothing is sent, a move is only noted on the window. */
const TO_TEST_VIEW = ['to-test', 'quick-to-test'].includes(new URLSearchParams(location.search).get('view') ?? '');
const LEAD_TASKS = new Map([['mvuc7tsf-0c3d50df', 'Credentials Build Lead']]);
const PROJECT_NAMES = new Map([
  [PROJECT, 'ferretry'],
  [OTHER_PROJECT, 'diene'],
]);
const TO_TEST = TO_TEST_VIEW
  ? toTestCards(
      await boardModelOf([
        boardCard('F61', {
          laneId: 'tested',
          owner: 'mvuc7tsf-0c3d50df',
          title: 'Pairing a second phone',
          shippedIn: { version: '5.4.0', tag: 'v5.4.0', at: ago(90) },
          howToTest: richRequested()
            ? RICH_HOW_TO_TEST
            : '1. Open Settings and choose Pair a device.\n2. Scan the code from a second phone.\n3. Check both phones show in Devices.',
        }),
        boardCard('F58', {
          laneId: 'tested',
          owner: 'mvuc7tsf-0c3d50df',
          projectId: OTHER_PROJECT,
          title: 'Faster board loading',
          shippedIn: { version: '5.3.2', tag: 'v5.3.2', at: ago(60 * 26) },
          howToTest: '1. Open the Board on a phone.\n2. It should draw in under a second.',
        }),
        // A ferret's own sub-work: it stays on the board and never reaches the owner's To test list.
        boardCard('F59', {
          laneId: 'tested',
          askedBy: 'agent',
          title: 'Review: faster board loading',
          shippedIn: { version: '5.3.2', tag: 'v5.3.2', at: ago(60 * 25) },
          howToTest: '1. Read the diff.',
        }),
      ]),
    ).map(row => withProjectName(withTaskName(row, LEAD_TASKS), PROJECT_NAMES))
  : [];
/** One card the owner parked ("?snoozed=1"): it is out of To test and listed under Snoozed with when it wakes. */
const TO_TEST_SNOOZED =
  TO_TEST_VIEW && new URLSearchParams(location.search).get('snoozed') === '1'
    ? toTestCards(
        await boardModelOf([
          boardCard('F70', {
            laneId: 'tested',
            owner: 'mvuc7tsf-0c3d50df',
            title: 'Offline banner wording',
            shippedIn: { version: '5.2.0', tag: 'v5.2.0', at: ago(60 * 30) },
            howToTest: '1. Turn the network off.\n2. Read the banner.',
            snoozed: { until: new Date(NOW + 5 * 3_600_000).toISOString(), laneId: 'tested' },
          }),
        ]),
      ).map(row => withTaskName(row, LEAD_TASKS))
    : [];
const TO_TEST_HOST: ToTestHost = {
  actions: {
    moveTask: async (target: { readonly taskId?: string; readonly id?: string }, to: string, reason?: string) => {
      const win = window as unknown as { __moves?: unknown[] };
      const moves = win.__moves ?? [];
      win.__moves = moves;
      moves.push({ id: target.taskId ?? target.id, to, reason });
      return boardOk(boardCard('F61'));
    },
    snoozeTask: async (target: { readonly id?: string }, until: string | null) => {
      const win = window as unknown as { __snoozes?: unknown[] };
      const snoozes = win.__snoozes ?? [];
      win.__snoozes = snoozes;
      snoozes.push({ id: target.id, until });
      return boardOk(boardCard('F61'));
    },
  } as unknown as ToTestHost['actions'],
  ports: {},
  connectionOf: () => boardLaptop,
};
const FAKE_CLIENT = { send: async () => ({}) as never };
const committed: unknown[] = [];
(window as unknown as { __committed: unknown[] }).__committed = committed;
const deferred = new DeferredAgendaActions(async (_card, action) => {
  committed.push(action);
});

function Inbox({
  phone,
  from,
  withFerretsOpen,
  openAt,
  extra,
}: {
  readonly phone: boolean;
  readonly from: 'warden' | null;
  readonly withFerretsOpen: boolean;
  readonly openAt?: string | undefined;
  readonly extra?: InboxCard | undefined;
}): ReactElement {
  const state = useSyncExternalStore(deferred.subscribe, deferred.getSnapshot);
  const [source, setSource] = useState(from);
  const held = new Set([...state.pending.map(entry => entry.key), ...state.sending]);
  const inbox: AgendaInbox = {
    unread: [],
    total: OWNER.length + (extra === undefined ? 0 : 1) + TO_TEST.length,
    cards: (extra === undefined ? OWNER : [extra, ...OWNER]).filter(card => !held.has(card.key)),
    withFerret: FERRET,
    reading: false,
    unavailable: [],
    resolved: [],
    resolvedReading: false,
    parked: PARKED,
    loadResolved: () => undefined,
    deferred,
    deferredState: state,
    connectionFor: id => (id === LAPTOP ? { ...MACHINE, daemonId: LAPTOP } : MACHINE),
    toTest: TO_TEST,
    toTestSnoozed: TO_TEST_SNOOZED,
  };
  return (
    <div className={`kt-shell flex overflow-hidden ${phone ? 'flex-col' : 'flex-row'}`} data-fixture="">
      <div data-shell-main="" className="flex min-h-0 min-w-0 flex-1 flex-col">
        {new URLSearchParams(location.search).get('bar') === '1' ? (
          <AppBar
            active="attention"
            agendaCount={inbox.total}
            crumbs={[{ label: 'Inbox' }]}
            daemon={STUDIO}
            onNavigate={() => undefined}
            onOpenPalette={() => undefined}
            onOpenSidebar={() => undefined}
            tabBarShown={phone}
          />
        ) : null}
        <PullToPaletteRegion
          className={`relative min-h-0 min-w-0 flex-1 px-1 sm:px-3${phone ? ' overflow-clip' : ''}`}
          enabled={false}
          onOpen={() => undefined}
        >
          <PageScrollRegion entryKey="inbox" memory={memory}>
            <AgendaInboxPage
              clearPort={CLEAR_PORT}
              toTestHost={TO_TEST_HOST}
              from={source}
              inbox={inbox}
              now={NOW}
              onClearFrom={() => setSource(null)}
              onNavigate={() => undefined}
              phone={phone}
              withFerretsOpen={withFerretsOpen}
              reducedMotion
              readConversation={conversationAbout}
              {...(openAt === undefined ? {} : { initialOpen: openAt })}
              renderComposer={(open, answerForm) => (
                <AgendaInboxComposer
                  clientFor={async () => FAKE_CLIENT}
                  compact={phone}
                  key={open.key}
                  {...(answerForm === undefined ? {} : { answerForm })}
                  formKey={open.key}
                  connection={MACHINE}
                  itemId={open.item.id}
                  view={open.view}
                />
              )}
            />
          </PageScrollRegion>
        </PullToPaletteRegion>
        {phone ? (
          <AppTabBar
            active="attention"
            agendaCount={inbox.total}
            daemon={STUDIO}
            onNavigate={() => undefined}
            onOpenPalette={() => undefined}
          />
        ) : null}
      </div>
    </div>
  );
}

const view = new URLSearchParams(location.search).get('view') ?? 'sections';
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <Inbox
    from={view === 'warden' ? 'warden' : null}
    phone={window.innerWidth < 768}
    withFerretsOpen={view === 'sections-open'}
    openAt={
      view === 'open'
        ? OWNER[0]?.key
        : view === 'quick-to-test'
          ? TO_TEST[0]?.key
          : view === 'gate-list'
            ? undefined
            : OPENED[view]?.key
    }
    extra={OPENED[view]}
  />,
);
