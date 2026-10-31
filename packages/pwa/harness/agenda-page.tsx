/**
 * The agenda in a ferret's chat, one view per URL (`agenda-screenshot.ts` bundles this and drives it):
 *
 *   ?view=none            agenda mode off — the board is full, the chat shows no agenda
 *   ?view=board           the agenda: 1 blocking, 4 need the owner, 2 with the ferret
 *   ?view=updated         the same, with A5 edited twice by the ferret (changed lines, "Updated" list)
 *   ?view=status-both     the line AND "Sending…"
 *   ?view=status-sending  nothing on the agenda, an answer still on its way: "Sending…" alone
 *   ?attention=A5         a notification tap: A5's full card opens on arrival
 *   &parked=1             adds a snoozed (A70) and a replied (A71) item: neither counts, neither is listed
 *   &v5=1                 adds the v5 card items: A80 (a long decision with revisions and a conversation with
 *                         tool calls in it) and one item of each type — A81 approval, A82 to-do, A83 review,
 *                         A84 note, A85 reply
 *
 * Every component is the REAL one (`useAgenda` through `AgendaChatHarness`); only the data is
 * invented and the answers go nowhere.
 */

import type { AgendaId, AgendaItem, AgendaSnapshot, ResolvedAgendaItem } from '@ferretry/protocol';
import { agendaReMessage } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import type { TranscriptEntry } from '../src/lib/session-screens.ts';
import { AgendaChatHarness } from './agenda-chat.tsx';

const NOW = Date.parse('2026-10-29T09:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const ahead = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

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
    { direction: 'up', does: 'choose', label: 'SQLite' },
    { direction: 'left', does: 'choose', label: 'Postgres' },
  ],
  recommendation: { decision: 'SQLite', why: 'Needs nothing installed on the machine' },
  body:
    '## Where a resolved item goes\n\nEvery item is written to the ledger when it is raised and again when it is resolved:\n\n' +
    `${FENCE}fy-render\ntype: svg\nalt: Raised items go to the ledger, which is stored in one SQLite file\n---\n${DIAGRAM}\n${FENCE}\n\n` +
    'A restart then reads the file back, so nothing resolved is forgotten.',
  blockingNow: true,
} as Partial<AgendaItem>);

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
} as AgendaItem;

const A3 = item('A3', 2, {
  title: 'Rebase onto main now?',
  subject: 'Rebase onto main now, or wait for #768 to merge?',
  why: 'main moved 14 commits since this branch was cut and two of them touch the agenda store.',
  willBlock: 'the release cut',
  ask: { kind: 'multiple-choice', options: [{ label: 'Rebase now' }, { label: 'Wait' }] },
  answers: [
    { direction: 'right', does: 'choose', label: 'Rebase now' },
    { direction: 'left', does: 'choose', label: 'Wait' },
  ],
} as Partial<AgendaItem>);
const A2 = item('A2', 9, {
  title: 'Restart the staging relay?',
  subject: 'Can I restart the staging relay? It drops live sessions for about ten seconds.',
  why: 'The relay is serving a stale advertisement.',
  neededBy: ahead(480),
  ask: { kind: 'permission' },
} as Partial<AgendaItem>);
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
} as Partial<AgendaItem>);
const WITH_FERRET = (id: string, minutes: number, title: string, subject: string): AgendaItem =>
  item(id, minutes + 20, {
    title,
    subject,
    why: subject,
    ask: { kind: 'open-question' },
    waitingOn: 'ferret',
    waitingFor: 'discussion',
    askedAt: ago(minutes),
  } as Partial<AgendaItem>);
const A9 = WITH_FERRET(
  'A9',
  11,
  'Pick the staging region',
  'Pick the staging region for the relay: eu-west or us-east?',
);
const A10 = WITH_FERRET('A10', 4, 'Which cache to drop?', 'Which of the two stale build caches is safe to drop?');

const snapshot = (
  items: readonly AgendaItem[],
  patch: Partial<AgendaSnapshot> = {},
  resolved: AgendaSnapshot['resolved'] = [],
): AgendaSnapshot => ({
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
} as unknown as ResolvedAgendaItem;

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
} as AgendaItem;

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
} as unknown as AgendaItem;

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
} as AgendaItem;

// A MULTI-QUESTION ITEM, as a ferret really wrote it: three questions with no options, its picks in the context.
const JAEDA_QUESTIONS = [
  {
    question:
      "A. Workspace's .dockerignore has '!README.md' meant to put README.md into Docker images, but the next line '*.md' cancels it, so README is never included. Delete the useless line, or make README go into images?",
  },
  {
    question:
      'B. The merge tool rebuilds nix/yaml lists from scratch, so comments written inside those lists disappear in generated projects. Accept that, moving important notes above the lists?',
  },
  {
    question:
      "C. Finalize: each template ships only the files it changed; the final check compares meaning, not exact spacing; and the merge tool's 6 formatting/sorting bugs get reported and fixed in your resolver repos? (yes to all, or which not)",
  },
];
const A47 = item('A47', 6, {
  title: '3 calls left for the nix fix',
  subject: "Three calls left. Reply 'all your picks' or change any.",
  why: 'The review is otherwise done; these three are the only open threads.',
  ask: { kind: 'open-question' },
  questions: JAEDA_QUESTIONS,
  context: 'My picks: A delete the line · B accept · C yes to all',
} as Partial<AgendaItem>);

// …and the same item written the structured way: options on each question and a recommended pick.
const A48 = item('A48', 5, {
  title: 'Three leftovers, with choices',
  subject: 'Three leftovers from the review of the relay change — pick one answer for each',
  why: 'The review is otherwise done; these three are the only open threads.',
  ask: { kind: 'open-question' },
  questions: [
    {
      question: 'The duplicate `retry` line in relay.ts?',
      options: [{ label: 'Delete the line' }, { label: 'Keep it' }],
      recommended: 'Delete the line',
      why: 'Nothing reads it; the other retry covers the same case',
    },
    {
      question: "The reviewer's rename of `carrier` to `route`?",
      options: [{ label: 'Accept' }, { label: 'Decline' }],
      recommended: 'Accept',
    },
    {
      question: 'The same cleanup in the other two relay files?',
      options: [{ label: 'Yes to all' }, { label: 'Only this file' }],
      recommended: 'Yes to all',
      why: 'Same pattern, same risk',
    },
  ],
} as Partial<AgendaItem>);

// V4: a Jaeda-style item — one question, five lettered options each with a Markdown reason, one recommended.
const A60 = item('A60', 7, {
  title: 'How should the merge tool treat comments in lists?',
  subject: 'How should the merge tool treat `#` comments inside the **nix/yaml lists** it rebuilds?',
  why: 'Generated projects lose every comment written *inside* a list, and the review is otherwise done.',
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'Accept the loss' },
      { label: 'Keep comments above lists' },
      { label: 'Parse and keep comments' },
      { label: 'Warn when one is dropped' },
      { label: 'Do nothing for now' },
    ],
  },
  optionDetails: [
    {
      label: 'Accept the loss',
      detail: 'Move the notes **above** each list. Nothing to build, but the notes drift from the lines they explain.',
    },
    {
      label: 'Keep comments above lists',
      detail:
        'The tool copies a comment block that sits *directly above* a list. Cheap, and `fy merge` stays stateless.',
    },
    {
      label: 'Parse and keep comments',
      detail:
        'Switch to a round-trip YAML parser such as `yaml@2`. Keeps every comment, but adds a dependency and about a week of work.',
    },
    {
      label: 'Warn when one is dropped',
      detail:
        'Print `warning: dropped 2 comments` and keep going. See [the merge notes](https://example.com/merge-notes).',
    },
    { label: 'Do nothing for now', detail: 'Ship as is and revisit after the release cut.' },
  ],
  recommendation: { decision: 'Keep comments above lists', why: 'Fixes the common case at the lowest cost' },
} as Partial<AgendaItem>);

// V4: a single choice whose options explain themselves in Markdown (backticks, bold, a link).
const A61 = item('A61', 3, {
  title: 'Which storage engine for the ledger?',
  subject: 'Which engine should keep the **ledger**: `sqlite` or `postgres`?',
  why: 'A restart forgets every resolved item today; see [the ledger notes](https://example.com/ledger).',
  premise: '- The board keeps its ledger in **memory**\n- A restart forgets every resolved item',
  context: 'Both can hold the ledger as it is. `SQLITE_BUSY` only appears with *several writers*.',
  ask: {
    kind: 'multiple-choice',
    options: [{ label: 'Use SQLite' }, { label: 'Use Postgres' }, { label: 'Keep it in memory' }],
  },
  optionDetails: [
    {
      label: 'Use SQLite',
      detail:
        'One file beside the daemon, **no server**. Set `journal_mode=WAL` so a crash replays cleanly. [Why WAL](https://example.com/wal)',
    },
    {
      label: 'Use Postgres',
      detail: 'A server to run and patch, but it handles **many writers** and `LISTEN/NOTIFY`.',
    },
    { label: 'Keep it in memory', detail: 'Nothing changes; a restart still forgets resolved items.' },
  ],
  recommendation: { decision: 'Use SQLite', why: 'Needs nothing installed on the machine' },
} as Partial<AgendaItem>);

// V4b: the swipe row by direction — two options, three options, and five (three buttons, D and E under "…").
const A62 = item('A62', 9, {
  title: 'Ship the relay fix today?',
  subject: 'Should the relay fix ship **today**, or wait for the Monday cut?',
  ask: { kind: 'multiple-choice', options: [{ label: 'Ship today' }, { label: 'Wait for Monday' }] },
  recommendation: { decision: 'Ship today', why: 'The fix is small and tested' },
} as Partial<AgendaItem>);

const A63 = item('A63', 8, {
  title: 'Which fix for the login race?',
  subject: 'Which fix should land for the login race?',
  ask: {
    kind: 'multiple-choice',
    options: [{ label: 'Lock the session row' }, { label: 'Retry with backoff' }, { label: 'Do nothing at all' }],
  },
  recommendation: { decision: 'Lock the session row', why: 'It fixes the cause, not the symptom' },
} as Partial<AgendaItem>);

const A64 = item('A64', 6, {
  title: 'Which region first?',
  subject: 'Which region should the relay open in first?',
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'Frankfurt' },
      { label: 'Virginia' },
      { label: 'Singapore' },
      { label: 'Sydney' },
      { label: 'São Paulo' },
    ],
  },
  recommendation: { decision: 'Virginia', why: 'Most of the owners are on the east coast' },
} as Partial<AgendaItem>);

// Seven options: three on the swipe row, four on the rows under it (tap only).
const A65 = item('A65', 6, {
  title: 'Which day for the migration?',
  subject: 'Which weekday should the ledger migration run on?',
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'Monday' },
      { label: 'Tuesday' },
      { label: 'Wednesday' },
      { label: 'Thursday' },
      { label: 'Friday' },
      { label: 'Saturday' },
      { label: 'Sunday' },
    ],
  },
  recommendation: { decision: 'Saturday', why: 'Nobody is on the board then' },
} as Partial<AgendaItem>);

// PARKED: snoozed until the afternoon, and replied-to (waiting on the ferret). Neither is on the owner's list.
const A70 = item('A70', 40, {
  title: 'Waiting for the deploy approval',
  subject: 'Waiting for the deploy approval before the relay change ships',
  ask: { kind: 'permission' },
  parked: { reason: 'snoozed', at: ago(30), until: ahead(300) },
} as Partial<AgendaItem>);
const A71 = item('A71', 50, {
  title: 'Which log level for the relay?',
  subject: 'Which log level should the relay run at in production?',
  ask: { kind: 'open-question' },
  parked: { reason: 'replied', at: ago(12) },
} as Partial<AgendaItem>);

const owner = (id: string, at: number, text: string) => ({ id, kind: 'user', text, at: NOW - at * 60_000 });
const ferretSays = (id: string, at: number, text: string) => ({ id, kind: 'assistant', text, at: NOW - at * 60_000 });
const HISTORY_ENTRIES = [
  ferretSays('h1', 50, 'I raised !A5 — SQLite or Postgres for the ledger?'),
  owner('h2', 40, agendaReMessage([{ id: 'A5', quote: A5.subject }], 'Does Postgres need a separate machine?')),
  ferretSays('h3', 38, 'Re !A5: yes, Postgres is its own server; SQLite is just a file beside the daemon.'),
  owner('h4', 5, '!A5 leaning SQLite, but I want the nightly export'),
] as unknown as TranscriptEntry[];

// V5: a LONG, real-looking decision — premise, context, a 4-column options table, two revisions — and one item of
// each other type. The conversation about A80 has tool calls between its messages; none of them may reach History.
const A80_TABLE = [
  '## How the four options compare',
  '',
  '| Option | Setup | Writers | Backup |',
  '| --- | --- | --- | --- |',
  '| SQLite file | None — one file beside the daemon | One at a time | Copy the file |',
  '| Postgres | A server to run, patch and secure | Many at once | `pg_dump` on a timer |',
  '| Keep it in memory | None | Not applicable | Nothing — a restart forgets |',
  '| Append-only log | None — a plain file the daemon owns | One at a time | Copy the file |',
  '',
  'Every option keeps the ledger **readable by hand**, so a bad migration can always be undone from the backup.',
  '',
  '## What a restart does today',
  '',
  'The ledger lives in the daemon’s memory. A restart reads the resolved items back from nothing, so the board shows an empty history until the next item is raised.',
].join('\n');
const A80 = item('A80', 120, {
  title: 'Where should the ledger live?',
  subject: 'Where should the board’s ledger live: a SQLite file, Postgres, a log, or stay in memory?',
  why: 'A restart forgets every resolved item, and the release cut is on Friday.',
  premise: [
    '- The board keeps its ledger in **memory** only',
    '- A daemon restart forgets every resolved item',
    '- Two owners have already asked where an answered item went',
    '- The ledger is read on every board load, so a slow store is felt at once',
    '- Nothing outside the daemon reads it today',
  ].join('\n'),
  context: [
    '- The release cut is on **Friday**; the migration must run before it',
    '- SQLite is one file and needs no server; Postgres needs one run and patched',
    '- Kai measured 4 ms per board read against a local SQLite file',
    '- The studio machine has no spare capacity for a database server',
    '- You said yes to “a migration, once” on Monday; the engine is the open part',
    '- An append-only log is the cheapest, but a search needs a full read',
  ].join('\n'),
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
      { label: 'SQLite file' },
      { label: 'Postgres' },
      { label: 'Append-only log' },
      { label: 'Keep it in memory' },
    ],
  },
  optionDetails: [
    { label: 'SQLite file', detail: 'One file, **no server**. Set `journal_mode=WAL` so a crash replays cleanly.' },
    { label: 'Postgres', detail: 'A server to run and patch, but it handles **many writers**.' },
    { label: 'Append-only log', detail: 'A plain file the daemon appends to. Cheap, but a search reads it all.' },
    { label: 'Keep it in memory', detail: 'Nothing changes; a restart still forgets resolved items.' },
  ],
  recommendation: { decision: 'SQLite file', why: 'Needs nothing installed on the machine' },
  body: A80_TABLE,
  revisions: [
    {
      at: ago(90),
      by: 'agent',
      changed: ['subject', 'premise'],
      previous: {
        subject: 'Should the ledger be stored on disk?',
        premise: '- The board keeps its ledger in memory only\n- A daemon restart forgets every resolved item',
      },
    },
    {
      at: ago(25),
      by: 'agent',
      changed: ['ask', 'context'],
      previous: {
        ask: { kind: 'multiple-choice', options: [{ label: 'SQLite file' }, { label: 'Postgres' }] },
        context: '- The release cut is on Friday\n- SQLite is one file and needs no server',
      },
    },
  ],
  blockingNow: true,
} as Partial<AgendaItem>);

const A81 = item('A81', 18, {
  title: 'Restart the preview relay?',
  subject: 'Can I restart the preview relay? It drops live sessions for about ten seconds.',
  why: 'The relay is serving a stale advertisement.',
  kind: 'permission',
  ask: { kind: 'permission' },
  premise: '- The preview relay serves an advertisement written before the key rotation',
  context: '- Phones that pair now get an address that no longer answers\n- A restart takes about ten seconds',
  impact: '- Drops every live session on **preview** for about ten seconds\n- Touches nothing on production',
} as Partial<AgendaItem>);
const A82 = item('A82', 14, {
  title: 'Rotate the relay key',
  subject: 'Rotate the relay key on the studio machine',
  why: 'The old key was pasted into a chat; rotate it before the release cut.',
  kind: 'task',
  ask: { kind: 'task' },
  premise: '- The old relay key was pasted into a chat on Tuesday',
  context: '- The release cut is on Friday; a leaked key must not ship with it',
  steps: [
    'Store the new key: `fy secret set RELAY_KEY`',
    'Restart the relay: `fy daemon restart`',
    'Check a phone still pairs',
  ],
} as Partial<AgendaItem>);
const A83 = item('A83', 22, {
  title: 'Is the retry fix enough?',
  subject: 'Review the retry fix for the login race: is it enough to ship?',
  why: 'The fix passes its tests, but it only narrows the window.',
  kind: 'review',
  ask: { kind: 'answer-review' },
  premise: '- The login race lets two sessions claim one row',
  context: '- The fix retries with backoff; the tests pass 200 runs in a row',
  body:
    '## Why I think it is enough\n\nThe race needs two logins inside the same **4 ms** window. Retrying with backoff pushes the second one past it.\n\n' +
    '## Where it is thin\n\nA slow disk widens the window. Locking the row would close it, at the cost of a migration.',
} as Partial<AgendaItem>);
const A84 = item('A84', 11, {
  title: 'The ledger migration finished',
  subject: 'The ledger migration finished: 1,204 items moved, none lost',
  why: 'Nothing to decide; this is for your records.',
  kind: 'info',
  premise: '- The migration ran on the last restart and moved every resolved item',
  context: '- The old in-memory ledger was dropped after the check passed',
} as Partial<AgendaItem>);
const A85 = item('A85', 16, {
  title: 'Which login for the new runtime?',
  subject: 'Which login should the new runtime start with, personal or team?',
  why: 'The two bill differently and the job will run for hours.',
  kind: 'reply',
  ask: { kind: 'open-question' },
  premise: '- The new runtime needs a login before it can start',
  context: '- The personal login bills to you; the team login bills to the studio',
} as Partial<AgendaItem>);
const V5_ITEMS = [A80, A81, A82, A83, A84, A85] as const;

const tool = (id: string, at: number, text: string) => ({ id, kind: 'tool', text, at: NOW - at * 60_000 });
export const V5_TOOL_TEXT = 'Bash(rg ledger src/)';
const V5_ENTRIES = [
  ferretSays('v1', 118, 'I raised !A80 — the ledger forgets every resolved item on a restart. Where should it live?'),
  tool('v2', 114, `${V5_TOOL_TEXT} → 14 matches in packages/daemon`),
  owner('v3', 105, '!A80 does Postgres need its own machine?'),
  tool('v4', 100, 'Read(packages/daemon/src/ledger.ts) → 212 lines'),
  ferretSays(
    'v5',
    96,
    'Re !A80: yes, Postgres is its own server. SQLite is a file beside the daemon — no new machine.',
  ),
  owner('v6', 60, '!A80 what happens to the board while the migration runs?'),
  tool('v7', 57, 'Bash(fy daemon status --json) → ok'),
  ferretSays('v8', 54, 'Re !A80: the board reads from memory until the migration finishes, then switches over once.'),
  owner('v9', 30, agendaReMessage([{ id: 'A80', quote: A80.subject }], 'Add append-only log as an option')),
  ferretSays(
    'v10',
    26,
    'Done — I added the log as the third option on !A80, and put the four side by side in a table.',
  ),
  owner('v11', 4, '!A80 leaning SQLite, keep the nightly export'),
] as unknown as TranscriptEntry[];

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'board';
const target = (params.get('attention') ?? params.get('agenda') ?? null) as AgendaId | null;
const withHistory = params.get('history') === '1';
const long = params.get('long') === '1';
const fakeKeyboard = params.get('kb') === '1';
const configChange = params.get('config') === '1';
const jaeda = params.get('jaeda') === '1';
const v4 = params.get('v4') === '1';
const parked = params.get('parked') === '1';
const v5 = params.get('v5') === '1';

const items = [
  ...AGENDA,
  ...(jaeda ? [A47, A48] : []),
  ...(v4 ? [A60, A61, A62, A63, A64, A65] : []),
  ...(parked ? [A70, A71] : []),
  ...(v5 ? V5_ITEMS : []),
].map(entry =>
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

const board: AgendaSnapshot =
  view === 'updated'
    ? snapshot([A5_UPDATED, ...AGENDA.slice(1)])
    : view === 'status-both'
      ? snapshot(AGENDA, { delivery: { sending: ['A1' as AgendaId] } }, [SENT])
      : view === 'status-sending'
        ? snapshot([], { delivery: { sending: ['A1' as AgendaId] } }, [SENT])
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
      entries={v5 ? [...HISTORY_ENTRIES, ...V5_ENTRIES] : withHistory || long ? HISTORY_ENTRIES : undefined}
      live={live}
      now={NOW}
      target={target}
    />
  </div>,
);
