/**
 * THE NINE-PART ITEM VIEW'S FIXTURES (`agenda-page.tsx?parts=1`, driven by `agenda-parts-screenshot.ts`): one item per
 * stage — an explainer, a question, a plan to approve, a tracker and a test carrying a card ask — and a conversation
 * with several replies about the question. Every part is exercised: a folded detailed context, a terms and references
 * table, a long report in "where we are now", the conversation, card asks with their buttons, a body and an activity
 * log with each stage the item went through.
 */

import type { AgendaItem } from '@ferretry/protocol';
import type { TranscriptEntry } from '../src/lib/session-screens.ts';

const NOW = Date.parse('2026-10-29T09:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

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

const BRIEF = {
  premise: '- The Inbox badge counts what needs you\n- Today it counts resting items too',
  context: '- Owners asked why the count never reaches zero\n- The fix is one selector, shared by every count',
  detail: [
    'The **badge** is the small number on the Inbox tab. It is meant to say how many items wait on you right now.',
    '',
    'An agenda item is **Needs you** when it waits on you, **Resting** when it waits on the ferret, and **Done** when it is closed. Today the badge adds the Resting items, so it shows work that is not yours to do.',
    '',
    'One function, `needsYouQueue`, now decides which items need you. The badge, the Inbox and push all read it.',
  ].join('\n'),
  terms: [
    { term: 'badge', meaning: 'The number on the Inbox tab: how many items wait on you.' },
    { term: 'Resting', meaning: 'An item waiting on its ferret, not on you.' },
    { term: 'needsYouQueue', meaning: 'The one function that lists what needs you, blockers first.' },
  ],
  links: [
    { label: 'The fix: every count reads one queue', target: 'https://github.com/kirinnee/ferretry/pull/1413' },
    { label: 'The card this work is tracked on', target: '&F559' },
    { label: 'Where the item view is written down', target: 'docs/agenda.md' },
  ],
} satisfies Partial<AgendaItem>;

const REPORT = [
  '**The report you asked for: why the badge was wrong.**',
  '',
  ...Array.from({ length: 14 }, (_, at) =>
    [
      `${String(at + 1)}. **Finding ${String(at + 1)}.** The count on ${['phone', 'desktop', 'tablet'][at % 3]} read`,
      `the open list rather than the queue, so a resting item added one. Fixed by reading \`needsYouQueue\`; a test now`,
      'pins that the badge, the Inbox and push give the same number for the same items.',
    ].join(' '),
  ),
  '',
  '**The last line of the report:** every count now agrees.',
].join('\n');

/** 1. An EXPLAINER: what was found, to read. */
const EXPLAINER = item('A120', 40, {
  title: 'How the Needs-you queue works now',
  subject: 'Read how the queue decides what needs you.',
  kind: 'info',
  ask: undefined,
  stage: 'explainer',
  stages: [{ stage: 'explainer', at: ago(40) }],
  ...BRIEF,
  whereWeAre: 'The queue is built and every count reads it. Nothing needs a decision yet; this is for you to read.',
  answers: [{ direction: 'right', does: 'done', label: 'Got it' }],
} as Partial<AgendaItem>);

/** 2. A QUESTION, with the report the owner asked for and a conversation. */
const QUESTION = item('A121', 35, {
  title: 'Should the badge count snoozed items?',
  subject: 'Should the badge count snoozed items?',
  kind: 'choice',
  stage: 'question',
  stages: [
    { stage: 'explainer', at: ago(120) },
    { stage: 'question', at: ago(35) },
  ],
  ...BRIEF,
  whereWeAre: REPORT,
  decided: '- Resting items never count\n- Blockers count first',
  stillOpen: '- Whether a snoozed item counts',
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'No', description: 'A snooze means "not now": it stays out of the count' },
      { label: 'Yes', description: 'Count it, so nothing hides' },
    ],
  },
  recommendation: { decision: 'No', why: '- A snooze is your own "not now"\n- A blocker still wakes it' },
  body: '**What changes for you.** The badge drops by the number of snoozed items. A blocker wakes a snoozed item, and then it counts again.',
  revisions: [
    {
      at: ago(30),
      by: 'agent',
      changed: ['stillOpen', 'whereWeAre'],
      previous: { stillOpen: '- Whether a snoozed item counts\n- Whether push repeats' },
    },
  ],
} as Partial<AgendaItem>);

/** 3. A PLAN TO APPROVE. */
const PLAN = item('A122', 25, {
  title: 'Plan: one queue for every count',
  subject: 'OK to build the one-queue plan?',
  kind: 'permission',
  ask: { kind: 'permission' },
  stage: 'plan',
  stages: [
    { stage: 'question', at: ago(90) },
    { stage: 'plan', at: ago(25) },
  ],
  premise: BRIEF.premise,
  context: BRIEF.context,
  whereWeAre: '- The plan is three PRs\n- Each one ships alone',
  impact: '- The badge, the Inbox and push read one queue\n- Nothing else changes',
  steps: ['Add `needsYouQueue`', 'Point every count at it', 'Add the test that they agree'],
} as Partial<AgendaItem>);

/** 4. A TRACKER: work in progress, resting while the ferret works. */
const TRACKER = item('A123', 15, {
  title: 'Building the one-queue plan',
  subject: 'Building the one-queue plan.',
  kind: 'info',
  stage: 'tracker',
  stages: [
    { stage: 'question', at: ago(200) },
    { stage: 'plan', at: ago(120) },
    { stage: 'tracker', at: ago(15) },
  ],
  parked: { reason: 'replied', at: ago(12) },
  resting: { sub: 'working', at: ago(12), why: 'Pointing the Inbox at the queue' },
  premise: BRIEF.premise,
  context: BRIEF.context,
  whereWeAre: '- PR 1 is merged\n- PR 2 is in review\n- PR 3 starts after PR 2',
  answers: [{ direction: 'right', does: 'done', label: 'Got it' }],
} as Partial<AgendaItem>);

/** 5. A TEST, carrying a card ask with its Done / Not good. */
const TEST = item('A124', 5, {
  title: 'Try the new badge',
  subject: 'Is the badge right on your phone?',
  kind: 'yesno',
  stage: 'test',
  stages: [
    { stage: 'question', at: ago(300) },
    { stage: 'plan', at: ago(240) },
    { stage: 'tracker', at: ago(120) },
    { stage: 'test', at: ago(5) },
  ],
  premise: BRIEF.premise,
  context: BRIEF.context,
  whereWeAre: 'The fix is released as v4.262. The card is ready to test.',
  ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
  gateAttached: {
    cardId: 'F559',
    laneId: 'tested',
    laneName: 'Released · to test',
    entry: 4,
    projectId: 'ferretry',
    cardTitle: 'One Needs-you queue',
    options: [
      { id: 'o0', label: 'Done', outcome: 'close' },
      { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
    ],
  },
  history: [
    { at: ago(60), kind: 'needs-info' },
    { at: ago(50), kind: 'updated' },
  ],
} as unknown as Partial<AgendaItem>);

/** 6. A TITLE LONGER THAN THE HEAD'S TWO LINES on a phone (a title's full 60 characters), its Yes listed before No. */
const LONG_TITLE = item('A125', 8, {
  title: 'Should a snoozed item still push you when a blocker wakes it?',
  subject: 'Should a snoozed item still push you when a blocker wakes it up again?',
  kind: 'yesno',
  stage: 'question',
  stages: [{ stage: 'question', at: ago(8) }],
  premise: BRIEF.premise,
  context: BRIEF.context,
  whereWeAre:
    'A blocker already wakes a snoozed item. Today it then pushes once, like any item that starts needing you.',
  ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
} as Partial<AgendaItem>);

/** The card's How to test, as the board holds it: the card ask above its Done / Not good carries these steps. */
export const PARTS_HOW_TO_TEST: Readonly<Record<string, string>> = {
  F559: [
    '1. Open the Inbox on your phone.',
    '2. Snooze one item, then look at the number on the Inbox tab: it must drop by one.',
    '3. Ask a ferret to raise a blocker on the snoozed item: the number must go back up by one.',
    '4. Open Settings, then Notifications: the push count must say the same number.',
  ].join('\n'),
};

export const PARTS_ITEMS = [EXPLAINER, QUESTION, PLAN, TRACKER, TEST, LONG_TITLE] as const;

const owner = (id: string, at: number, text: string) => ({ id, kind: 'user', text, at: NOW - at * 60_000 });
const ferretSays = (id: string, at: number, text: string) => ({ id, kind: 'assistant', text, at: NOW - at * 60_000 });

export const PARTS_ENTRIES = [
  ferretSays('p0', 36, 'I raised !A121 for you: should the badge count snoozed items?'),
  owner('p1', 34, '!A121 what does a snooze do to push today?'),
  ferretSays(
    'p2',
    33,
    [
      '## !A121 snooze and push',
      'A snoozed item never pushes. It wakes at the time you picked, or earlier when a blocker needs you.',
      'Then it pushes once, like any item that starts needing you.',
    ].join('\n'),
  ),
  owner('p3', 31, '!A121 and the report I asked for?'),
  ferretSays('p4', 30, 'Re !A121: the report is in "Where we are now", whole.'),
  owner('p5', 28, '!A121 leaning No'),
  ferretSays('p6', 27, 'Re !A121: noted. No is my recommendation too; the reasons are under the options.'),
] as unknown as TranscriptEntry[];
