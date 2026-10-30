/**
 * The Inbox as the owner meets it, one view per URL (`agenda-screenshot.ts` bundles this and drives it):
 *
 *   ?view=sections        all three sections: Stopped on you, Needs you, With ferrets (folded), plus a notice
 *   ?view=sections-open   the same with "With ferrets" unfolded
 *   ?view=warden          `/inbox?from=warden`: the "From Warden" chip and only what the Warden raised
 *   ?view=open            an item OPEN: who and what, the chat's full item view, the swipe hint and the ferret's
 *                         REAL composer under it (`inbox-v2-screenshot.ts` drags it mid-swipe up and down)
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
const FAKE_CLIENT = { send: async () => ({}) as never };
const deferred = new DeferredAgendaActions(async () => undefined);

function Inbox({
  phone,
  from,
  withFerretsOpen,
  openAt,
}: {
  readonly phone: boolean;
  readonly from: 'warden' | null;
  readonly withFerretsOpen: boolean;
  readonly openAt?: string | undefined;
}): ReactElement {
  const state = useSyncExternalStore(deferred.subscribe, deferred.getSnapshot);
  const [source, setSource] = useState(from);
  const inbox: AgendaInbox = {
    unread: [],
    total: OWNER.length,
    cards: OWNER,
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
    openAt={view === 'open' ? OWNER[0]?.key : undefined}
  />,
);
