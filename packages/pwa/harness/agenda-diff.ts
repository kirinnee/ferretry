/**
 * THE DIFF, MERGE AND SPLIT FIXTURES (`agenda-diff-page.tsx`, driven by `agenda-diff-screenshot.ts`): A140 is an item
 * kept as three versions (where we are now REWRITTEN, so it draws as a block out and a block in; one word added to a term, so it draws as a word
 * diff; a term added; the ask replaced) with a stored conversation that
 * holds words copied from the owner's chat; A141 and A142 are two open conversations a merge can join; A143 is a closed
 * item that was merged into A141; A144 and A145 are a split pair. The "daemon" is `agenda-diff-page.tsx`'s fetch stub.
 */

import type { AgendaConversationEntry, AgendaItem, AgendaVersionList, ResolvedAgendaItem } from '@ferretry/protocol';

export const DIFF_NOW = Date.parse('2026-10-29T09:00:00.000Z');
const ago = (minutes: number): string => new Date(DIFF_NOW - minutes * 60_000).toISOString();

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

const BADGE_V1 = 'The number on the Inbox tab: how many items wait on you.';
const BADGE_V3 = 'The number on the Inbox tab: how many open items wait on you.';

const BASE = {
  title: 'Should the badge count snoozed items?',
  subject: 'Should the badge count snoozed items?',
  kind: 'choice',
  stage: 'question',
  premise: '- The Inbox badge counts what needs you\n- Today it counts resting items too',
  context: '- Owners asked why the count never reaches zero\n- The fix is one selector, shared by every count',
  terms: [
    { term: 'badge', meaning: BADGE_V1 },
    { term: 'Resting', meaning: 'An item waiting on its ferret, not on you.' },
  ],
  decided: '- Resting items never count',
} satisfies Partial<AgendaItem>;

const ASK_V1 = {
  kind: 'multiple-choice',
  options: [{ label: 'Yes', description: 'Count it, so nothing hides' }, { label: 'No' }],
};
const ASK_V3 = {
  kind: 'multiple-choice',
  options: [
    { label: 'No', description: 'A snooze means "not now": it stays out of the count' },
    { label: 'Only blockers', description: 'A snoozed blocker still counts, nothing else' },
  ],
};

/** Version 1, 2 and 3 of A140, as the daemon keeps them: the WHOLE item each time. */
export const DIFF_VERSIONS: readonly AgendaItem[] = [
  item('A140', 180, {
    ...BASE,
    whereWeAre: 'I am reading how the badge is counted. Nothing is decided yet.',
    stillOpen: '- Whether a snoozed item counts',
    ask: ASK_V1,
  } as Partial<AgendaItem>),
  item('A140', 180, {
    ...BASE,
    whereWeAre: 'The badge reads the open list, so a resting item adds one. I am looking at the queue.',
    stillOpen: '- Whether a snoozed item counts',
    ask: ASK_V1,
  } as Partial<AgendaItem>),
  item('A140', 180, {
    ...BASE,
    terms: [
      { term: 'badge', meaning: BADGE_V3 },
      ...BASE.terms.slice(1),
      { term: 'needsYouQueue', meaning: 'The one function that lists what needs you, blockers first.' },
    ],
    whereWeAre:
      'The badge, the Inbox and push now read needsYouQueue, so the three agree. A snoozed item is the one open question.',
    stillOpen: '- Whether a snoozed item counts',
    ask: ASK_V3,
  } as Partial<AgendaItem>),
];

const at = (minutes: number): string => ago(minutes);

export const DIFF_LIST: AgendaVersionList = {
  sessionId: 'fr',
  id: 'A140' as AgendaVersionList['id'],
  latest: 3,
  seen: 1,
  versions: [
    { version: 1, at: at(180), by: 'ferret', change: 'created', lifecycle: 'active' },
    { version: 2, at: at(95), by: 'ferret', change: 'edited', lifecycle: 'active' },
    { version: 3, at: at(20), by: 'ferret', change: 'edited', lifecycle: 'active' },
  ],
};

/** The stored thread of A140: the owner's chat words the ferret logged, a typed reply and a ferret answer. */
export const DIFF_CONVERSATION: readonly AgendaConversationEntry[] = [
  {
    at: at(170),
    by: 'owner',
    via: 'chat-log',
    text: 'Does a snooze count towards the badge today?',
    fromChat: { messageId: 'm1', at: at(171) },
  },
  {
    at: at(165),
    by: 'ferret',
    via: 'question-answer',
    text: 'Today yes: the badge reads the open list. I am moving it to one queue.',
  },
  { at: at(60), by: 'owner', via: 'reply', text: 'Leaning No, but blockers should still wake it.' },
  {
    at: at(40),
    by: 'ferret',
    via: 'question-answer',
    text: 'Noted. I added "Only blockers" as an option beside No.',
  },
];

export const A140 = {
  ...DIFF_VERSIONS[2],
  // The item carries only its newest entries; the earlier two are read through the conversation route.
  conversation: DIFF_CONVERSATION.slice(2),
  conversationCount: DIFF_CONVERSATION.length,
  revisions: [
    { at: at(95), by: 'agent', changed: ['whereWeAre'], previous: { whereWeAre: DIFF_VERSIONS[0]?.whereWeAre ?? '' } },
    { at: at(20), by: 'agent', changed: ['whereWeAre', 'terms', 'ask'], previous: {} },
  ],
  links: [
    {
      label: 'The fix: every count reads one queue',
      target: 'https://github.com/kirinnee/ferretry/pull/1413',
      meaning: 'The change that gives the badge, the Inbox and push one queue.',
    },
    { label: 'The card this work is tracked on', target: '&F559' },
  ],
} as unknown as AgendaItem;

export const A141 = item('A141', 50, {
  title: 'Where do snoozed items go?',
  subject: 'Where should a snoozed item sit in the Inbox?',
  kind: 'choice',
  stage: 'question',
  mergedFrom: ['A143'],
  ask: { kind: 'multiple-choice', options: [{ label: 'Bottom' }, { label: 'Hidden' }] },
} as unknown as Partial<AgendaItem>);

export const A142 = item('A142', 30, {
  title: 'Does push repeat for a woken item?',
  subject: 'Should a woken item push again?',
  kind: 'choice',
  stage: 'question',
  ask: { kind: 'multiple-choice', options: [{ label: 'Once' }, { label: 'Every time' }] },
} as unknown as Partial<AgendaItem>);

export const A143 = {
  ...item('A143', 90, {
    title: 'Snoozed items in the Inbox',
    subject: 'Where should snoozed items sit?',
    mergedInto: 'A141',
  } as unknown as Partial<AgendaItem>),
  resolvedAt: ago(10),
  resolvedBy: 'daemon',
  resolvedBySession: null,
  resolvedByName: null,
  resolutionNote: 'Merged into !A141.',
  disposition: 'done',
} as unknown as ResolvedAgendaItem;

export const A144 = item('A144', 70, {
  title: 'Split off: the snooze copy',
  subject: 'What should the snooze button say?',
  kind: 'choice',
  stage: 'question',
  splitFrom: 'A140',
  ask: { kind: 'multiple-choice', options: [{ label: 'Snooze' }, { label: 'Later' }] },
} as unknown as Partial<AgendaItem>);

/** The origin of the split pair: it names both children. */
export const A146 = item('A146', 75, {
  title: 'Badge and snooze rework',
  subject: 'Which part of the rework first?',
  kind: 'choice',
  stage: 'question',
  splitInto: ['A144', 'A145'],
  ask: { kind: 'multiple-choice', options: [{ label: 'Badge' }, { label: 'Snooze' }] },
} as unknown as Partial<AgendaItem>);

export const A145 = item('A145', 68, {
  title: 'Split off: the badge count',
  subject: 'Should the badge count a blocker that is snoozed?',
  kind: 'choice',
  stage: 'question',
  splitFrom: 'A146',
  ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
} as unknown as Partial<AgendaItem>);
