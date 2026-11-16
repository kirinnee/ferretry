import {
  type AgendaActionRequest,
  type AgendaCardAnswer,
  type AgendaId,
  type AgendaItem,
  agendaCardAnswers,
  formatTaskRef,
  type TaskRef,
} from '@ferretry/core-asks/contract';
import { agendaReference } from './reference.ts';

/**
 * SEARCH, CHECK, THEN OPEN (docs/agenda.md § One channel per topic): before a ferret opens a new agenda, the open ones
 * it could add to instead, closest first. An agenda is one channel of the owner's attention, and two things share one
 * when they pass the three-part test — same place, same context, same pace — so `fy agenda add` lists these, asks
 * "Should this join !A3?", and opens a new one only on `--new "<why none fits>"`.
 *
 * Pure: the controller reads the ledger and hands it here.
 */

/** Where a candidate stands, in the owner's words: Needs you buzzes them; Resting and Snoozed are quiet. */
export type CandidateState = 'needs you' | 'resting' | 'snoozed';

export interface AgendaCandidate {
  readonly id: AgendaId;
  readonly title: string;
  readonly state: CandidateState;
  /** The cards it carries, as cited (`&F12`). */
  readonly cards: readonly string[];
  readonly item: AgendaItem;
}

export interface CandidateQuery {
  /** The ledger the new item would join: the caller's own agenda. */
  readonly sessionId: string;
  readonly title: string;
  readonly ask: string;
}

/** The most candidates one listing prints; the rest are one `fy agenda ls` away. */
export const MAX_LISTED_CANDIDATES = 8;

/**
 * Whether an open item is one a ferret could add to: one a ferret raised and can edit. A notice is read, never added
 * to; a held configuration change, a card gate and the daemon's own cards (an input form, a phone approval) answer one
 * thing each; and an item the owner raised is theirs.
 */
export const isAgendaCandidate = (item: AgendaItem): boolean =>
  item.raisedBy === 'agent' &&
  item.notice !== true &&
  item.confirms === undefined &&
  (item.cardAsks ?? []).length === 0 &&
  item.input === undefined;

/** Where an open item stands: snoozed by the owner, resting (they replied, or it is the ferret's turn), or needs you. */
export const candidateState = (item: AgendaItem): CandidateState =>
  item.parked?.reason === 'snoozed'
    ? 'snoozed'
    : item.parked !== undefined || item.waitingOn === 'ferret'
      ? 'resting'
      : 'needs you';

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'what',
  'which',
  'should',
  'would',
  'could',
  'your',
  'you',
  'our',
  'are',
  'was',
  'were',
  'has',
  'have',
  'not',
  'now',
  'yet',
  'can',
  'its',
  'one',
  'all',
  'any',
  'how',
  'why',
  'who',
  'when',
  'where',
  'about',
  'need',
  'needs',
]);

/** The words that carry meaning: lower-cased, three letters or more, no stop words. */
const significantWords = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(word => word.length >= 3 && !STOP_WORDS.has(word)),
  );

/** How many meaningful words two texts share. */
export const sharedWords = (left: string, right: string): number => {
  const theirs = significantWords(right);
  let shared = 0;
  for (const word of significantWords(left)) if (theirs.has(word)) shared += 1;
  return shared;
};

const refKey = (ref: TaskRef): string => formatTaskRef(ref);

/**
 * The open agendas a new item could join, closest first: by the words they share, then the oldest. Every candidate is listed, however weak: the ferret decides, with the three-part test.
 */
export function agendaCandidates(items: readonly AgendaItem[], query: CandidateQuery): AgendaCandidate[] {
  const text = `${query.title}\n${query.ask}`;
  return items
    .filter(isAgendaCandidate)
    .map((item, order) => {
      return {
        candidate: {
          id: item.id,
          title: item.title ?? item.subject,
          state: candidateState(item),
          cards: item.task === undefined || item.task === null ? [] : [refKey(item.task)],
          item,
        } satisfies AgendaCandidate,
        rank: [sharedWords(text, `${item.title ?? ''}\n${item.subject}`), -Date.parse(item.waitingSince), -order],
      };
    })
    .sort((left, right) => {
      const decided = left.rank
        .map((value, at) => (right.rank[at] ?? 0) - value)
        .find(difference => difference !== 0 && !Number.isNaN(difference));
      return decided ?? 0;
    })
    .map(entry => entry.candidate);
}

/** The points of a bulleted segment as plain lines: what a repeated flag gives back. */
export const points = (segment: string | null | undefined): string[] =>
  (segment ?? '')
    .split('\n')
    .map(line => line.replace(/^\s*[-*]\s+/u, '').trim())
    .filter(line => line !== '');

/** One shell word, single-quoted, so a line with spaces or quotes pastes back as typed. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const flags = (flag: string, values: readonly string[]): string =>
  values.map(value => ` ${flag} ${shellQuote(value)}`).join('');

const union = (left: readonly string[], right: readonly string[]): string[] => [
  ...left,
  ...right.filter(point => !left.includes(point)),
];

type AddRequest = Extract<AgendaActionRequest, { action: 'add' }>;

const ASK_WORDS: Readonly<Record<NonNullable<AddRequest['ask']>['kind'], string>> = {
  'multiple-choice': 'options to choose from',
  permission: 'an approval to give',
  'answer-review': 'an answer to review',
  'open-question': 'a question to answer in words',
  task: 'something for the owner to do',
};

const answerKey = (answer: AgendaCardAnswer): string =>
  JSON.stringify([answer.direction, answer.does, answer.label.trim(), answer.description ?? '']);

/** Whether the new ask has an answer (an `--up` label, say) that the candidate does not already offer. */
function answersOfItsOwn(item: AgendaItem, request: AddRequest): boolean {
  const offered = new Set(agendaCardAnswers(item).map(answerKey));
  return agendaCardAnswers(request).some(answer => !offered.has(answerKey(answer)));
}

/** What the new ask says that `fy agenda edit` cannot add to an open agenda, in plain words; empty when nothing. */
function beyondEdit(candidate: AgendaCandidate, request: AddRequest, card: TaskRef | undefined): string[] {
  const { item } = candidate;
  const { ask } = request;
  const sameAsk =
    ask !== undefined && (ask.kind === 'open-question' || ask.kind === 'task') && item.ask?.kind === ask.kind;
  const filled = (list: readonly unknown[] | undefined): boolean => list !== undefined && list.length > 0;
  const tiedElsewhere =
    card !== undefined && (item.task === undefined || item.task === null || refKey(item.task) !== refKey(card));
  const found: [boolean, string][] = [
    [ask !== undefined && !sameAsk, ask === undefined ? '' : ASK_WORDS[ask.kind]],
    [(ask === undefined || sameAsk) && answersOfItsOwn(item, request), 'answers of its own (--up)'],
    [filled(request.questions), 'questions'],
    [filled(request.fields), 'a form'],
    [filled(request.optionDetails), 'option details'],
    [filled(request.steps), 'steps'],
    [request.body !== undefined, 'a body'],
    [request.recommendation !== undefined, 'a recommendation'],
    [request.impact !== undefined, 'what happens if nobody answers'],
    [request.urgency !== undefined, 'an urgency'],
    [request.blockingNow === true, 'blocking the ferret now'],
    [request.willBlock !== undefined, 'what it will block'],
    [request.neededBy !== undefined, 'a deadline'],
    [filled(request.links), 'links'],
    [filled(request.terms), 'terms'],
    [request.why !== request.subject, 'a reason of its own (--why)'],
    [request.howToResolve !== item.howToResolve, 'its own way to resolve it (--resolve)'],
    [tiedElsewhere, card === undefined ? '' : `the card ${refKey(card)}`],
    [request.offerClose === true && item.offerClose !== true, 'the Done button (--offer-close)'],
  ];
  return found.filter(([present]) => present).map(([, words]) => words);
}

/** How a new ask reaches a candidate: the one `fy agenda edit` that loses nothing, or what would be lost. */
export type JoinPlan =
  | { readonly kind: 'edit'; readonly command: string }
  | { readonly kind: 'new'; readonly carries: readonly string[] };

/**
 * Whether the new ask can join the candidate without losing any of it, and the exact command when it can. `fy agenda
 * edit` rewords an open agenda: it can add lines to what is still open, the premise, the context and the earlier
 * answers, but it cannot give the agenda a new question, options, body, blocking, urgency or deadline. So an ask that
 * is plain words (a line, with its premise and context) joins by one edit that keeps everything both agendas say, and
 * any other ask is never squeezed into one: the plan says what would be lost, and its own agenda is the safe way out.
 *
 * An item the owner replied to is Resting. The joined update answers on that item (`--question-answer`) to return
 * it to the owner; the new line becomes its summary and the old summary stays in what is still open.
 */
export function joinPlan(
  binary: string,
  candidate: AgendaCandidate,
  request: AddRequest,
  card?: TaskRef | undefined,
): JoinPlan {
  const carries = beyondEdit(candidate, request, card);
  if (carries.length > 0) return { kind: 'new', carries };
  const { item } = candidate;
  const replied = item.parked?.reason === 'replied';
  const stillOpen = union(
    union(points(item.stillOpen), replied ? [item.subject] : []),
    union([request.subject], points(request.stillOpen)),
  );
  const decided = union(points(item.decided), points(request.decided));
  const edit = [
    `${binary} agenda edit ${candidate.id}`,
    flags('--still-open', stillOpen),
    flags('--premise', union(points(item.premise), points(request.premise))),
    flags('--context', union(points(item.context), points(request.context))),
    decided.length > points(item.decided).length ? flags('--decided', decided) : '',
    replied ? `${flags('--question-answer', [request.subject])}${flags('--summary', [request.subject])}` : '',
  ].join('');
  return { kind: 'edit', command: edit };
}

/** The way out when the ask cannot join: its own agenda, said why, naming the closest one it was weighed against. */
const newWay = (binary: string, candidate: AgendaCandidate): string =>
  `${binary} agenda add … --new "<why none fits; closest is ${agendaReference(candidate.id)}>"`;

/** What choosing to join prints: the edit that adds the ask, or why it cannot be added and the way out. */
export function joinAdvice(binary: string, candidate: AgendaCandidate, plan: JoinPlan): string {
  const reference = agendaReference(candidate.id);
  if (plan.kind === 'edit') return `Nothing was opened. Add it to ${reference}:\n${plan.command}`;
  return [
    `Nothing was opened. This ask has ${plan.carries.join(', ')}, which ${reference} cannot take: an agenda edit cannot add them until the agenda edit verbs land, and squeezing it in would drop them.`,
    `The safe way out is its own agenda, saying why and naming ${reference} as the closest:`,
    `  ${newWay(binary, candidate)}`,
  ].join('\n');
}

/** What a person who did not say yes is told: nothing was opened, and the two ways out. */
export function waysOut(binary: string, candidate: AgendaCandidate, plan: JoinPlan): string {
  if (plan.kind === 'new') return joinAdvice(binary, candidate, plan);
  return [
    `Nothing was opened. Join it to ${agendaReference(candidate.id)}:`,
    `  ${plan.command}`,
    'or open a new agenda only when none passes the test:',
    `  ${binary} agenda add … --new "<why none fits>"`,
  ].join('\n');
}

/** The listing `fy agenda add` prints before it opens anything: the candidates, the question, the two ways out. */
export function renderCandidates(
  candidates: readonly AgendaCandidate[],
  options: {
    readonly binary: string;
    readonly request: AddRequest;
    readonly named?: TaskRef | undefined;
    /** Set when a new agenda is being opened anyway (`--new`): the reason given. */
    readonly opening?: string | undefined;
  },
): string {
  const [closest] = candidates;
  if (closest === undefined) return '';
  const plan = joinPlan(options.binary, closest, options.request, options.named);
  const listed = candidates.slice(0, MAX_LISTED_CANDIDATES);
  const refWidth = Math.max(...listed.map(each => agendaReference(each.id).length));
  const stateWidth = Math.max(...listed.map(each => each.state.length));
  const rows = listed.map(each =>
    [
      `  ${agendaReference(each.id).padEnd(refWidth)}  ${each.state.padEnd(stateWidth)}  ${each.title}`,
      each.cards.length === 0 ? '' : `  ${each.cards.join(' ')}`,
    ].join(''),
  );
  const more = candidates.length - listed.length;
  return [
    'Search, check, then open: these agendas are open, closest first.',
    ...rows,
    ...(more > 0 ? [`  … and ${String(more)} more: ${options.binary} agenda ls`] : []),
    '',
    `Should this join ${agendaReference(closest.id)}? It does when all three hold: same place, same context, same pace;`,
    ...(plan.kind === 'edit'
      ? [
          'dependent things always share one. If unsure, join the closest. Add it there instead (nothing is opened):',
          `  ${plan.command}`,
        ]
      : [
          `dependent things always share one. But this ask has ${plan.carries.join(', ')}, which an agenda edit cannot add`,
          'to it until the agenda edit verbs land: joining would drop them, so it is not joined for you.',
        ]),
    '',
    ...(options.opening === undefined
      ? [
          'Open a new agenda only when none passes the test:',
          `  ${plan.kind === 'edit' ? `${options.binary} agenda add … --new "<why none fits>"` : newWay(options.binary, closest)}`,
        ]
      : [`Opening a new agenda anyway: ${options.opening}`]),
  ].join('\n');
}
