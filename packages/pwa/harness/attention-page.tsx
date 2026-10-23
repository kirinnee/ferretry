/**
 * The Attention surfaces on one page each (`attention-screenshot.ts` bundles this): the inbox (the
 * phone's swipe deck with its Attention tab, the desktop grid), the in-ferret panel over a transcript
 * line that references `!A3`, and the sessions bar — column and collapsed rail — with unread rows.
 *
 * Every component is the REAL one; only the data is invented, and nothing leaves the page: answers are
 * held by a real `DeferredAttentionActions` whose commit does nothing.
 */

import type { AttentionItem, AttentionSnapshot, SessionView } from '@ferretry/protocol';
import { type ReactElement, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from '../src/components/markdown.tsx';
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
];

// Answers are held for the real undo window, then "sent" nowhere.
const deferred = new DeferredAttentionActions(async () => undefined);

function Inbox({ phone }: { readonly phone: boolean }): ReactElement {
  const state = useSyncExternalStore(deferred.subscribe, deferred.getSnapshot);
  const hidden = deferred.hiddenKeys();
  const inbox: AttentionInbox = {
    unread: [],
    total: CARDS.length,
    cards: CARDS.filter(entry => !hidden.has(entry.key)),
    reading: false,
    deferred,
    deferredState: state,
    connectionFor: () => undefined,
  };
  return (
    <div className="flex h-dvh flex-col bg-bg" data-fixture="">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AttentionInboxPage inbox={inbox} now={NOW} onNavigate={() => undefined} phone={phone} />
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

function Panel(): ReactElement {
  const [expanded, setExpanded] = useState(true);
  const noop = async (): Promise<void> => undefined;
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-md bg-bg p-panel" data-fixture="">
      <AttentionPanel
        client={{ respond: noop, resolve: noop, dismiss: noop }}
        connection={CONNECTION}
        expanded={expanded}
        focus={{ target: 'A3', seq: 1 }}
        id="attention-panel"
        now={NOW}
        onExpandedChange={setExpanded}
        scope={daemonSessionScope(CONNECTION, 'fr')}
        snapshot={BOARD}
        status="ready"
      />
      <article className="rounded-panel border border-border bg-surface p-panel text-cell" data-chat-line="">
        <p className="m-0 mb-xs text-meta text-faint">ottilie · 2m</p>
        <Markdown
          attentionReferenceResolver={id => BOARD.items.some(entry => entry.id === id)}
          onAttentionOpen={() => setExpanded(true)}
          text="I raised !A3 about the rebase — pick an option when you can. Meanwhile I'll keep going on the deck."
        />
      </article>
    </main>
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
  ) : view === 'rail' ? (
    <Bar presentation="rail" />
  ) : view === 'drawer' ? (
    <Bar presentation="drawer" />
  ) : (
    <Bar presentation="column" />
  ),
);
