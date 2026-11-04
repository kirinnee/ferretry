/**
 * THE ITEM VIEW'S LAYOUT v2 (docs/agenda.md § The item view; F909), drawn by the REAL `AgendaItemView` and the REAL agenda
 * renderer (`agendaProse`) over a REAL `DaemonBoardStore` that reads an invented board, so a `card` or `board` block in
 * the body is the board's own live card. `?scene=`:
 *
 *   question     a question whose body is a long report with a chart, a mini board and a fold
 *   explainer    an explainer whose body walks through how something works, with a live card
 *   test         a test carrying a card ask (its How to test and Done / Not good) beside the item's own ask
 *   long-title   a title longer than the head's two lines, drawn whole at the top of the body too
 *
 * Driven by `agenda-layout-screenshot.ts`. Every value here is invented; nothing is read from a real home.
 */

import type { AgendaItem } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { ReferenceSurfaceProvider } from '../src/components/reference-surface.tsx';
import { agendaProse } from '../src/features/agenda/agenda-prose.tsx';
import { AgendaItemView } from '../src/features/agenda/agenda-item-view.tsx';
import type { HistoryEvent } from '../src/lib/agenda-history.ts';
import { DaemonBoardStore } from '../src/lib/board-store.ts';
import { boardAnswer, card, laneSetFor, laptop, PROJECT } from '../tests/unit/board-support.ts';

const NOW = Date.now();
const MINUTE = 60_000;
const ago = (minutes: number): string => new Date(NOW - minutes * MINUTE).toISOString();
const OTTILIE = 'mvuc7tsf-0c3d50df';
const EMBER = 'mvudnuly-ec442385';

// ---- an invented board, read through the real store ------------------------------------------------------------

const cards = new Map<string, ReturnType<typeof card>>([
  ['F559', card('F559', { title: 'One Needs-you queue', laneId: 'review', owner: OTTILIE, lastTouchedAt: ago(4) })],
  ['F560', card('F560', { title: 'Badge reads the queue', laneId: 'merged', owner: OTTILIE, lastTouchedAt: ago(300) })],
  ['F561', card('F561', { title: 'Inbox reads the queue', laneId: 'implement', owner: EMBER, lastTouchedAt: ago(20) })],
  [
    'F562',
    card('F562', {
      title: 'Push reads the queue',
      laneId: 'todo',
      owner: EMBER,
      assignee: null,
      lastTouchedAt: ago(600),
    }),
  ],
]);
const lanes = laneSetFor();
const refused = async (): Promise<never> => {
  throw new Error('not served');
};
const store = new DaemonBoardStore({
  board: async () => boardAnswer([...cards.values()], { projectId: PROJECT, laneSet: lanes }),
  task: async (_daemon, id) => {
    const task = cards.get(id);
    return task === undefined ? null : { task, laneSet: lanes };
  },
  ids: async () => null,
  projects: async () => null,
  version: async () => '4.270.0',
  lanes: refused,
  act: refused,
  create: refused,
  start: refused,
});
const surface = { cardEmbed: { store, connection: laptop }, onTaskOpen: () => undefined };

// ---- the items -----------------------------------------------------------------------------------------------------

const FENCE = '```';
const block = (type: string, alt: string, payload: string): string =>
  [`${FENCE}fy-render`, `type: ${type}`, `alt: ${alt}`, '---', payload, FENCE].join('\n');

const item = (id: string, patch: Partial<AgendaItem>): AgendaItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    why: 'Needs a decision.',
    waitingSince: ago(30),
    howToResolve: 'Answer it.',
    raisedBy: 'agent',
    raisedBySession: OTTILIE,
    raisedByName: 'ottilie',
    ...patch,
  }) as AgendaItem;

const BRIEF = {
  premise: '- The Inbox badge counts what needs you\n- Today it also counts snoozed items',
  context: '- Owners asked why the count never reaches zero\n- One shared queue now feeds every count',
  terms: [
    { term: 'badge', meaning: 'The number on the Inbox tab: how many items wait on you.' },
    { term: 'snoozed', meaning: 'An item you put away until a time you picked.' },
  ],
  links: [{ label: 'The card this work is tracked on', target: '&F559', meaning: 'The one Needs-you queue' }],
} satisfies Partial<AgendaItem>;

const FINDINGS = Array.from(
  { length: 8 },
  (_, at) =>
    `<li><b>Finding ${String(at + 1)}.</b> The count on ${['phone', 'desktop'][at % 2]} read the open list, so a snoozed item added one.</li>`,
).join('');

const QUESTION_BODY = [
  '**The short answer:** the badge over-counts by the number of snoozed items. Leaving them out makes it reach zero.',
  '',
  '**What the count looks like, before and after the fix**',
  '',
  block(
    'chart',
    'Badge count before and after the fix, by day',
    [
      'kind: bar',
      'x: [Mon, Tue, Wed, Thu, Fri]',
      'y: {label: Items on the badge, min: 0}',
      'series:',
      '  - {name: Before, data: [9, 11, 8, 12, 10]}',
      '  - {name: After, data: [4, 5, 3, 6, 4], tone: good}',
    ].join('\n'),
  ),
  '',
  '**Where the work stands**',
  '',
  block('board', 'The cards of the one-queue work, by lane', '&F560\n&F561\n&F562'),
  '',
  '**What changes for you if you pick No**',
  '',
  '- The badge drops by the number of snoozed items',
  '- A blocker still wakes a snoozed item, and then it counts again',
  '- Push and the Inbox agree with the badge, always',
  '',
  block(
    'html',
    'Every finding of the report, folded',
    `<details><summary>All eight findings</summary><ol>${FINDINGS}</ol></details>`,
  ),
  '',
  '**The last line of the report:** every count now agrees.',
].join('\n');

const QUESTION = item('A121', {
  title: 'Should the badge count snoozed items?',
  subject: 'Snoozed items still add one each to the Inbox badge. Should they keep counting?',
  kind: 'choice',
  stage: 'question',
  stages: [
    { stage: 'explainer', at: ago(120) },
    { stage: 'question', at: ago(35) },
  ],
  ...BRIEF,
  detail: 'The **badge** is the small number on the Inbox tab. It should say how many items wait on you right now.',
  whereWeAre: '- The one-queue fix is built and tested\n- Only the snooze rule is left',
  decided: '- Resting items never count\n- Blockers count first',
  stillOpen: '- Whether a snoozed item counts',
  questions: [
    {
      question: 'Should a snoozed item count on the badge?',
      options: [
        { label: 'No', description: 'A snooze means "not now": it stays out of the count' },
        { label: 'Yes', description: 'Count it, so nothing hides' },
      ],
      recommended: 'No',
    },
  ],
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'No', description: 'A snooze means "not now": it stays out of the count' },
      { label: 'Yes', description: 'Count it, so nothing hides' },
    ],
  },
  recommendation: { decision: 'No', why: '- A snooze is your own "not now"\n- A blocker still wakes it' },
  body: QUESTION_BODY,
  revisions: [
    { at: ago(30), by: 'agent', changed: ['body', 'whereWeAre'], previous: { whereWeAre: '- Building the fix' } },
  ],
} as unknown as Partial<AgendaItem>);

const EXPLAINER = item('A120', {
  title: 'How the Needs-you queue works now',
  subject: 'Read how one queue now decides what needs you, before the snooze question.',
  kind: 'info',
  stage: 'explainer',
  stages: [{ stage: 'explainer', at: ago(40) }],
  ...BRIEF,
  whereWeAre: '- Built and merged\n- This is for you to read before the snooze question',
  body: [
    '**In one line:** every count — the badge, the Inbox, push — now reads ONE list of what needs you.',
    '',
    '**How an item gets on the list, step by step**',
    '',
    '1. A ferret raises an item: it **needs you**.',
    '2. You answer or reply: it **rests**, waiting on the ferret, and leaves the list.',
    '3. The ferret answers you: it comes **back**, in its old place.',
    '4. You snooze it: it leaves the list until the time you picked.',
    '',
    '**The card this is tracked on**',
    '',
    block('card', 'The one-queue card', '&F559'),
  ].join('\n'),
  answers: [{ direction: 'right', does: 'done', label: 'Got it' }],
} as Partial<AgendaItem>);

const TEST = item('A124', {
  title: 'Try the new badge',
  subject: 'Is the badge right on your phone now?',
  kind: 'yesno',
  stage: 'test',
  stages: [
    { stage: 'plan', at: ago(240) },
    { stage: 'test', at: ago(5) },
  ],
  premise: BRIEF.premise,
  context: BRIEF.context,
  whereWeAre: '- Released in v4.262\n- The card is ready to test',
  ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
  body: [
    '**Status:** the fix is out. Three of the four pieces are done.',
    '',
    block('board', 'The pieces of the one-queue work', '&F559\n&F560\n&F561'),
  ].join('\n'),
  gateAttached: {
    cardId: 'F559',
    laneId: 'tested',
    laneName: 'Released · to test',
    entry: 4,
    projectId: PROJECT,
    cardTitle: 'One Needs-you queue',
    options: [
      { id: 'o0', label: 'Done', outcome: 'close' },
      { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
    ],
  },
} as unknown as Partial<AgendaItem>);

const LONG_TITLE = item('A125', {
  title: 'Should a snoozed item still push you when a blocker wakes it?',
  subject:
    'A blocker wakes a snoozed item early. Should that wake-up also buzz your phone, or stay quiet until you look?',
  kind: 'yesno',
  stage: 'question',
  stages: [{ stage: 'question', at: ago(8) }],
  premise: BRIEF.premise,
  context: BRIEF.context,
  whereWeAre: '- A blocker already wakes a snoozed item\n- Today it then pushes once',
  ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
  body: '**What a push would mean:** one buzz, the moment the blocker lands — the same as any item that starts needing you.',
} as Partial<AgendaItem>);

const HOW_TO_TEST: Readonly<Record<string, string>> = {
  F559: [
    '1. Open the Inbox on your phone.',
    '2. Snooze one item: the number on the Inbox tab must drop by one.',
    '3. Ask a ferret to raise a blocker on it: the number must go back up by one.',
  ].join('\n'),
};

const said = (kind: 'owner' | 'ferret', key: string, minutes: number, text: string): HistoryEvent =>
  ({ kind, key, at: NOW - minutes * MINUTE, text }) as HistoryEvent;

const CONVERSATION: readonly HistoryEvent[] = [
  said('owner', 'o1', 34, 'What does a snooze do to push today?'),
  said('ferret', 'f1', 33, 'Re !A121: a snoozed item never pushes until it wakes. The full picture is in the body.'),
  said('owner', 'o2', 28, 'Leaning No.'),
  said('ferret', 'f2', 27, 'Re !A121: noted — No is my recommendation too. The reasons are under the options.'),
];

const SCENES: Readonly<Record<string, { readonly item: AgendaItem; readonly history: readonly HistoryEvent[] }>> = {
  question: { item: QUESTION, history: CONVERSATION },
  explainer: { item: EXPLAINER, history: [] },
  test: { item: TEST, history: [said('ferret', 'f3', 4, 'Re !A124: released; the steps are on the card.')] },
  'long-title': { item: LONG_TITLE, history: [] },
};

const scene = SCENES[new URLSearchParams(location.search).get('scene') ?? 'question'] ?? SCENES.question;
const prose = agendaProse();

createRoot(document.getElementById('root') as HTMLElement).render(
  <ReferenceSurfaceProvider surface={surface}>
    <main data-fixture style={{ display: 'grid', height: '100dvh' }}>
      {scene === undefined ? null : (
        <AgendaItemView
          busy={false}
          error={null}
          ferret="ottilie"
          history={scene.history}
          howToTestFor={id => HOW_TO_TEST[id] ?? null}
          item={scene.item}
          itemKey={`harness/${scene.item.id}`}
          now={NOW}
          onAct={() => undefined}
          onClose={() => undefined}
          position={{ index: 0, total: 4 }}
          renderProse={prose}
          swipeable={false}
        />
      )}
    </main>
  </ReferenceSurfaceProvider>,
);
