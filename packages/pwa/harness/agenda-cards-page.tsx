/**
 * The v2 agenda card, one fixture per kind, drawn the way the phone deck draws it (`agenda-cards-
 * screenshot.ts` bundles this). Every component is the REAL one; only the data is invented, and each
 * fixture is self-contained — a plain title, a one-line ask, everything needed to decide on the card.
 *
 * `?view=<state>` picks the fixture; nothing leaves the page: an answer is swallowed by the deck's `onAct`.
 */

import type { AgendaItem } from '@ferretry/protocol';
import { type ReactElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgendaCard } from '../src/features/agenda/agenda-card.tsx';
import { AgendaRepliesNotice } from '../src/features/agenda/agenda-replies-notice.tsx';
import { AgendaSwipeDeck } from '../src/features/agenda/agenda-swipe-deck.tsx';
import type { InboxCard } from '../src/lib/agenda-inbox.ts';
import { inboxCardKey } from '../src/lib/agenda-inbox.ts';
import { daemonId } from '../src/lib/daemon-connection.ts';
import { sessionView } from '../tests/support/sessions.ts';

const NOW = Date.parse('2026-10-23T09:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const STUDIO = daemonId('studio');

const item = (id: string, minutes: number, patch: Partial<AgendaItem>): AgendaItem =>
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
  }) as AgendaItem;

const FENCE = '```';

const TASK = item('A1', 14, {
  title: 'Relay key rotation',
  subject: 'Rotate the relay key before Friday’s release, using the three steps below.',
  why: 'The old key was pasted into a chat; rotate it before Friday’s release.',
  body: 'It takes about five minutes and you need shell access to **studio**. Sessions keep running; only the relay restarts at the end.',
  steps: [
    'Store the new key: `fy secret set RELAY_KEY`',
    `Check the relay lists it:\n\n${FENCE}sh\nfy relay status --json | jq .directory\n${FENCE}`,
    'Restart the relay: `fy daemon restart`',
  ],
  stepsDone: [0],
  ask: { kind: 'task' },
  answers: [
    { direction: 'right', does: 'done', label: 'Done' },
    { direction: 'left', does: 'needs-info', label: 'Need more info' },
    { direction: 'up', does: 'dismiss', label: 'Skip', description: 'I will use the old key until after the release.' },
  ],
} as Partial<AgendaItem>);

const CHOICE = item('A2', 9, {
  title: 'Database for the board',
  subject: 'Which database should keep the board’s finished items across restarts?',
  why: 'The board forgets every finished item when the app restarts.',
  context: 'Two stores fix it. SQLite is one file and needs nothing installed; Postgres is a server to run and patch.',
  recommendation: { decision: 'SQLite', why: 'The smallest change that survives a restart.' },
  impact: 'Until then, finished items are lost on every restart.',
  urgency: 'Before Friday’s release',
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'SQLite', description: 'One file, no server.' },
      { label: 'Postgres', description: 'A server to run and patch.' },
      { label: 'Keep memory', description: 'Change nothing.' },
    ],
  },
  questions: [
    {
      question: 'Which database should hold the board?',
      options: [
        { label: 'SQLite', description: 'One file, no server.' },
        { label: 'Postgres', description: 'A server to run and patch.' },
        { label: 'Keep memory', description: 'Change nothing.' },
      ],
      recommended: 'SQLite',
    },
  ],
  kind: 'choice',
} as Partial<AgendaItem>);

const YESNO = item('A3', 5, {
  title: 'Staging relay restart',
  subject: 'May I restart the staging relay now so it picks up the new address list?',
  why: 'It is serving an old address list. A restart drops live sessions for about 10 seconds.',
  kind: 'yesno',
} as Partial<AgendaItem>);

const PERMISSION = item('A4', 3, {
  title: 'Old build cache',
  subject: 'May I delete the 4 GB build cache nothing has read for three weeks?',
  why: 'It is 4 GB in the project’s build folder and nothing has read it for three weeks.',
  ask: { kind: 'permission' },
  answers: [
    { direction: 'right', does: 'approve', label: 'Allow' },
    { direction: 'left', does: 'reject', label: 'Deny' },
    {
      direction: 'up',
      does: 'approve',
      label: 'Always allow',
      description: 'Clean build folders without asking again.',
    },
  ],
} as Partial<AgendaItem>);

const REVIEW = item('A5', 22, {
  title: 'Upload retry rule',
  subject: 'Does the new upload retry rule look right to you?',
  why: 'Failed uploads now retry three times, a minute apart, instead of failing at once.',
  body: `The change is small:\n\n- Retries only on network errors, never on a refusal\n- Gives up after three tries and says so\n\n${FENCE}ts\nconst RETRIES = 3;\nconst WAIT_MS = 60_000;\n${FENCE}`,
  links: [{ label: 'The change', target: 'https://example.test/changes/retry-rule' }],
  kind: 'review',
} as Partial<AgendaItem>);

const INFO = item('A6', 40, {
  title: 'Nightly benchmarks',
  subject: 'All 24 nightly benchmarks passed inside their time budget.',
  why: 'All 24 ran inside budget; the slowest finished in 41 seconds of a 60-second limit.',
  context: 'Nothing is needed from you. This is here so you know the release is not waiting on speed.',
  kind: 'info',
} as Partial<AgendaItem>);

const REPLY = item('A7', 12, {
  title: 'Team invite email',
  subject: 'What should the first line of the team invite email say?',
  why: 'I wrote a first line, but you know your team better than I do.',
  context: 'Draft: “You’ve been added to the studio machine. Open the link to pair your phone.”',
  ask: { kind: 'open-question' },
  kind: 'reply',
} as Partial<AgendaItem>);

const IN_DISCUSSION = item('A2', 9, {
  ...(CHOICE as object),
  waitingOn: 'ferret',
  waitingFor: 'discussion',
  askedAt: ago(4),
  history: [{ at: ago(4), kind: 'discuss', note: 'Why not just keep the board in memory?' }],
} as Partial<AgendaItem>);

/**
 * A ferret's lane proposal, as the daemon's `laneChangeCard` words it (docs/board.md § A ferret's lane change
 * waits for the owner): one line, then one bullet per thing to decide, Edit ← recommended and Accept → plain. One
 * rewires Plan/Design's "OK to build" to close the card; one removes thirteen gates the same way, told as ONE bullet;
 * and one whose bullets do not all fit offers no Accept: Later ← and Edit →, accepted in the lane editor.
 */
const LANE_CHANGE = item('A9', 4, {
  source: 'task',
  sourceRef: 'lanes:11111111-1111-4111-8111-111111111111:4',
  raisedBy: 'daemon',
  title: 'Lanes for Relay',
  subject: 'Lanes for Relay: Todo → Plan/Design → Merged → In progress → Released · to test → Closed',
  why: 'ottilie proposes new lanes for Relay. The board keeps its lanes until you accept. Accepting it:\n\n- changes where "OK to build" on Plan/Design sends cards: In progress → the closed lane, which closes them',
  recommendation: {
    decision: 'Edit',
    why: 'It changes what only you decide: read it in the lane editor before you accept.',
  },
  howToResolve:
    'Choose Accept to switch the board to these lanes; any cards they move, move then. Choose Edit to change them in the Board lane editor; the board keeps its lanes until you save.',
  kind: 'choice',
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'Edit', description: 'Change them in the Board lane editor (Board, then this project, then Lanes)' },
      { label: 'Accept', description: 'Switch the board to these lanes' },
    ],
  },
  answers: [
    {
      direction: 'left',
      does: 'choose',
      label: 'Edit',
      description: 'Change them in the Board lane editor (Board, then this project, then Lanes)',
    },
    { direction: 'right', does: 'choose', label: 'Accept', description: 'Switch the board to these lanes' },
  ],
} as Partial<AgendaItem>);

const LANE_CHANGE_GROUPED = item('A11', 4, {
  source: 'task',
  sourceRef: 'lanes:11111111-1111-4111-8111-111111111111:4',
  raisedBy: 'daemon',
  title: 'Lanes for Relay',
  subject: 'Lanes for Relay: Todo → Closed',
  why: 'ottilie proposes new lanes for Relay. The board keeps its lanes until you accept. Accepting it:\n\n- removes 13 lanes that wait for the owner (Owner review stage 00 … Owner review stage 12), and sends their cards into the closed lane, which closes them',
  recommendation: {
    decision: 'Edit',
    why: 'It changes what only you decide: read it in the lane editor before you accept.',
  },
  howToResolve:
    'Choose Accept to switch the board to these lanes; any cards they move, move then. Choose Edit to change them in the Board lane editor; the board keeps its lanes until you save.',
  kind: 'choice',
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'Edit', description: 'Change them in the Board lane editor (Board, then this project, then Lanes)' },
      { label: 'Accept', description: 'Switch the board to these lanes' },
    ],
  },
  answers: [
    {
      direction: 'left',
      does: 'choose',
      label: 'Edit',
      description: 'Change them in the Board lane editor (Board, then this project, then Lanes)',
    },
    { direction: 'right', does: 'choose', label: 'Accept', description: 'Switch the board to these lanes' },
  ],
} as Partial<AgendaItem>);

const LANE_CHANGE_HIDDEN = item('A10', 4, {
  source: 'task',
  sourceRef: 'lanes:11111111-1111-4111-8111-111111111111:4',
  raisedBy: 'daemon',
  title: 'Lanes for Relay',
  subject:
    'Lanes for Relay: Todo → Owner review stage number 00 of the many → Owner review stage number 01 of the many → Owner review stage number 02 of the many → Owner review stage number 03 of the many → Owner review stage number 04 of the many →…',
  why: 'ottilie proposes new lanes for Relay. The board keeps its lanes until you accept. Accepting it:\n\n- makes Owner review stage number 00 of the many automatic: it would stop waiting for the owner\n- lets quick, design-first, research-first and investigate work skip Owner review stage number 00 of the many\n- makes Owner review stage number 01 of the many automatic: it would stop waiting for the owner\n- lets quick, design-first, research-first and investigate work skip Owner review stage number 01 of the many\n- makes Owner review stage number 02 of the many automatic: it would stop waiting for the owner\n- lets quick, design-first, research-first and investigate work skip Owner review stage number 02 of the many\n- makes Owner review stage number 03 of the many automatic: it would stop waiting for the owner\n- lets quick, design-first, research-first and investigate work skip Owner review stage number 03 of the many\n- makes Owner review stage number 04 of the many automatic: it would stop waiting for the owner\n- lets quick, design-first, research-first and investigate work skip Owner review stage number 04 of the many\n- makes Owner review stage number 05 of the many automatic: it would stop waiting for the owner\n- lets quick, design-first, research-first and investigate work skip Owner review stage number 05 of the many\n- makes Owner review stage number 06 of the many automatic: it would stop waiting for the owner\n- lets quick, design-first, research-first and investigate work skip Owner review stage number 06 of the many\n- makes Owner review stage number 07 of the many automatic: it would stop waiting for the owner\n- lets quick, design-first, research-first and investigate work skip Owner review stage number 07 of the many\n- makes Owner review stage number 08 of the many automatic: it would stop waiting for the owner\n- lets quick, design-first, research-first and investigate work skip Owner review stage number 08 of the many\n- and 10 more, all in the Board lane editor',
  howToResolve:
    'It does more than a card can show, so it is accepted in the Board lane editor, where every part of it is listed. Choose Edit to go there; the board keeps its lanes until you accept.',
  kind: 'choice',
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'Later', description: 'Leave it waiting; the board keeps its lanes' },
      { label: 'Edit', description: 'Change them in the Board lane editor (Board, then this project, then Lanes)' },
    ],
  },
  answers: [
    { direction: 'left', does: 'choose', label: 'Later', description: 'Leave it waiting; the board keeps its lanes' },
    {
      direction: 'right',
      does: 'choose',
      label: 'Edit',
      description: 'Change them in the Board lane editor (Board, then this project, then Lanes)',
    },
  ],
} as Partial<AgendaItem>);

const FIXTURES: Readonly<Record<string, AgendaItem>> = {
  'lane-change': LANE_CHANGE,
  'lane-change-grouped': LANE_CHANGE_GROUPED,
  'lane-change-hidden': LANE_CHANGE_HIDDEN,
  task: TASK,
  choice: CHOICE,
  yesno: YESNO,
  permission: PERMISSION,
  review: REVIEW,
  info: INFO,
  reply: REPLY,
  'in-discussion': IN_DISCUSSION,
};

const card = (it: AgendaItem): InboxCard => {
  const view = sessionView('fr', {
    config: { teammate: 'ottilie' as never, label: 'Relay hardening', cwd: '/home/kirin/Workspace/relay' },
    state: { lastActivityAt: ago(1) },
  });
  return { key: inboxCardKey(STUDIO, view.config.id, it.id), daemonId: STUDIO, machineName: 'studio', view, item: it };
};

function Deck({ fixture }: { readonly fixture: AgendaItem }): ReactElement {
  const [cards] = useState(() => [card(fixture)]);
  return (
    <div
      className="mx-auto h-dvh w-full max-w-[460px] overflow-hidden bg-bg p-3"
      style={{ paddingTop: swiping ? 140 : undefined }}
      data-fixture=""
    >
      <AgendaSwipeDeck
        cards={cards}
        onAct={() => undefined}
        reducedMotion
        renderCard={(entry, act) => (
          <AgendaCard
            item={entry.item}
            now={NOW}
            onAct={act}
            origin={{
              ferret: 'ottilie',
              task: 'Relay hardening',
              machine: entry.machineName,
              href: '#',
              onNavigate: () => undefined,
            }}
            swipeHints
          />
        )}
      />
    </div>
  );
}

function RepliesNotice({ held }: { readonly held: boolean }): ReactElement {
  return (
    <div className="mx-auto flex w-full max-w-[460px] flex-col gap-2 bg-bg p-3" data-fixture="">
      <AgendaRepliesNotice
        ferret="ottilie"
        heldForTurn={held}
        onSendNow={() => undefined}
        secondsLeft={held ? null : 105}
        sending={false}
      />
      <div className="rounded-lg border border-border bg-surface p-3 text-sm text-muted">Message ottilie…</div>
    </div>
  );
}

const name = new URLSearchParams(location.search).get('view') ?? 'task';
const swiping = name === 'task-swipe';
const fixture = FIXTURES[name === 'task-swipe' ? 'task' : name === 'discuss-swipe' ? 'choice' : name];
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
if (name === 'replies-countdown' || name === 'replies-held') {
  createRoot(root).render(<RepliesNotice held={name === 'replies-held'} />);
} else {
  if (fixture === undefined) throw new Error(`no fixture named ${name}`);
  createRoot(root).render(<Deck fixture={fixture} />);
}
