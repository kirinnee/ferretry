import {
  type AgendaActionRequest,
  type AgendaId,
  type AgendaItem,
  formatTaskRef,
  type TaskRef,
  type WorkRelatedResponse,
} from '@ferretry/protocol';
import { agendaReference } from './reference.ts';

/**
 * SEARCH, CHECK, THEN OPEN (docs/agenda.md § One channel per topic): before a ferret opens a new agenda, the open ones
 * it could add to instead, closest first. An agenda is one channel of the owner's attention, and two things share one
 * when they pass the three-part test — same place, same context, same pace — so `fy agenda add` lists these, asks
 * "Should this join !A3?", and opens a new one only on `--new "<why none fits>"`.
 *
 * Pure: the controller reads the ledger, the daemon's related matches and the card's ties, and hands them here.
 */

/** Where a candidate stands, in the owner's words: Needs you buzzes them; Resting and Snoozed are quiet. */
export type CandidateState = 'needs you' | 'resting' | 'snoozed';

/** How the card the new item names is tied to the card a candidate carries. */
type CardTie = 'same card' | 'depends on' | 'blocks';

export interface AgendaCandidate {
  readonly id: AgendaId;
  readonly title: string;
  readonly state: CandidateState;
  /** The cards it carries, as cited (`&F12`). */
  readonly cards: readonly string[];
  /** Set when it carries the card the new item names, or a card that one depends on or blocks (DoD 2). */
  readonly tie?: { readonly kind: CardTie; readonly card: string } | undefined;
  readonly item: AgendaItem;
}

/** The card a new item names (`--task`), and the cards it depends on and blocks, as the board reports them. */
export interface CardTies {
  readonly card: TaskRef;
  readonly dependsOn: readonly TaskRef[];
  readonly blocks: readonly TaskRef[];
}

export interface CandidateQuery {
  /** The ledger the new item would join: the caller's own agenda. */
  readonly sessionId: string;
  readonly title: string;
  readonly ask: string;
  readonly related?: WorkRelatedResponse | undefined;
  readonly ties?: CardTies | undefined;
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
  item.gate === undefined &&
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

/** The tie between the card a new item names and the card an item carries, strongest first. */
function tieOf(item: AgendaItem, ties: CardTies | undefined): AgendaCandidate['tie'] {
  if (ties === undefined || item.task === undefined || item.task === null) return undefined;
  const carried = refKey(item.task);
  if (carried === refKey(ties.card)) return { kind: 'same card', card: carried };
  if (ties.dependsOn.some(ref => refKey(ref) === carried)) return { kind: 'depends on', card: carried };
  if (ties.blocks.some(ref => refKey(ref) === carried)) return { kind: 'blocks', card: carried };
  return undefined;
}

const TIE_RANK: Record<CardTie, number> = { 'same card': 3, 'depends on': 2, blocks: 2 };

/**
 * The open agendas a new item could join, closest first: one carrying the same or a dependent card (dependent things
 * always share one agenda), then the daemon's strong and weak related matches, then by the words they share, then the
 * oldest. Every candidate is listed, however weak: the ferret decides, with the three-part test.
 */
export function agendaCandidates(items: readonly AgendaItem[], query: CandidateQuery): AgendaCandidate[] {
  const strength = new Map<string, number>();
  for (const match of query.related?.matches ?? []) {
    if (match.hit.kind !== 'agenda' || match.hit.sessionId !== query.sessionId) continue;
    strength.set(match.hit.id, Math.max(strength.get(match.hit.id) ?? 0, match.strength === 'strong' ? 2 : 1));
  }
  const text = `${query.title}\n${query.ask}`;
  return items
    .filter(isAgendaCandidate)
    .map((item, order) => {
      const tie = tieOf(item, query.ties);
      return {
        candidate: {
          id: item.id,
          title: item.title ?? item.subject,
          state: candidateState(item),
          cards: item.task === undefined || item.task === null ? [] : [refKey(item.task)],
          ...(tie === undefined ? {} : { tie }),
          item,
        } satisfies AgendaCandidate,
        rank: [
          tie === undefined ? 0 : TIE_RANK[tie.kind],
          strength.get(item.id) ?? 0,
          sharedWords(text, `${item.title ?? ''}\n${item.subject}`),
          -Date.parse(item.waitingSince),
          -order,
        ],
      };
    })
    .sort((left, right) => {
      for (let at = 0; at < left.rank.length; at += 1) {
        const difference = (right.rank[at] ?? 0) - (left.rank[at] ?? 0);
        if (difference !== 0 && !Number.isNaN(difference)) return difference;
      }
      return 0;
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

/**
 * The exact `fy agenda edit` that adds the new ask to a candidate instead of opening a new agenda: the ask joins what
 * is still open. An item the owner replied to is Resting and its card must be written again whole to come back
 * (`--back` with the ask, premise and context), so its command carries both cards' points.
 */
export function joinCommand(binary: string, candidate: AgendaCandidate, request: AddRequest): string {
  const { item } = candidate;
  const stillOpen = union(points(item.stillOpen), [request.subject]);
  const base = `${binary} agenda edit ${candidate.id}${flags('--still-open', stillOpen)}`;
  if (item.parked?.reason !== 'replied') return base;
  return `${base} --back${flags('--summary', [request.subject])}${flags(
    '--premise',
    union(points(item.premise), points(request.premise)),
  )}${flags('--context', union(points(item.context), points(request.context)))}`;
}

/** Why a candidate is listed first, in plain words: the card it shares with the new item. */
function tieLine(tie: NonNullable<AgendaCandidate['tie']>, named: string): string {
  switch (tie.kind) {
    case 'same card':
      return `carries ${tie.card}, the card this one names`;
    case 'depends on':
      return `carries ${tie.card}, which ${named} depends on`;
    case 'blocks':
      return `carries ${tie.card}, which depends on ${named}`;
  }
}

/** The listing `fy agenda add` prints before it opens anything: the candidates, the question, the two ways out. */
export function renderCandidates(
  candidates: readonly AgendaCandidate[],
  options: { readonly binary: string; readonly request: AddRequest; readonly named?: TaskRef | undefined },
): string {
  const listed = candidates.slice(0, MAX_LISTED_CANDIDATES);
  const refWidth = Math.max(...listed.map(each => agendaReference(each.id).length));
  const stateWidth = Math.max(...listed.map(each => each.state.length));
  const named = options.named === undefined ? '' : refKey(options.named);
  const rows = listed.map(each =>
    [
      `  ${agendaReference(each.id).padEnd(refWidth)}  ${each.state.padEnd(stateWidth)}  ${each.title}`,
      each.cards.length === 0 ? '' : `  ${each.cards.join(' ')}`,
      each.tie === undefined ? '' : `  ← ${tieLine(each.tie, named)}`,
    ].join(''),
  );
  const more = candidates.length - listed.length;
  const [closest] = listed;
  if (closest === undefined) return '';
  return [
    'Search, check, then open: these agendas are open, closest first.',
    ...rows,
    ...(more > 0 ? [`  … and ${String(more)} more: ${options.binary} agenda ls`] : []),
    '',
    `Should this join ${agendaReference(closest.id)}? It does when all three hold: same place, same context, same pace;`,
    'dependent things always share one. If unsure, join the closest. Add it there instead (nothing is opened):',
    `  ${joinCommand(options.binary, closest, options.request)}`,
    '',
    'Open a new agenda only when none passes the test:',
    `  ${options.binary} agenda add … --new "<why none fits>"`,
  ].join('\n');
}
