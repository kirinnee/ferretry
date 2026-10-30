/**
 * The Inbox as the owner meets it, one view per URL (`agenda-screenshot.ts` bundles this and drives it):
 *
 *   ?view=sections        all three sections: Stopped on you, Needs you, With ferrets (folded), plus a notice
 *   ?view=sections-open   the same with "With ferrets" unfolded
 *   ?view=warden          `/inbox?from=warden`: the "From Warden" chip and only what the Warden raised
 *   ?view=open            an item OPEN: who and what, the chat's full item view and the ferret's REAL composer
 *                         under it (`inbox-v2-screenshot.ts` drags it mid-swipe up and down)
 *   ?view=open-long       a LONG item open (premise, context, options, terms, a picture): one scroll for all of it
 *   ?view=open-5|open-7   an item with five or seven options: the row of three, the rest in full-width rows
 *
 * The REAL `AgendaInboxPage` and `Composer`; only the data is invented and nothing is sent anywhere.
 */

import type { AgendaItem, SessionView } from '@ferretry/protocol';
import { type ReactElement, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { AgendaInboxComposer } from '../src/features/agenda/agenda-inbox-composer.tsx';
import { AgendaInboxPage } from '../src/features/agenda/agenda-inbox-page.tsx';
import type { AgendaInbox } from '../src/hooks/use-agenda-inbox.ts';
import { DeferredAgendaActions, type InboxCard, inboxCardKey } from '../src/lib/agenda-inbox.ts';
import { type DaemonConnection, daemonConnection, daemonId } from '../src/lib/daemon-connection.ts';
import type { TranscriptEntry } from '../src/lib/session-screens.ts';
import { ScrollMemory } from '../src/lib/scroll-memory.ts';
import { AppTabBar } from '../src/shell/app-bar.tsx';
import { PageScrollRegion } from '../src/shell/page-scroll-region.tsx';
import { PullToPaletteRegion } from '../src/shell/pull-to-palette-region.tsx';
import { sessionView } from '../tests/support/sessions.ts';

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

const LEDGER = ferret('rc', 'ottilie', 'Ledger storage', { open: 1, first: 'A5', ask: 'storage', stopped: true });
const RELAY = ferret('ra', 'hadi', 'Relay advertisement', { open: 2, first: 'A2', ask: 'relay' });
const RELEASE = ferret('fr', 'johnnie', 'Release cut', { open: 1, first: 'A3', ask: 'rebase' });
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
/** The items the open-* views open: drawn first, so each is the top card. */
const OPENED: Readonly<Record<string, InboxCard>> = {
  'open-long': card(LONG, LEDGER, 'studio'),
  'open-5': card(FIVE, RELAY, 'studio'),
  'open-7': card(SEVEN, RELEASE, 'studio'),
};

const OWNER: readonly InboxCard[] = [
  card(A5, LEDGER, 'studio'),
  card(A2, RELAY, 'studio'),
  card(N1, RELAY, 'studio'),
  card(A3, RELEASE, 'studio'),
  card(A6, RUNTIME, 'laptop', LAPTOP),
  card(W1, CARE, 'studio'),
  card(W2, CARE, 'studio'),
];
const FERRET: readonly InboxCard[] = [
  card(WITH('A9', 11, 'Pick the staging region'), NIGHTLY, 'studio'),
  card(WITH('A10', 4, 'Which cache to drop?'), NIGHTLY, 'studio'),
];

const memory = new ScrollMemory(null);

/** The open item's composer talks to this machine: a fake one, whose sends go nowhere. */
const MACHINE: DaemonConnection = daemonConnection({
  daemonId: 'studio',
  baseUrl: 'https://studio.example.test',
  deviceId: 'harness',
});
/** What the conversation holds about the open item: the ferret's question, the owner's reply, the ferret's answer. */
const conversationAbout = async (open: InboxCard): Promise<readonly TranscriptEntry[]> => [
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
const FAKE_CLIENT = { send: async () => ({}) as never };
const deferred = new DeferredAgendaActions(async () => undefined);

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
  const inbox: AgendaInbox = {
    unread: [],
    total: OWNER.length + (extra === undefined ? 0 : 1),
    cards: extra === undefined ? OWNER : [extra, ...OWNER],
    withFerret: FERRET,
    reading: false,
    resolved: [],
    resolvedReading: false,
    loadResolved: () => undefined,
    deferred,
    deferredState: state,
    connectionFor: () => MACHINE,
  };
  return (
    <div className={`kt-shell flex overflow-hidden ${phone ? 'flex-col' : 'flex-row'}`} data-fixture="">
      <div data-shell-main="" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PullToPaletteRegion
          className={`relative min-h-0 min-w-0 flex-1 px-1 sm:px-3${phone ? ' overflow-clip' : ''}`}
          enabled={false}
          onOpen={() => undefined}
        >
          <PageScrollRegion entryKey="inbox" memory={memory}>
            <AgendaInboxPage
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
              renderComposer={open => (
                <AgendaInboxComposer
                  clientFor={async () => FAKE_CLIENT}
                  compact={phone}
                  connection={MACHINE}
                  itemId={open.item.id}
                  key={open.key}
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
    openAt={view === 'open' ? OWNER[0]?.key : OPENED[view]?.key}
    extra={OPENED[view]}
  />,
);
