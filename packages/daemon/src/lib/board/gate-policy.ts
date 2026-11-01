/**
 * GATES ASK THE OWNER — the pure half (docs/board.md § Gates ask the owner). When an owner-asked card enters a lane
 * whose stage is a gate, the daemon raises ONE agenda item for it; this file decides, from the card and its lanes
 * alone, whether a card is waiting at a gate now, which entry put it there, what the item says, and where the
 * owner's answer sends the card. `GateItems` (`gate-items.ts`) does the reading and writing around it.
 */
import {
  type AgendaCardAnswer,
  type AgendaGate,
  type AgendaGateOption,
  type BoardTask,
  clipAtWord,
  formatTaskRef,
  gateAnswers,
  gateAskOptions,
  gateReference,
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
 * with the history entry that put it there. An internal card never waits on the owner (its lead passes its gate).
 */
export const gateOf = (card: GateCard, lanes: GateLanes): AgendaGate | undefined => {
  const { task, laneSet } = card;
  if (card.audience !== 'external' || task.dropped !== null || laneSet === null) return undefined;
  const lane = laneOf(laneSet, task.laneId);
  if (!lane.ok) return undefined;
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

/** Markdown cut to `limit` characters with its lines kept, marked … when it was cut. */
const clipProse = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;

/** What the gate item is raised with (`RaiseAgendaRequest`, minus who raises it). */
export interface GateRaise {
  readonly source: 'task';
  readonly sourceRef: string;
  readonly title: string;
  readonly kind: 'choice';
  readonly subject: string;
  readonly why: string;
  readonly howToResolve: string;
  readonly context: null;
  readonly premise?: string;
  readonly body?: string;
  readonly ask: { readonly kind: 'multiple-choice'; readonly options: { readonly label: string }[] };
  readonly answers: AgendaCardAnswer[];
  readonly task: { readonly id: string };
  readonly gate: AgendaGate;
}

/**
 * The gate item for a card waiting at `gate`: the card's title, the lane's ask, and the gate's options as a choice
 * whose labels ARE the options, so an app that knows nothing of gates answers it by label.
 */
export const gateRaise = (
  gate: AgendaGate,
  task: Pick<BoardTask, 'id' | 'title' | 'summary' | 'howToTest'>,
): GateRaise => {
  const labels = gateAskOptions(gate).map(option => option.label);
  const where = gate.projectName === undefined ? gate.laneName : `${gate.laneName} on ${gate.projectName}`;
  const summary = task.summary.trim();
  const howToTest = task.howToTest?.trim() ?? '';
  return {
    source: 'task',
    sourceRef: gateReference(gate),
    title: clipAtWord(task.title, MAX_AGENDA_TITLE_LENGTH),
    kind: 'choice',
    subject: gateSubject(gate, task),
    why: `${formatTaskRef(task)} reached ${where}, which waits on you.`,
    howToResolve: `Choose ${labels.join(' or ')}; the card moves when you answer.`,
    context: null,
    ...(summary === '' ? {} : { premise: clipAtWord(summary, MAX_AGENDA_REASON_LENGTH) }),
    // The card's How to test, as written: Markdown keeps its lines. Never `steps`, which make a choice a mix.
    ...(howToTest === '' ? {} : { body: clipProse(howToTest, MAX_AGENDA_BODY_LENGTH) }),
    ask: { kind: 'multiple-choice', options: labels.map(label => ({ label })) },
    answers: gateAnswers(gate),
    task: { id: task.id },
    gate,
  };
};

/** The reason a move from the Inbox is recorded with (the wire contract). */
export const gateMoveReason = (option: Pick<AgendaGateOption, 'label'>): string => `${option.label} (from the Inbox)`;
