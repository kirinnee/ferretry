/**
 * CARD ASKS — the pure half (docs/board.md § Cards show progress; their asks ride the agenda). When an owner-asked card
 * enters a lane whose stage is a gate, the daemon puts ONE card ask on the agenda that carries it; this file decides,
 * from the card and its lanes alone, whether a card is at a gate now, which entry put it there, what a new card agenda
 * says, and where the owner's answer sends the card. `GateItems` (`gate-items.ts`) does the reading and writing.
 */
import type { AskDraft, EntryId, SourceKey } from '@ferretry/core-asks/contract';
import {
  type Card,
  type CardAskRef,
  type CardGate,
  type CardGateOption,
  type CardRef,
  clipAtWord,
  formatCardRef,
  type GateOption,
  type GateOutcomeError,
  type GuideProduct,
  gateAskLabels,
  gateAskLine,
  gateOptions,
  gateOutcomeLane,
  gateReference,
  gateStyle,
  isSubCard,
  type Lane,
  type LaneSet,
  laneOf,
  NOTHING_TO_TRY_PREFIX,
  tryItText,
  type Workflow,
} from '../../../contract/index.ts';
import type { CardAudience } from './authority.ts';

/** The longest card title, subject, reason and body an ask carries (Asks' own limits, so a draft always parses). */
const MAX_ASK_TITLE_LENGTH = 60;
const MAX_ASK_SUBJECT_LENGTH = 240;
const MAX_ASK_BODY_LENGTH = 64_000;

/** What a card's ask asks of the owner beside its buttons: the buttons move the card; the ferret closes it. */
export const CARD_ASK_HOW_TO_RESOLVE = "Answer the card's ask here (its buttons move the card); reply to talk it over.";
import { cardVisibility } from './visibility.ts';

/** Where an option leads, or why it leads nowhere on this board. */
type GateOutcomeLane = { readonly ok: true; readonly lane: Lane } | { readonly ok: false; readonly message: string };

/**
 * WHICH LANES ARE GATES, and where each option goes: the workflow model's answer. A port, so the gate items read
 * the one model and a test can name its own gates.
 */
export interface GateLanes {
  /** The lane's gate options in gate order; empty when its stage is automatic. */
  options(lane: Lane): readonly CardGateOption[];
  /** The lane the option sends a card of this workflow to. */
  outcomeLane(laneSet: LaneSet, workflow: Workflow, laneId: string, optionId: string): GateOutcomeLane;
}

/** An option as the ask carries it: the outcome by its kind alone (`CardGateOption`). */
const gateOption = (option: GateOption): CardGateOption => ({
  id: option.id,
  label: option.label,
  outcome: option.outcome.kind,
});

/** Why an option leads nowhere, in words. */
const outcomeProblem = (error: GateOutcomeError): string => {
  switch (error.code) {
    case 'not-a-gate':
      return `${error.laneId} does not wait on the owner any more`;
    case 'unknown-option':
      return `${error.laneId} has no option ${error.optionId} any more`;
    case 'no-next-lane':
      return `${error.laneId} has no lane after it`;
    default:
      return 'that lane is not on this board any more';
  }
};

/** The gates as each lane's stage declares them (`laneStage`, `gateOptions`, `gateOutcomeLane`). */
export const stageGateLanes: GateLanes = {
  options: lane => gateOptions(lane).map(gateOption),
  outcomeLane: (laneSet, workflow, laneId, optionId) => {
    const target = gateOutcomeLane(laneSet, workflow, laneId, optionId);
    return target.ok ? { ok: true, lane: target.value.lane } : { ok: false, message: outcomeProblem(target.error) };
  },
};

/**
 * The history `seq` of the event that put the card in the lane it is in now: its creation, a move, a reopen or a
 * refile there. `undefined` when its history says nothing of that lane (a card whose lane was renamed under it).
 */
export const gateEntry = (card: Pick<Card, 'history' | 'laneId'>): number | undefined => {
  for (let index = card.history.length - 1; index >= 0; index -= 1) {
    const event = card.history[index];
    if (event === undefined) continue;
    const landed =
      event.type === 'created'
        ? event.laneId
        : event.type === 'moved' || event.type === 'reopened'
          ? event.to
          : event.type === 'refiled'
            ? event.toLane
            : undefined;
    if (landed === undefined) continue;
    return landed === card.laneId ? event.seq : undefined;
  }
  return undefined;
};

/** A card as the gates read it: the card, its board's lanes and name, and who asked for it. */
export interface GateCard {
  readonly task: Card;
  readonly laneSet: LaneSet | null;
  readonly audience: CardAudience;
  readonly projectName?: string;
  /** The dependencies still holding the card back, as the board computes them (`blockedBy`); absent reads as none. */
  readonly blockedBy?: readonly CardRef[];
  /** Its live sub-cards still being built (a backlog, active or review lane); absent reads as none. */
  readonly building?: number;
}

/**
 * The gate the card waits at NOW, or `undefined`: an external card, not dropped, in a lane whose stage is a gate,
 * with the history entry that put it there. An internal card never waits on the owner (its lead passes its gate),
 * and a sub-card never waits at a lane the owner tries things in (the parent carries the test).
 */
export const gateOf = (card: GateCard, lanes: GateLanes): CardGate | undefined => {
  const { task, laneSet } = card;
  if (card.audience !== 'external' || task.dropped !== null || laneSet === null) return undefined;
  const lane = laneOf(laneSet, task.laneId);
  if (!lane.ok) return undefined;
  // The owner tests the parent: a sub-card never asks them to try it.
  if (isSubCard(task) && lane.value.category === 'verify') return undefined;
  const options = lanes.options(lane.value);
  if (options.length === 0) return undefined;
  const entry = gateEntry(task);
  if (entry === undefined) return undefined;
  return {
    cardId: task.id,
    laneId: lane.value.id,
    laneName: lane.value.name,
    entry,
    projectId: task.projectId,
    ...(card.projectName === undefined ? {} : { projectName: card.projectName }),
    cardTitle: clipAtWord(task.title, MAX_ASK_TITLE_LENGTH),
    options: [...options],
  };
};

/** The ask the lane makes, in one line, in the lane's own words (`gateAskLine`): what the card is, never its first step. */
const gateSubject = (gate: CardGate, task: Pick<Card, 'title' | 'summary'>): string => {
  const said = task.summary.trim() === '' ? task.title : task.summary.trim();
  return clipAtWord(gateAskLine(gate, said).replaceAll(/\s+/gu, ' '), MAX_ASK_SUBJECT_LENGTH);
};

/**
 * EVERYTHING NEEDED TO TRY IT, written for someone cold (`tryItText`): the preview link first when the card has one, else
 * where to try it for real; the card's How to test as written; the shipped version and the PR. Never a cut-off copy: too
 * long for a body, the steps are a pointer to the card.
 */
export const howToTestOf = (
  task: Pick<Card, 'id' | 'howToTest' | 'links'>,
  gate: Pick<CardGate, 'options'>,
  product?: GuideProduct,
): string | undefined => {
  // An approval has nothing to try: its ask carries the card's own words (the plan) as written, when it has them.
  const steps = task.howToTest?.trim() ?? '';
  if (gateStyle(gate) === 'approval') {
    if (steps === '') return undefined;
    return steps.length <= MAX_ASK_BODY_LENGTH ? steps : pointerTo(task)(steps.length);
  }
  return tryItText(task, pointerTo(task), MAX_ASK_BODY_LENGTH, product);
};

const pointerTo = (task: Pick<Card, 'id'>) => (length: number) =>
  `How to test is ${length.toLocaleString('en-US')} characters, too long to show here (the most is ${MAX_ASK_BODY_LENGTH.toLocaleString('en-US')}). Open the card (${formatCardRef(task)}) for the full steps.`;

/**
 * The ask the daemon raises through Asks when a card enters a gate (source `card`, #1552): ONE obligation per entry into
 * the gate, named `gate:<card>:<lane>:<entry>`, so raising it again is the same ask. It carries the card's How to test as
 * its context and the gate's options in swipe order; answering it moves the card first, then marks the ask answered.
 */
export const cardAskDraft = (
  gate: CardGate,
  task: Pick<Card, 'id' | 'title' | 'summary' | 'howToTest' | 'links'>,
  ferret: string,
  product?: GuideProduct,
): AskDraft => {
  const where = gate.projectName === undefined ? gate.laneName : `${gate.laneName} on ${gate.projectName}`;
  const howToTest = howToTestOf(task, gate, product);
  const ref: CardAskRef = { card: task.id, lane: gate.laneId, entry: String(gate.entry) };
  return {
    source: 'card' as SourceKey,
    ref,
    entry: gateReference({ cardId: gate.cardId, laneId: gate.laneId, entry: gate.entry }) as EntryId,
    kind: 'choice',
    subject: gateSubject(gate, task),
    why: `${formatCardRef(task)} reached ${where}.`,
    howToResolve: CARD_ASK_HOW_TO_RESOLVE,
    ...(howToTest === undefined ? {} : { context: howToTest }),
    options: gateAskLabels(gate).map(label => ({ label })),
    raisedBy: { kind: 'daemon' },
    ferret,
    blocking: true,
  };
};

/** The reason a move from the Inbox is recorded with (the wire contract). */
export const gateMoveReason = (option: Pick<CardGateOption, 'label'>): string => `${option.label} (from the Inbox)`;

// ---------------------------------------------------------------------------------------------------
// Try it only when there is something to try (docs/agenda.md § Try it only when there is something to try)
// ---------------------------------------------------------------------------------------------------

/** What the daemon does at a try-it gate: ask, hold the ask back, or find nothing to try. */
export type TryItVerdict =
  /** Something to try: the ask is put on the agenda, as it always was. */
  | { readonly kind: 'ask' }
  /** Blocked: no ask yet, and the card stays where it is. The next look after it is unblocked asks. */
  | { readonly kind: 'wait'; readonly why: string }
  /** Nothing a person could try: the card closes with this reason, and nobody is asked. */
  | { readonly kind: 'nothing'; readonly why: string };

/**
 * A How to test that says there is nothing to try, as a CLOSED GRAMMAR: the whole text (trimmed, one sentence, an
 * optional final period) is a declaration ("Nothing to try", "No user-visible change", "Docs only" …), optionally
 * followed by a reason from a closed list ("docs only", "internal refactor", "unit suites pass" …) or by a second
 * declaration, the clauses joined by ":" ";" "," or " — ". A word outside the grammar (after / while / when / should /
 * in / on …), a second sentence, a list, a step: none of it is a no-test statement, so the owner is asked. Verbs are
 * never blacklisted — a text is accepted only when every word of it is spoken for. When in doubt it is not.
 */
const NO_TEST_DECLARATION =
  /^(?:nothing (?:to (?:try|test)|for (?:you|the owner) to (?:try|test))|no (?:(?:(?:pwa|app|cli|user[- ]facing|user[- ]visible|visible) )(?:behaviou?r )?|behaviou?r )change|docs only|tests only|docs and tests only)$/iu;
/** The closed list of reasons a declaration may carry. */
const NO_TEST_REASON =
  /^(?:docs only|tests only|docs and tests only|internal refactor|refactor only|ci only|unit suites pass|no user[- ]visible change)$/iu;
/** What joins the clauses: a colon, a semicolon, a comma or a dash set apart by spaces (never the hyphen inside a word). */
const NO_TEST_JOINER = /\s*(?:[:;,—–]|\s-\s)\s*/u;
/** A declaration, then at most two more clauses (a reason or another declaration). */
const NO_TEST_MAX_CLAUSES = 3;

const isNoTestClause = (clause: string): boolean => NO_TEST_DECLARATION.test(clause) || NO_TEST_REASON.test(clause);

/** Whether a How to test is absent or, as a whole, says there is nothing to try. Pure and total. */
export const saysNothingToTry = (howToTest: string | null | undefined): boolean => {
  const text = howToTest?.trim() ?? '';
  if (text === '') return true;
  const clauses = text
    .replace(/\.$/u, '')
    .split(NO_TEST_JOINER)
    .map(clause => clause.trim());
  const [first, ...rest] = clauses;
  return (
    first !== undefined &&
    clauses.length <= NO_TEST_MAX_CLAUSES &&
    NO_TEST_DECLARATION.test(first) &&
    rest.every(isNoTestClause)
  );
};

/** The card as the try-it verdict reads it: what it is, what it waits on, what its steps and its shipped PRs say. */
export type TryItFacts = Pick<
  Card,
  'ask' | 'askedBy' | 'parent' | 'visibility' | 'visibilitySource' | 'blocked' | 'howToTest' | 'links' | 'kind'
> & {
  readonly blockedBy?: readonly CardRef[] | undefined;
  /** Its live sub-cards still being built (a backlog, active or review lane); absent reads as none. */
  readonly building?: number | undefined;
};

/**
 * WHAT TO DO AT A TRY-IT GATE, in this order. The plan gate ("OK to build") is never touched: it asks.
 *
 * 1. **wait** — the card is blocked (an open dependency, or blocked by hand), or it is an UMBRELLA card whose sub-cards
 *    are still being built (a PR linked to the umbrella itself shipped, but the work it stands for has not): it is not
 *    ready to try, so nothing is asked and nothing closes. When that changes, the next look at the card decides again.
 * 2. **nothing** — it is a private card; or internal work (a chore: a refactor, a clean-up — nothing a person sees);
 *    or it has no How to test, or its How to test says there is nothing to try; or every merged PR it links changed
 *    only docs, design or tests, and there is at least one, each of a KNOWN kind. An unknown kind is treated as code.
 * 3. **ask** — anything else.
 *
 * Pure and total.
 */
export const tryItVerdict = (card: TryItFacts, gate: Pick<CardGate, 'options'>): TryItVerdict => {
  if (gateStyle(gate) !== 'try-it') return { kind: 'ask' };
  const holding = card.blockedBy?.length ?? 0;
  if (holding > 0) {
    return { kind: 'wait', why: `it waits on ${String(holding)} other ${holding === 1 ? 'card' : 'cards'}` };
  }
  if (card.blocked !== null && card.blocked !== undefined) {
    return { kind: 'wait', why: `it is blocked: ${card.blocked.reason}` };
  }
  const building = card.building ?? 0;
  if (building > 0) {
    return {
      kind: 'wait',
      why: `it is an umbrella card: ${String(building)} of its sub-cards ${building === 1 ? 'is' : 'are'} still being built`,
    };
  }
  if (cardVisibility(card) === 'private') return { kind: 'nothing', why: 'it is a private card' };
  if (card.kind === 'chore') return { kind: 'nothing', why: 'it is internal work, with nothing a person sees' };
  if ((card.howToTest?.trim() ?? '') === '') return { kind: 'nothing', why: 'it has no steps to try' };
  if (saysNothingToTry(card.howToTest)) return { kind: 'nothing', why: 'its steps say there is nothing to try' };
  const merged = card.links.prs.filter(pr => pr.state === 'merged');
  if (merged.length > 0 && merged.every(pr => pr.changes === 'docs-tests')) {
    return { kind: 'nothing', why: 'its PRs change only docs and tests' };
  }
  return { kind: 'ask' };
};

/** The reason the board records when the daemon closes a card with nothing to try. */
export const nothingToTryReason = (why: string): string => `${NOTHING_TO_TRY_PREFIX}${why}`;
