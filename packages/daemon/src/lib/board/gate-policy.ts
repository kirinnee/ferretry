/**
 * CARD ASKS — the pure half (docs/board.md § Cards show progress; their asks ride the agenda). When an owner-asked card
 * enters a lane whose stage is a gate, the daemon puts ONE card ask on the agenda that carries it; this file decides,
 * from the card and its lanes alone, whether a card is at a gate now, which entry put it there, what a new card agenda
 * says, and where the owner's answer sends the card. `GateItems` (`gate-items.ts`) does the reading and writing.
 */
import {
  type AgendaGate,
  type AgendaGateOption,
  type BoardTask,
  clipAtWord,
  formatTaskRef,
  cardAgendaReference,
  cardAskStage,
  isSubCard,
  type GateOption,
  type GateOutcomeError,
  gateOptions,
  gateOutcomeLane,
  type Lane,
  type LaneSet,
  laneOf,
  MAX_AGENDA_BODY_LENGTH,
  MAX_AGENDA_REASON_LENGTH,
  MAX_AGENDA_SUBJECT_LENGTH,
  MAX_AGENDA_TITLE_LENGTH,
  type TaskWorkflow,
} from '@ferretry/protocol';
import { CARD_AGENDA_HOW_TO_RESOLVE, type RaiseAgendaRequest } from '../agenda/state-machine.ts';
import type { CardAudience } from './authority.ts';

/** Where an option leads, or why it leads nowhere on this board. */
type GateOutcomeLane = { readonly ok: true; readonly lane: Lane } | { readonly ok: false; readonly message: string };

/**
 * WHICH LANES ARE GATES, and where each option goes: the workflow model's answer. A port, so the gate items read
 * the one model and a test can name its own gates.
 */
export interface GateLanes {
  /** The lane's gate options in gate order; empty when its stage is automatic. */
  options(lane: Lane): readonly AgendaGateOption[];
  /** The lane the option sends a card of this workflow to. */
  outcomeLane(laneSet: LaneSet, workflow: TaskWorkflow, laneId: string, optionId: string): GateOutcomeLane;
}

/** An option as the agenda item carries it: the outcome by its kind alone (`AgendaGateOption`). */
const agendaOption = (option: GateOption): AgendaGateOption => ({
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
  options: lane => gateOptions(lane).map(agendaOption),
  outcomeLane: (laneSet, workflow, laneId, optionId) => {
    const target = gateOutcomeLane(laneSet, workflow, laneId, optionId);
    return target.ok ? { ok: true, lane: target.value.lane } : { ok: false, message: outcomeProblem(target.error) };
  },
};

/**
 * The history `seq` of the event that put the card in the lane it is in now: its creation, a move, a reopen or a
 * refile there. `undefined` when its history says nothing of that lane (a card whose lane was renamed under it).
 */
export const gateEntry = (card: Pick<BoardTask, 'history' | 'laneId'>): number | undefined => {
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
  readonly task: BoardTask;
  readonly laneSet: LaneSet | null;
  readonly audience: CardAudience;
  readonly projectName?: string;
}

/**
 * The gate the card waits at NOW, or `undefined`: an external card, not dropped, in a lane whose stage is a gate,
 * with the history entry that put it there. An internal card never waits on the owner (its lead passes its gate),
 * and a sub-card never waits at a lane the owner tries things in (the parent carries the test).
 */
export const gateOf = (card: GateCard, lanes: GateLanes): AgendaGate | undefined => {
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
    cardTitle: clipAtWord(task.title, MAX_AGENDA_TITLE_LENGTH),
    options: [...options],
  };
};

/** The first line of a card text that says something, list markers and Markdown emphasis taken off. */
const firstLine = (text: string): string | undefined =>
  text
    .split('\n')
    .map(line =>
      line
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, '')
        .replaceAll(/[*_`#>]/gu, '')
        .trim(),
    )
    .find(line => line !== '' && !line.endsWith(':'));

const isTryIt = (gate: Pick<AgendaGate, 'options'>): boolean =>
  gate.options.some(option => option.outcome === 'reopen-with-agenda');

/** The ask the lane makes, in one line: "Try it: <the first step>" at a try-it gate, else "<option>? <summary>". */
const gateSubject = (gate: AgendaGate, task: Pick<BoardTask, 'title' | 'summary' | 'howToTest'>): string => {
  const said = task.summary.trim() === '' ? task.title : task.summary.trim();
  const line = isTryIt(gate)
    ? `Try it: ${firstLine(task.howToTest ?? '') ?? said}`
    : `${gate.options[0]?.label ?? gate.laneName}? ${said}`;
  return clipAtWord(line.replaceAll(/\s+/gu, ' '), MAX_AGENDA_SUBJECT_LENGTH);
};

/** One line per PR of the card that is still open, or `null` when none is. */
const openPullRequests = (task: Pick<BoardTask, 'links'>): string | null => {
  const open = task.links.prs.filter(pr => pr.state === 'open');
  return open.length === 0 ? null : open.map(pr => `A new PR is open for this card: ${pr.url}`).join('\n');
};

/** The card's How to test as written (Markdown keeps its lines), absent when it has none, and never a cut-off copy: too long for a body, it is a pointer to the card. */
export const howToTestOf = (task: Pick<BoardTask, 'id' | 'howToTest'>): string | undefined => {
  const steps = task.howToTest?.trim() ?? '';
  if (steps === '') return undefined;
  return steps.length <= MAX_AGENDA_BODY_LENGTH
    ? steps
    : `How to test is ${steps.length.toLocaleString('en-US')} characters, too long to show here (the most is ${MAX_AGENDA_BODY_LENGTH.toLocaleString('en-US')}). Open the card (${formatTaskRef(task)}) for the full steps.`;
};

/**
 * The agenda the daemon opens for a card that no open agenda carries yet (docs/agenda.md § Card asks): named after
 * the card, on its ferret's behalf (`card-agenda:<card>`), carrying the card's ask with its How to test. It asks
 * nothing of its own but a reply; the card ask's buttons are what move the card.
 */
export const cardAgendaRaise = (
  gate: AgendaGate,
  task: Pick<BoardTask, 'id' | 'title' | 'summary' | 'howToTest' | 'links'>,
  at: string,
): RaiseAgendaRequest => {
  const where = gate.projectName === undefined ? gate.laneName : `${gate.laneName} on ${gate.projectName}`;
  const summary = task.summary.trim();
  const howToTest = howToTestOf(task);
  return {
    source: 'task',
    sourceRef: cardAgendaReference(task.id),
    title: clipAtWord(task.title, MAX_AGENDA_TITLE_LENGTH),
    kind: 'reply',
    ask: { kind: 'open-question' },
    subject: gateSubject(gate, task),
    why: `${formatTaskRef(task)} reached ${where}.`,
    howToResolve: CARD_AGENDA_HOW_TO_RESOLVE,
    // A PR still open while the card waits: the card stays at the gate, so the owner is told to wait or say Not good.
    context: openPullRequests(task),
    ...(summary === '' ? {} : { premise: clipAtWord(summary, MAX_AGENDA_REASON_LENGTH) }),
    task: { id: task.id },
    stage: cardAskStage(gate),
    cardAsks: [{ gate, at, ...(howToTest === undefined ? {} : { howToTest }) }],
  };
};

/** The reason a move from the Inbox is recorded with (the wire contract). */
export const gateMoveReason = (option: Pick<AgendaGateOption, 'label'>): string => `${option.label} (from the Inbox)`;
