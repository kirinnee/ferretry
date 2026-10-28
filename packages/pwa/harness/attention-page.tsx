/**
 * The Attention surfaces on one page each (`attention-screenshot.ts` bundles this): the two-pane inbox
 * (a phone list, a desktop list beside a real-shaped chat), the pinned item above a composer, and the
 * sessions bar — column and collapsed rail — with unread rows.
 *
 * Every component is the REAL one; only the data is invented, and nothing leaves the page: answers are
 * held by a real `DeferredAttentionActions` whose commit does nothing.
 */

import type { AttentionId, AttentionItem, AttentionSnapshot, SessionView } from '@ferretry/protocol';
import { type ReactElement, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from '../src/components/markdown.tsx';
import { AttentionBoard } from '../src/features/attention/attention-board.tsx';
import { AttentionInboxPage } from '../src/features/attention/attention-inbox-page.tsx';
import { AttentionPanel } from '../src/features/attention/attention-panel.tsx';
import type { AttentionInbox } from '../src/hooks/use-attention-inbox.ts';
import { DeferredAttentionActions, type InboxCard, inboxCardKey } from '../src/lib/attention-inbox.ts';
import { daemonConnection, daemonId } from '../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../src/lib/daemon-scope.ts';
import { daemonAttentionPath } from '../src/lib/pages/routes.ts';
import { AppTabBar } from '../src/shell/app-bar.tsx';
import { SessionsBar } from '../src/shell/sessions-bar.tsx';
import { sessionView } from '../tests/support/sessions.ts';

const NOW = Date.parse('2026-10-23T09:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const STUDIO = daemonId('studio');
const LAPTOP = daemonId('laptop');
const CONNECTION = daemonConnection({ daemonId: STUDIO, baseUrl: 'https://studio.example.test', deviceId: 'harness' });

const item = (id: string, minutes: number, patch: Partial<AttentionItem>): AttentionItem =>
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
    raisedByName: 'ottilie',
    ...patch,
  }) as AttentionItem;

const REBASE = item('A3', 2, {
  subject: 'Rebase onto main now, or wait for #768 to merge?',
  why: 'main moved 14 commits since this branch was cut and two of them touch the attention store.',
  context: 'I am halfway through the inbox wiring; a rebase now costs ~5 minutes, later maybe more.',
  ask: { kind: 'multiple-choice', options: [{ label: 'Rebase now' }, { label: 'Wait' }, { label: 'Skip' }] },
});
const DEPLOY = item('A2', 9, {
  subject: 'Can I restart the staging relay?',
  why: 'The relay is serving a stale advertisement; a restart drops live sessions for ~10 seconds.',
  raisedByName: 'hadi',
});
const LONG = item('A1', 41, {
  subject: 'Which login should the new runtime use?',
  why: 'Two logins can run this harness and they bill differently.',
  context:
    'The runtime claude-default currently uses the login claude-you, which is on the personal plan, while ' +
    'claude-atomi uses the team plan with a higher weekly allowance. The task you gave me will run for several ' +
    'hours across three sub-ferrets, so it will likely exhaust the personal allowance before it finishes. ' +
    'Switching mid-run restarts each sub-ferret, which loses their in-flight context, so it is better to decide ' +
    'now. If you do not mind the cost, the team login is the safer choice; otherwise I will throttle the ' +
    'sub-ferrets to stay inside the personal allowance and the whole job will take roughly twice as long.',
  ask: { kind: 'open-question' },
  raisedByName: 'maryah',
});

const RICH = item('A5', 12, {
  subject: 'Which storage engine for the board, and when do we migrate?',
  why: 'Which storage engine for the board, and when do we migrate?',
  context:
    '- The board keeps its ledger in memory\n- A daemon restart forgets every resolved item\n- Two stores could fix it; they differ in what they ask of the machine',
  terms: [
    { term: 'WAL', meaning: 'A log written before the data, so a crash can be replayed.' },
    { term: 'Ledger', meaning: 'The list of every item raised, open and resolved.' },
    { term: 'Migration', meaning: 'Moving the existing items into the new store once.' },
  ],
  questions: [
    {
      question: 'Which engine should hold the ledger?',
      options: [
        { label: 'SQLite', description: 'One file, no server.' },
        { label: 'Postgres', description: 'A server to run and patch.' },
      ],
      recommended: 'SQLite',
      why: 'It needs nothing installed on the machine.',
    },
    {
      question: 'When should the migration run?',
      options: [{ label: 'On next start' }, { label: 'After release' }],
      recommended: 'On next start',
    },
  ],
  recommendation: { decision: 'SQLite, migrating on next start', why: 'Smallest change that survives a restart.' },
  impact: '- Resolved items are lost on every daemon restart\n- Nothing else is blocked',
  urgency: 'Before the release cut on Friday',
  links: [
    { label: 'Storage notes', target: 'https://example.test/docs/storage' },
    { label: 'Ledger module', target: 'packages/daemon/src/lib/attention.ts' },
  ],
  ask: { kind: 'open-question' },
});
const SINGLE = item('A6', 25, {
  subject: 'Use SQLite for the ledger?',
  why: 'Use SQLite for the ledger?',
  context: 'It is one file and needs no server.',
  questions: [
    {
      question: 'Use SQLite for the ledger?',
      options: [{ label: 'Yes, SQLite' }, { label: 'No, Postgres' }],
      recommended: 'Yes, SQLite',
      why: 'No server to run.',
    },
  ],
  recommendation: { decision: 'Yes, SQLite' },
  impact: 'The ledger stays in memory.',
  ask: { kind: 'multiple-choice', options: [{ label: 'Yes, SQLite' }, { label: 'No, Postgres' }] },
});
const OLD = item('A7', 5, {
  subject: 'Can I delete the stale build cache?',
  why: 'It is 4 GB and nothing reads it.',
  context: 'Last used three weeks ago.',
  ask: { kind: 'permission' },
});

const FENCE = '```';
const TASK_STEPS = [
  'Store the relay key: `fy secret set RELAY_KEY`',
  'Check the advertisement lists it:\n\n' +
    FENCE +
    'sh\nfy relay status --json | jq .directory\nfy relay status --watch\n' +
    FENCE,
  'Compare with the diagram below and confirm it matches !A3\n\n' +
    FENCE +
    'fy-render\ntype: mermaid\nalt: key to relay to sessions\n---\nflowchart LR\n  key[New key] --> relay[Relay]\n  relay --> sessions[Sessions]\n' +
    FENCE,
  'Restart the relay: `fy daemon restart`',
];
const TASK = item('A8', 14, {
  subject: 'Rotate the relay key on the studio machine',
  why: 'The old key was pasted into a chat; rotate it before the release cut.',
  body:
    '## Before you start\n\n- You need shell access to **studio**\n- It takes about five minutes\n\nThe daemon keeps running; only the relay restarts at the end. A summary of the key path:\n\n' +
    FENCE +
    'sh\nfy secret list\n' +
    FENCE +
    '\n\nSee [the secrets doc](https://example.test/docs/secrets).',
  steps: TASK_STEPS,
  ask: { kind: 'task' },
  raisedByName: 'ottilie',
  history: [{ at: ago(30), kind: 'updated', note: 'added the restart step' }],
} as Partial<AttentionItem>);
const taskWith = (done: readonly number[]): AttentionItem => ({ ...TASK, stepsDone: [...done] }) as AttentionItem;
const WAITING = item('A9', 22, {
  subject: 'Pick the staging region for the relay',
  why: 'I cannot tell which region you meant.',
  body: 'Two regions are plausible: **eu-west** and **us-east**.',
  steps: ['Decide the region', 'Tell me which'],
  ask: { kind: 'task' },
  raisedByName: 'hadi',
  waitingOn: 'ferret',
  askedAt: ago(12),
  infoRequests: 1,
  history: [
    { at: ago(12), kind: 'needs-info', note: 'which region?' },
    { at: ago(10), kind: 'updated', note: 'added the two candidates' },
  ],
} as Partial<AttentionItem>);

const ferret = (id: string, teammate: string, label: string, patch: Partial<SessionView['state']> = {}) =>
  sessionView(id, {
    config: { teammate: teammate as never, label, cwd: `/home/kirin/Workspace/${id}` },
    state: { lastActivityAt: ago(1), ...patch },
  });

const summary = (open: number, first: string, ask: string, minutes: number) => ({
  attention: { open, first, ask, latestAt: ago(minutes) },
});

const SESSIONS: readonly SessionView[] = [
  ferret('fr', 'ottilie', 'Attention inbox wiring', summary(1, 'A3', REBASE.subject, 2)),
  ferret('hm', 'hadi', 'Relay advertisement', summary(2, 'A2', DEPLOY.subject, 9)),
  ferret('rt', 'maryah', 'Runtime migration', { status: 'awaiting_user' }),
  ferret('dw', 'wren', 'Docs sweep'),
  ferret('nl', 'zelda', 'Nightly benchmarks'),
];

const card = (it: AttentionItem, view: SessionView, machine: string, daemon = STUDIO): InboxCard => ({
  key: inboxCardKey(daemon, view.config.id, it.id),
  daemonId: daemon,
  machineName: machine,
  view,
  item: it,
});

const CARDS: readonly InboxCard[] = [
  card(REBASE, SESSIONS[0] as SessionView, 'studio'),
  card(DEPLOY, SESSIONS[1] as SessionView, 'studio'),
  card(LONG, ferret('mg', 'maryah', 'Runtime migration'), 'laptop', LAPTOP),
  card(RICH, ferret('rc', 'ottilie', 'Ledger storage'), 'studio'),
];

// Answers are held for the real undo window, then "sent" nowhere.
const deferred = new DeferredAttentionActions(async () => undefined);

function Inbox({
  phone,
  cards = CARDS,
}: {
  readonly phone: boolean;
  readonly cards?: readonly InboxCard[];
}): ReactElement {
  const state = useSyncExternalStore(deferred.subscribe, deferred.getSnapshot);
  const hidden = deferred.hiddenKeys();
  const inbox: AttentionInbox = {
    unread: [],
    total: cards.length,
    cards: cards.filter(entry => !hidden.has(entry.key)),
    reading: false,
    deferred,
    deferredState: state,
    connectionFor: () => undefined,
  };
  return (
    <div className="flex h-dvh flex-col bg-bg" data-fixture="">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AttentionInboxPage
          inbox={inbox}
          now={NOW}
          onNavigate={() => undefined}
          phone={phone}
          renderChat={selected => (
            <div className="min-h-0 flex-1">
              <ChatPane
                board={boardOf(...(selected.item.id === 'A3' ? [selected.item] : [selected.item, REBASE]))}
                target={selected.item.id}
              />
            </div>
          )}
        />
      </div>
      {phone ? (
        <AppTabBar
          active="attention"
          attentionCount={inbox.total}
          daemon={STUDIO}
          onNavigate={() => undefined}
          onOpenPalette={() => undefined}
        />
      ) : null}
    </div>
  );
}

const TASK_CARDS: readonly InboxCard[] = [
  card(taskWith([0, 1]), ferret('fr', 'ottilie', 'Attention inbox wiring'), 'studio'),
  card(WAITING, SESSIONS[1] as SessionView, 'studio'),
  card(REBASE, SESSIONS[0] as SessionView, 'studio'),
];

const BOARD: AttentionSnapshot = {
  v: 1,
  sessionId: 'fr',
  items: [DEPLOY, REBASE].map(entry => ({ ...entry, raisedBySession: 'fr' })) as AttentionItem[],
  resolved: [
    {
      ...item('A1', 80, { subject: 'Use the shared fixture for the inbox tests?' }),
      resolvedAt: ago(30),
      resolutionNote: null,
      response: { kind: 'multiple-choice', choice: 'Yes' },
      ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
      disposition: 'done',
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
    } as AttentionSnapshot['resolved'][number],
  ],
  count: 2,
  parseErrors: 0,
  updatedAt: ago(1),
};

const OVERLOAD = item('A1', 2880, {
  subject: 'Approve the OCI work-login plan (my picks for A–D) or reply with changes',
  why: 'Approve the OCI work-login plan (my picks for A–D) or reply with changes',
  context:
    "The plan is in this session's chat. It adds modules/oci-work-session: oci-work-login plus a launchd keepalive every 30 min, on both Macs, so a login that expires does not leave you logged out of every account. Pick A–D as drafted or tell me what to change before I apply it to both machines.",
  ask: { kind: 'multiple-choice', options: [{ label: 'Go with the defaults' }, { label: "I'll reply with changes" }] },
});
const OVERLOAD_BOARD: AttentionSnapshot = {
  ...BOARD,
  items: [{ ...OVERLOAD, raisedBySession: 'fr' }] as AttentionItem[],
  resolved: [],
  count: 1,
};

const boardOf = (...items: AttentionItem[]): AttentionSnapshot => ({
  ...OVERLOAD_BOARD,
  items: items.map(entry => ({ ...entry, raisedBySession: 'fr' })) as AttentionItem[],
  count: items.length,
});

function BoardPage(): ReactElement {
  return (
    <div className="flex h-dvh flex-col bg-bg" data-fixture="">
      <AttentionBoard
        connection={CONNECTION}
        error={null}
        loading={false}
        now={NOW}
        onAction={async () => undefined}
        snapshot={boardOf(RICH, SINGLE, OLD)}
      />
    </div>
  );
}

function ChatPane({
  board = BOARD,
  target = 'A3',
}: {
  readonly board?: AttentionSnapshot;
  readonly target?: string | null;
}): ReactElement {
  const [selected, setSelected] = useState<AttentionId | null>((target as AttentionId | null) ?? null);
  const [chip, setChip] = useState(true);
  const noop = async (): Promise<void> => undefined;
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="min-h-0 flex-1 overflow-y-auto p-panel">
        <article className="rounded-panel border border-border bg-surface p-panel text-cell" data-chat-line="">
          <p className="m-0 mb-xs text-meta text-faint">ottilie · 2m</p>
          <Markdown
            attentionReferenceResolver={id => board.items.some(entry => entry.id === id)}
            text="I raised !A3 about the rebase — pick an option when you can. Meanwhile I will keep going on the inbox."
          />
        </article>
      </div>
      <div className="p-panel">
        <AttentionPanel
          chip={{ on: chip, onChange: setChip }}
          client={{ respond: noop, resolve: noop, dismiss: noop, needsInfo: noop, progress: noop }}
          connection={CONNECTION}
          focus={target === null ? null : { target: target as AttentionId, seq: 1 }}
          id="attention-panel"
          now={NOW}
          onSelect={setSelected}
          scope={daemonSessionScope(CONNECTION, 'fr')}
          selectedId={selected}
          snapshot={board}
          status="ready"
        />
        <div className="rounded-panel border border-border bg-surface p-panel text-meta text-faint">
          Message ottilie…
        </div>
      </div>
    </div>
  );
}

function Panel(props: { readonly board?: AttentionSnapshot; readonly target?: string | null }): ReactElement {
  return (
    <div className="mx-auto h-dvh max-w-3xl" data-fixture="">
      <ChatPane {...props} />
    </div>
  );
}

function Bar({ presentation }: { readonly presentation: 'column' | 'rail' | 'drawer' }): ReactElement {
  return (
    <div className="flex bg-bg" data-fixture="" style={{ height: presentation === 'drawer' ? '100dvh' : 760 }}>
      <SessionsBar
        active={null}
        activeSessionId="dw"
        attentionHref={daemonAttentionPath(STUDIO)}
        attentionTotal={4}
        daemonId={STUDIO}
        initialMode="all"
        machineName="studio"
        machines={[{ daemonId: STUDIO, name: 'studio' }]}
        now={NOW}
        onAddMachine={() => undefined}
        onClose={() => undefined}
        onCollapse={() => undefined}
        onExpand={() => undefined}
        onNavigate={() => undefined}
        onOpenPalette={() => undefined}
        presentation={presentation}
        projects={[]}
        sessions={SESSIONS}
      />
    </div>
  );
}

const view = new URLSearchParams(location.search).get('view') ?? 'inbox-phone';
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  view === 'inbox-phone' ? (
    <Inbox phone />
  ) : view === 'inbox-desktop' ? (
    <Inbox phone={false} />
  ) : view === 'panel' ? (
    <Panel />
  ) : view === 'task-partial' ? (
    <Panel board={boardOf(taskWith([0, 1]), REBASE)} target="A8" />
  ) : view === 'task-full' ? (
    <Panel board={boardOf(taskWith([0, 1, 2, 3]), REBASE)} target="A8" />
  ) : view === 'task-waiting' ? (
    <Panel board={boardOf(WAITING)} target="A9" />
  ) : view === 'task-inbox-phone' ? (
    <Inbox cards={TASK_CARDS} phone />
  ) : view === 'task-inbox-desktop' ? (
    <Inbox cards={TASK_CARDS} phone={false} />
  ) : view === 'overload' ? (
    <Panel board={OVERLOAD_BOARD} target={null} />
  ) : view === 'rich' ? (
    <Panel board={boardOf(RICH)} target="A5" />
  ) : view === 'long' ? (
    <Panel board={boardOf(LONG)} target="A1" />
  ) : view === 'several' ? (
    <Panel board={boardOf(RICH, SINGLE, OLD)} target={null} />
  ) : view === 'board' ? (
    <BoardPage />
  ) : view === 'rail' ? (
    <Bar presentation="rail" />
  ) : view === 'drawer' ? (
    <Bar presentation="drawer" />
  ) : (
    <Bar presentation="column" />
  ),
);
