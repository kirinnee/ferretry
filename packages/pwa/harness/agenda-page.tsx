/**
 * The agenda in a ferret's chat, one view per URL (`agenda-screenshot.ts` bundles this and drives it):
 *
 *   ?view=none            agenda mode off — the board is full, the chat shows no agenda
 *   ?view=board           the agenda: 1 blocking, 4 need the owner, 2 with the ferret
 *   ?view=updated         the same, with A5 edited twice by the ferret (changed lines, "Updated" list)
 *   ?view=status-both     the line AND "Sending…"
 *   ?view=status-sending  nothing on the agenda, an answer still on its way: "Sending…" alone
 *   ?attention=A5         a notification tap: A5's full card opens on arrival
 *
 * Every component is the REAL one (`useAttentionAgenda` through `AgendaChatHarness`); only the data is
 * invented and the answers go nowhere.
 */

import type { AttentionId, AttentionItem, AttentionSnapshot, ResolvedAttentionItem } from '@ferretry/protocol';
import { agendaReMessage } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import type { TranscriptEntry } from '../src/lib/session-screens.ts';
import { AgendaChatHarness } from './agenda-chat.tsx';

const NOW = Date.parse('2026-10-29T09:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const ahead = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

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

const FENCE = '```';
const DIAGRAM = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 90">',
  '<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">',
  '<path d="M0 0L10 5L0 10z" fill="#5b7aa6"/></marker></defs>',
  '<rect width="360" height="90" rx="10" fill="#eef2f8"/>',
  '<g fill="#ffffff" stroke="#5b7aa6" stroke-width="1.5">',
  '<rect x="16" y="26" width="92" height="38" rx="8"/><rect x="134" y="26" width="92" height="38" rx="8"/>',
  '<rect x="252" y="26" width="92" height="38" rx="8"/></g>',
  '<g fill="#1d2b3f" font-family="sans-serif" font-size="13" text-anchor="middle">',
  '<text x="62" y="50">Raised</text><text x="180" y="50">Ledger</text><text x="298" y="50">SQLite file</text></g>',
  '<g stroke="#5b7aa6" stroke-width="1.5" marker-end="url(#a)"><path d="M110 45H132"/><path d="M228 45H250"/></g>',
  '</svg>',
].join('');

// THE DECISION: premise, context, decided so far, still open, terms, a small diagram, a recommended option.
const A5 = item('A5', 12, {
  title: 'Which storage engine for the ledger?',
  subject: 'Which storage engine should keep the ledger: SQLite or Postgres?',
  why: 'Which storage engine should keep the ledger: SQLite or Postgres?',
  premise: '- The board keeps its ledger in memory\n- A daemon restart forgets every resolved item',
  context:
    '- SQLite is one file and needs no server\n- Postgres needs a server to run and patch\n- Either can hold the ledger as it is today',
  decided: '- The migration runs once, on the next start (you said yes on Monday)',
  stillOpen: '- Which engine\n- Whether to keep a nightly export',
  terms: [
    { term: 'Ledger', meaning: 'The list of every item raised, open and resolved.' },
    { term: 'WAL', meaning: 'A log written before the data, so a crash can be replayed.' },
    { term: 'Migration', meaning: 'Moving the existing items into the new store once.' },
  ],
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'SQLite', description: 'One file, no server to run' },
      { label: 'Postgres', description: 'A server to run and patch' },
    ],
  },
  answers: [
    { direction: 'right', does: 'choose', label: 'SQLite' },
    { direction: 'left', does: 'choose', label: 'Postgres' },
  ],
  recommendation: { decision: 'SQLite', why: 'Needs nothing installed on the machine' },
  body:
    '## Where a resolved item goes\n\nEvery item is written to the ledger when it is raised and again when it is resolved:\n\n' +
    `${FENCE}fy-render\ntype: svg\nalt: Raised items go to the ledger, which is stored in one SQLite file\n---\n${DIAGRAM}\n${FENCE}\n\n` +
    'A restart then reads the file back, so nothing resolved is forgotten.',
  blockingNow: true,
} as Partial<AttentionItem>);

// …after the ferret edited it twice: the third context bullet and the decided line are new.
const A5_UPDATED = {
  ...A5,
  revisions: [
    {
      at: ago(55),
      by: 'agent',
      changed: ['recommendation'],
      previous: { recommendation: { decision: 'Postgres', why: 'Handles more writers' } },
    },
    {
      at: ago(6),
      by: 'agent',
      changed: ['context', 'decided'],
      previous: {
        context: '- SQLite is one file and needs no server\n- Postgres needs a server to run and patch',
      },
    },
  ],
} as AttentionItem;

const A3 = item('A3', 2, {
  title: 'Rebase onto main now?',
  subject: 'Rebase onto main now, or wait for #768 to merge?',
  why: 'main moved 14 commits since this branch was cut and two of them touch the attention store.',
  willBlock: 'the release cut',
  ask: { kind: 'multiple-choice', options: [{ label: 'Rebase now' }, { label: 'Wait' }] },
  answers: [
    { direction: 'right', does: 'choose', label: 'Rebase now' },
    { direction: 'left', does: 'choose', label: 'Wait' },
  ],
} as Partial<AttentionItem>);
const A2 = item('A2', 9, {
  title: 'Restart the staging relay?',
  subject: 'Can I restart the staging relay? It drops live sessions for about ten seconds.',
  why: 'The relay is serving a stale advertisement.',
  neededBy: ahead(480),
  ask: { kind: 'permission' },
} as Partial<AttentionItem>);
const A6 = item('A6', 25, {
  title: 'Which login should the runtime use?',
  subject: 'Which login should the new runtime use, the personal one or the team one?',
  why: 'The two bill differently and the job will run for hours.',
  ask: { kind: 'open-question' },
});
const A8 = item('A8', 14, {
  title: 'Rotate the relay key',
  subject: 'Rotate the relay key on the studio machine',
  why: 'The old key was pasted into a chat; rotate it before the release cut.',
  ask: { kind: 'task' },
  steps: ['Store the new key: `fy secret set RELAY_KEY`', 'Restart the relay: `fy daemon restart`'],
} as Partial<AttentionItem>);
const WITH_FERRET = (id: string, minutes: number, title: string, subject: string): AttentionItem =>
  item(id, minutes + 20, {
    title,
    subject,
    why: subject,
    ask: { kind: 'open-question' },
    waitingOn: 'ferret',
    waitingFor: 'discussion',
    askedAt: ago(minutes),
  } as Partial<AttentionItem>);
const A9 = WITH_FERRET(
  'A9',
  11,
  'Pick the staging region',
  'Pick the staging region for the relay: eu-west or us-east?',
);
const A10 = WITH_FERRET('A10', 4, 'Which cache to drop?', 'Which of the two stale build caches is safe to drop?');

const snapshot = (
  items: readonly AttentionItem[],
  patch: Partial<AttentionSnapshot> = {},
  resolved: AttentionSnapshot['resolved'] = [],
): AttentionSnapshot => ({
  v: 1,
  sessionId: 'fr',
  items: [...items],
  resolved,
  count: items.length,
  parseErrors: 0,
  updatedAt: ago(1),
  ...patch,
});

const AGENDA = [A5, A3, A2, A6, A8, A9, A10] as const;

const SENT = {
  ...item('A1', 90, { title: 'Use the shared fixture?', subject: 'Use the shared fixture for the inbox tests?' }),
  resolvedAt: ago(1),
  resolutionNote: null,
  response: { kind: 'multiple-choice', choice: 'Yes' },
  ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
  disposition: 'done',
  resolvedBy: 'human',
  resolvedBySession: null,
  resolvedByName: null,
} as unknown as ResolvedAttentionItem;

// THE PERMISSION ITEM, with its own terms and a revision, for the item view.
const A2_FULL = {
  ...A2,
  premise: '- The staging relay serves a stale advertisement\n- A restart drops live sessions for about ten seconds',
  terms: [
    { term: 'Relay', meaning: 'The carrier a phone reaches the daemon through.' },
    { term: 'Advertisement', meaning: 'The address list the relay publishes.' },
  ],
  revisions: [
    {
      at: ago(30),
      by: 'agent',
      changed: ['subject'],
      previous: { subject: 'Can I restart the staging relay?' },
    },
  ],
} as AttentionItem;

// A PERMISSION ITEM THAT CONFIRMS A CONFIG CHANGE: the daemon also writes the change into premise for old apps.
const CHANGES = [
  'the Jev price the cap counts with goes down from 2 to 0.042',
  'the Warden may now spend on AI investigations',
];
const A2_CONFIG = {
  ...A2_FULL,
  title: "Loosen the Warden's spending limits?",
  subject: "Can I loosen the Warden's spending limits in warden.yaml?",
  premise: CHANGES.map(change => `- ${change}`).join('\n'),
  confirms: { path: 'warden.yaml', etag: 'a'.repeat(64), changes: CHANGES },
} as unknown as AttentionItem;

// A LONG ITEM: many bullets, a table of terms, a diagram and a long body — the one body scrolls.
const LONG_LINES = (stem: string, count: number): string =>
  Array.from(
    { length: count },
    (_, at) => `- ${stem} ${at + 1}: the board and the ledger must agree after a restart`,
  ).join('\n');
const A5_LONG = {
  ...A5_UPDATED,
  premise: LONG_LINES('Premise', 8),
  context: LONG_LINES('Context', 10),
  decided: LONG_LINES('Decided', 5),
  stillOpen: LONG_LINES('Still open', 5),
  terms: Array.from({ length: 9 }, (_, at) => ({
    term: `Term ${at + 1}`,
    meaning: 'A meaning that runs to a full sentence so that the second column wraps on a phone.',
  })),
} as AttentionItem;

const owner = (id: string, at: number, text: string) => ({ id, kind: 'user', text, at: NOW - at * 60_000 });
const ferretSays = (id: string, at: number, text: string) => ({ id, kind: 'assistant', text, at: NOW - at * 60_000 });
const HISTORY_ENTRIES = [
  ferretSays('h1', 50, 'I raised !A5 — SQLite or Postgres for the ledger?'),
  owner('h2', 40, agendaReMessage([{ id: 'A5', quote: A5.subject }], 'Does Postgres need a separate machine?')),
  ferretSays('h3', 38, 'Re !A5: yes, Postgres is its own server; SQLite is just a file beside the daemon.'),
  owner('h4', 5, '!A5 leaning SQLite, but I want the nightly export'),
] as unknown as TranscriptEntry[];

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'board';
const target = (params.get('attention') ?? params.get('agenda') ?? null) as AttentionId | null;
const withHistory = params.get('history') === '1';
const long = params.get('long') === '1';
const fakeKeyboard = params.get('kb') === '1';
const configChange = params.get('config') === '1';

const items = AGENDA.map(entry =>
  entry.id === 'A5'
    ? long
      ? A5_LONG
      : withHistory
        ? A5_UPDATED
        : entry
    : entry.id === 'A2'
      ? configChange
        ? A2_CONFIG
        : A2_FULL
      : entry,
);

const board: AttentionSnapshot =
  view === 'updated'
    ? snapshot([A5_UPDATED, ...AGENDA.slice(1)])
    : view === 'status-both'
      ? snapshot(AGENDA, { delivery: { sending: ['A1' as AttentionId] } }, [SENT])
      : view === 'status-sending'
        ? snapshot([], { delivery: { sending: ['A1' as AttentionId] } }, [SENT])
        : view === 'one'
          ? snapshot([A3])
          : snapshot(items);

const live =
  params.get('live') === '1' ? (
    <p className="m-0 flex items-center gap-xs text-meta text-muted" data-fixture-live="">
      Ottilie is thinking…
    </p>
  ) : undefined;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="h-dvh" data-fixture="" style={fakeKeyboard ? { height: 'calc(100dvh - 300px)' } : undefined}>
    <AgendaChatHarness
      agendaMode={view !== 'none'}
      board={board}
      entries={withHistory || long ? HISTORY_ENTRIES : undefined}
      live={live}
      now={NOW}
      target={target}
    />
  </div>,
);
