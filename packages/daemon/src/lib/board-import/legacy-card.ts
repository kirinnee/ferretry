import {
  type BoardActor,
  type BoardTask,
  type BoardTaskEvent,
  type BoardTaskId,
  BoardTaskSchema,
  type LaneSet,
  type PrLink,
  prUrlParts,
} from '@ferretry/protocol';
import type { TaskEntry } from '../tasks/task-snapshot.ts';
import { type BlockReading, readBlockReason } from './block-reason.ts';
import { laneForStatus, statusOfPhase } from './lane-for-status.ts';
import { type EventDraft, mapHistory } from './legacy-history.ts';

/** `<session>:<old id>`: where an imported card came from, and what an old `&F12` in that session resolves by. */
export const legacyRefOf = (sessionId: string, oldId: string): string => `${sessionId}:${oldId}`;

/** What the session's blocked tasks were waiting on, once cycles are refused. */
export interface SessionPlan {
  /** The old ids each task depends on: its own `dependsOn` plus the tasks its block reason named. */
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
  /** The subset of {@link dependencies} that came from reading a block reason, not from the old `dependsOn`. */
  readonly derived: ReadonlyMap<string, readonly string[]>;
  /** How each BLOCKED task's reason was read, after a dependency that would close a cycle became external. */
  readonly readings: ReadonlyMap<string, BlockReading>;
}

const closesCycle = (graph: ReadonlyMap<string, readonly string[]>, from: string, to: string): boolean => {
  const seen = new Set<string>();
  const stack = [to];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (next === from) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(graph.get(next) ?? []));
  }
  return false;
};

/** Reads every blocked task's reason against the session's other tasks, never closing a dependency cycle. */
export const planSession = (entries: readonly TaskEntry[]): SessionPlan => {
  const known = new Set(entries.map(entry => entry.task.id));
  const graph = new Map<string, string[]>(
    entries.map(entry => [entry.task.id, entry.task.dependsOn.filter(id => known.has(id) && id !== entry.task.id)]),
  );
  const derived = new Map<string, string[]>();
  const readings = new Map<string, BlockReading>();
  for (const { task } of entries) {
    if (task.status !== 'blocked') continue;
    const reading = readBlockReason(task.statusReason ?? '', task.id, known);
    if (reading.on !== 'tasks') {
      readings.set(task.id, reading);
      continue;
    }
    const added: string[] = [];
    for (const id of reading.ids) {
      if (closesCycle(graph, task.id, id) || graph.get(task.id)?.includes(id) === true) continue;
      graph.set(task.id, [...(graph.get(task.id) ?? []), id]);
      added.push(id);
    }
    const present = reading.ids.filter(id => graph.get(task.id)?.includes(id) === true);
    if (present.length === 0) readings.set(task.id, { on: 'external' });
    else readings.set(task.id, { on: 'tasks', ids: present });
    if (added.length > 0) derived.set(task.id, added);
  }
  return { dependencies: graph, derived, readings };
};

export interface CardInput {
  readonly sessionId: string;
  readonly entry: TaskEntry;
  readonly id: BoardTaskId;
  readonly machineId: string;
  readonly laneSet: LaneSet;
  readonly plan: SessionPlan;
  /** Every old id of the session → its card. */
  readonly cardOf: ReadonlyMap<string, BoardTaskId>;
  readonly actorOf: (raw: string | null) => BoardActor;
  /** The session the old assignee string names, if it names exactly one. */
  readonly assignee: string | null;
  /** Whether this card's block on the owner is carried by an agenda link instead of a flag. */
  readonly askLinked: boolean;
  readonly now: string;
}

export type CardBuild =
  | { readonly ok: true; readonly card: BoardTask }
  | { readonly ok: false; readonly detail: string };

const pullRequests = (urls: readonly string[]): { readonly prs: PrLink[]; readonly rest: string[] } => {
  const prs: PrLink[] = [];
  const rest: string[] = [];
  for (const url of urls) {
    const parts = prUrlParts(url);
    if (parts === null) rest.push(url);
    else if (!prs.some(pr => pr.url === url)) {
      prs.push({
        url,
        number: parts.number,
        repo: parts.repo,
        state: 'unknown',
        draft: false,
        checks: 'none',
        mergedAt: null,
        mergeSha: null,
        releasedIn: null,
        polledAt: null,
      });
    }
  }
  return { prs, rest };
};

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const droppedAt = (history: readonly BoardTaskEvent[], fallback: string): string =>
  history.findLast(event => event.type === 'dropped')?.at ?? fallback;

const blockedSince = (history: readonly BoardTaskEvent[], fallback: string): string =>
  history.findLast(event => event.type === 'blocked')?.at ?? fallback;

/**
 * One old task as a v2 card, or the reason it cannot be one. Total: it never throws, and a card is only returned
 * if it parses as a {@link BoardTask}, so nothing invalid reaches the store.
 */
export const buildCard = (input: CardInput): CardBuild => {
  const { entry, sessionId, laneSet, plan, now } = input;
  const { task } = entry;
  const status = task.status === 'blocked' ? statusOfPhase(task.phase) : task.status;
  const lane = laneForStatus(laneSet, {
    status,
    workflow: task.workflow,
    hasPullRequest: task.links.prs.length > 0,
  });
  const reading = plan.readings.get(task.id);
  const mapped = mapHistory({ task, laneSet, cardOf: input.cardOf, actorOf: input.actorOf }, entry.activity, lane.id);
  const daemon: BoardActor = { kind: 'daemon' };
  const extra: EventDraft[] = [];
  const dependsOn = unique(plan.dependencies.get(task.id) ?? []).flatMap(oldId => {
    const card = input.cardOf.get(oldId);
    return card === undefined ? [] : [{ task: { id: card }, until: 'shipped' as const }];
  });
  for (const oldId of plan.derived.get(task.id) ?? []) {
    const card = input.cardOf.get(oldId);
    if (card !== undefined)
      extra.push({ type: 'depended', at: now, actor: daemon, task: { id: card }, until: 'shipped' });
  }
  if (task.assignee !== null && input.assignee === null) {
    extra.push({
      type: 'note',
      at: now,
      actor: daemon,
      text: `Old assignee "${task.assignee}" is not a session; the card is owned by ${sessionId}.`,
    });
  }
  if (reading?.on === 'owner') {
    extra.push({
      type: 'note',
      at: now,
      actor: daemon,
      text: input.askLinked
        ? `Blocked on the owner: ${task.statusReason ?? ''} — carried by the linked agenda ask.`
        : `Blocked: ${task.statusReason ?? ''}`,
    });
  }
  const events = [
    ...mapped.events,
    ...extra.map((event, index) => ({ ...event, seq: mapped.events.length + index + 1 }) as BoardTaskEvent),
  ];
  events.push({
    type: 'migrated',
    seq: events.length + 1,
    at: now,
    actor: daemon,
    legacyRef: legacyRefOf(sessionId, task.id),
  });
  const { prs, rest } = pullRequests(task.links.prs);
  const blockedByFlag =
    task.status === 'blocked' && (reading?.on === 'external' || (reading?.on === 'owner' && !input.askLinked));
  const candidate = {
    v: 1,
    id: input.id,
    machineId: input.machineId,
    projectId: laneSet.projectId,
    laneId: lane.id,
    kind: task.kind,
    title: task.title,
    summary: '',
    ask: task.ask,
    clarifications: task.clarifications.map(clarification => ({
      text: clarification.text,
      source: clarification.source,
      at: clarification.at,
      by: input.actorOf(clarification.by),
    })),
    premise: '',
    context: '',
    terms: [],
    brief: task.description,
    owner: sessionId,
    assignee: task.assignee === null ? null : (input.assignee ?? sessionId),
    parent: null,
    dependsOn: dependsOn.filter(dependency => dependency.task.id !== input.id),
    blocked: blockedByFlag
      ? { on: 'external' as const, reason: task.statusReason ?? 'blocked', since: blockedSince(events, task.updatedAt) }
      : null,
    dropped:
      task.status === 'dropped'
        ? { reason: task.statusReason ?? 'dropped', at: droppedAt(events, task.updatedAt) }
        : null,
    workflow: task.workflow,
    links: {
      prs,
      branch: task.links.branch,
      commits: unique(task.links.commits),
      docs: unique([...task.links.docs, ...rest]),
    },
    files: unique(task.files),
    order: task.order,
    createdAt: task.createdAt,
    createdBy: input.actorOf(task.createdBy),
    history: events,
    legacyRef: legacyRefOf(sessionId, task.id),
  };
  const parsed = BoardTaskSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, card: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, detail: `${issue?.path.join('.') ?? ''} ${issue?.message ?? 'does not parse'}`.trim() };
};

/** The title of the card that holds a session's agenda items that named no work. */
export const UNTRIAGED_TITLE = 'Untriaged asks';

/** Whether a stored card is the "Untriaged asks" card of a session. */
export const isUntriagedCard = (card: BoardTask, sessionId: string): boolean =>
  card.owner === sessionId && card.title === UNTRIAGED_TITLE && card.createdBy.kind === 'daemon';

/** The card a session's agenda items that name no work are filed under, in the project's first backlog lane. */
export const untriagedCard = (input: {
  readonly sessionId: string;
  readonly id: BoardTaskId;
  readonly machineId: string;
  readonly laneSet: LaneSet;
  readonly now: string;
}): BoardTask => {
  const lane = laneForStatus(input.laneSet, { status: 'todo', workflow: 'quick', hasPullRequest: false });
  const daemon: BoardActor = { kind: 'daemon' };
  return {
    v: 1,
    id: input.id,
    machineId: input.machineId,
    projectId: input.laneSet.projectId,
    laneId: lane.id,
    kind: 'chore',
    title: UNTRIAGED_TITLE,
    summary: 'Open asks raised before agenda items named a card.',
    ask: { text: 'Agenda items this ferret raised before they belonged to a card.', source: 'board import' },
    clarifications: [],
    premise: '',
    context: '',
    terms: [],
    brief: '',
    owner: input.sessionId,
    assignee: null,
    parent: null,
    dependsOn: [],
    blocked: null,
    dropped: null,
    workflow: 'quick',
    links: { prs: [], branch: null, commits: [], docs: [] },
    files: [],
    order: null,
    createdAt: input.now,
    createdBy: daemon,
    history: [{ seq: 1, at: input.now, actor: daemon, type: 'created', laneId: lane.id }],
  };
};
