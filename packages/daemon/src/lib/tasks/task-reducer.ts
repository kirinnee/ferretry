import {
  ACTOR_AUTHORITY_SPLIT_SEMANTICS,
  MAX_TASK_CLARIFICATIONS,
  MAX_TASK_DEPENDENCIES,
  MAX_TASK_FILES,
  MAX_TASK_LINKS_PER_FIELD,
  TASK_SCHEMA_VERSION,
  TaskActionRequestSchema,
  TaskCreateRequestSchema,
  type Task,
  type TaskActionRequest,
  type TaskActivity,
  type TaskCreateRequestInput,
  type TaskId,
  type TaskLinkField,
  type TaskLinks,
} from '@ferretry/protocol';
import { TaskError } from './task-error.ts';
import { assertTaskCanDrop, assertTaskDag, replaceGraphTask } from './task-graph.ts';
import { allocateTaskId, canonicalTaskId } from './task-id.ts';
import type { TaskActor } from './task-policy.ts';
import {
  assertActorCanWriteSession,
  assertTaskPhaseTransition,
  isHumanActor,
  canActorVerifyTaskDone,
  taskPhaseFromStatus,
  taskPhaseMovesBackward,
  taskStatusFromPhase,
} from './task-policy.ts';
import type { TaskEntry, TaskSnapshot } from './task-snapshot.ts';
import { validateTaskEntry } from './task-snapshot.ts';

/** Everything a mutation needs that the caller must supply rather than the reducer discover. */
export interface TaskMutationContext {
  readonly actor: TaskActor;
  readonly sessionId: string;
  readonly at: string;
}

/** One applied mutation: the whole next board plus the entry the caller asked about. */
export interface TaskMutationOutcome {
  readonly snapshot: TaskSnapshot;
  readonly entry: TaskEntry;
}

type ActivityDraft = Pick<TaskActivity, 'type' | 'data'>;

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const parseFailure = (detail: string): TaskError => new TaskError('invalid', detail);

const snapshotTasks = (snapshot: TaskSnapshot): readonly Task[] => snapshot.tasks.map(entry => entry.task);

/** Finds an entry by any case of its id, or refuses with the code a caller can act on. */
export const requireTaskEntry = (snapshot: TaskSnapshot, id: string): TaskEntry => {
  const canonical = canonicalTaskId(id);
  const entry = canonical === null ? undefined : snapshot.tasks.find(candidate => candidate.task.id === canonical);
  if (entry === undefined) throw new TaskError('not-found', `unknown task ${id}`);
  return entry;
};

const emptyLinks = (): TaskLinks => ({ prs: [], branch: null, commits: [], docs: [] });

const LINK_LIST_FIELD: Readonly<Record<Exclude<TaskLinkField, 'branch'>, 'prs' | 'commits' | 'docs'>> = Object.freeze({
  pr: 'prs',
  commit: 'commits',
  doc: 'docs',
});

/** Adding a link is idempotent, capped, and never reorders the ones already recorded. */
export const applyLink = (links: TaskLinks, field: TaskLinkField, value: string): TaskLinks => {
  if (field === 'branch') return { ...links, branch: value };
  const key = LINK_LIST_FIELD[field];
  const current = links[key];
  if (current.includes(value)) return links;
  if (current.length >= MAX_TASK_LINKS_PER_FIELD) {
    throw new TaskError('too-long', `at most ${MAX_TASK_LINKS_PER_FIELD} ${key} may be linked`);
  }
  return { ...links, [key]: [...current, value] };
};

const nextActivitySeq = (activity: readonly TaskActivity[]): number => activity.length + 1;

/**
 * Stamps drafts into the record's history.
 *
 * The sequence comes from the history's **length**, not from its highest `seq`. kteam took the
 * maximum, so a history that lost a line — its appends were plain `appendFile`, which can be
 * interrupted mid-line — kept allocating past the gap and left the record permanently unreadable as
 * a gap-free log. Here the persisted snapshot is rejected unless the sequence is gap-free, so the
 * two rules cannot drift apart.
 */
const stampActivity = (
  drafts: readonly ActivityDraft[],
  activity: readonly TaskActivity[],
  context: TaskMutationContext,
): readonly TaskActivity[] => {
  const base = nextActivitySeq(activity);
  return drafts.map(
    (draft, index) =>
      ({
        v: TASK_SCHEMA_VERSION,
        seq: base + index,
        time: context.at,
        actor: context.actor.id,
        actorName: context.actor.name,
        type: draft.type,
        data: draft.data,
      }) as TaskActivity,
  );
};

const commit = (snapshot: TaskSnapshot, entry: TaskEntry, replace: boolean): TaskMutationOutcome => {
  const validated = validateTaskEntry(entry);
  const tasks = replace
    ? snapshot.tasks.map(candidate => (candidate.task.id === validated.task.id ? validated : candidate))
    : [...snapshot.tasks, validated];
  return { snapshot: { v: TASK_SCHEMA_VERSION, tasks }, entry: validated };
};

/**
 * Creates a task from a transport request.
 *
 * The request is parsed by the protocol schema first, so status/phase/workflow coherence is decided
 * in exactly one place. kteam validated the same coherence again inside the service with a second,
 * subtly different rule set; the two could disagree, and which one you hit depended on the entry
 * point. Here the schema is the only authority and the reducer adds only graph rules.
 */
export const createTask = (
  snapshot: TaskSnapshot,
  request: TaskCreateRequestInput,
  context: TaskMutationContext,
): TaskMutationOutcome => {
  assertActorCanWriteSession(context.actor, context.sessionId);
  const parsed = TaskCreateRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw parseFailure(`refusing an invalid task create request: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  const input = parsed.data;
  const phase = input.status === 'blocked' ? 'todo' : taskPhaseFromStatus(input.status);
  const statusReason = trimOrNull(input.statusReason);
  // The schema already caps both collections; de-duplicating can only shrink them, so no second
  // cap is needed here — a re-check would be a rule with no reachable case, free to drift.
  const dependsOn = [...new Set(input.dependsOn)];
  const files = [...new Set(input.files)];

  // An omitted assignee defaults to the owning session; an explicit `null` means deliberately
  // unassigned. Collapsing the two would make "nobody owns this yet" unexpressible.
  const assignee = request.assignee === undefined ? context.sessionId : input.assignee;
  const id = allocateTaskId(
    input.kind,
    snapshotTasks(snapshot).map(existing => existing.id),
  );
  const task: Task = {
    v: TASK_SCHEMA_VERSION,
    id,
    kind: input.kind,
    title: input.title,
    description: input.description,
    ask: input.ask,
    clarifications: [],
    workflow: input.workflow,
    phase,
    dependsOn,
    status: input.status,
    statusReason,
    assignee,
    repo: input.repo,
    files,
    links: { ...emptyLinks(), ...input.links },
    order: input.order,
    createdAt: context.at,
    createdBy: context.actor.id,
    updatedAt: context.at,
  };
  assertTaskDag([...snapshotTasks(snapshot), task]);

  const created: ActivityDraft = {
    type: 'created',
    data: {
      status: task.status,
      phase: task.phase,
      workflow: task.workflow,
      kind: task.kind,
      title: task.title,
      askSource: task.ask.source,
      dependsOn: [...dependsOn],
      ...(files.length > 0 ? { files: [...files] } : {}),
      reason: statusReason ?? 'Task created.',
      ...(task.assignee !== null ? { assignee: task.assignee } : {}),
    },
  };
  return commit(snapshot, { task, activity: stampActivity([created], [], context) }, false);
};

interface PhaseMove {
  readonly next: Task;
  readonly draft: ActivityDraft;
}

/**
 * The single phase-move rule every status-shaped action funnels through.
 *
 * The reason is persisted onto the record for **every** move. kteam only kept it for backward and
 * dropped moves and wrote `null` otherwise, so "why is this built?" was answerable from history but
 * not from the record the board actually renders — a reason accepted and then thrown away.
 *
 * WHO acted and WHAT authorized it are two facts, and this is where they stop being one. An earlier
 * build folded a shared-board `mark_done` grant into the human predicate, so a granted agent's
 * completion was journalled as `verifiedByHuman` and its research/design advance as
 * `approvedByHuman`. Records written before that split therefore cannot distinguish a human sign-off
 * from a granted agent's, and nothing here reclassifies them: a flag guessed after the fact is the
 * same defect wearing a correction. Read `verifiedByTopAgent`'s ABSENCE on an old record as unknown
 * rather than as "a human did it", and use the entry's `actor` — which was always honest — to tell
 * the two apart.
 */
const movePhase = (
  graph: readonly Task[],
  current: Task,
  draftTask: Task,
  to: Task['phase'],
  reason: string,
  options: { readonly note?: string; readonly reopen: boolean },
  context: TaskMutationContext,
): PhaseMove => {
  const human = isHumanActor(context.actor);
  const verifiesDone = canActorVerifyTaskDone(context.actor);
  const clearingManualBlock = current.status === 'blocked' && to === current.phase;
  if (!clearingManualBlock) {
    assertTaskPhaseTransition(current, to, { human, verifiesDone, reopen: options.reopen });
  }
  if (to === 'dropped') assertTaskCanDrop(graph, current.id);
  const backward = !clearingManualBlock && taskPhaseMovesBackward(current, to);
  const reopeningShipped = backward && (current.phase === 'live' || current.phase === 'done');
  const status = taskStatusFromPhase(to);
  const next: Task = { ...draftTask, phase: to, status, statusReason: reason };
  const approvedByHuman = !backward && (current.phase === 'research' || current.phase === 'design') && human;
  // Completion is recorded as WHO signed it off, positively on both branches. A board grant is what
  // let a non-human reach this move, so the record carries its own flag AND the grant it was made
  // under — never the human flag, and never the mere absence of one, which a reader cannot tell
  // apart from a record written before this distinction existed.
  const completedLive = current.phase === 'live' && to === 'done';
  const verifiedByHuman = completedLive && human;
  const grant = human ? undefined : context.actor.markDoneAuthorization;
  const verifiedByTopAgent = completedLive && grant !== undefined;
  // Every attestation this code writes says so, POSITIVELY. A reader must not have to decide from a
  // clock whether the writer drew the identity/authority distinction: the instant this reaches any
  // one daemon is unknowable here, and an un-upgraded host goes on writing conflated records long
  // past any date chosen in advance. Absence of this stamp is what marks a record unreliable, so a
  // writer that never learned the distinction cannot accidentally inherit trust.
  const attests = approvedByHuman || verifiedByHuman || verifiedByTopAgent;
  return {
    next,
    draft: {
      type: 'status',
      data: {
        from: current.status,
        to: status,
        phaseFrom: current.phase,
        phaseTo: to,
        reason,
        ...(options.note !== undefined ? { note: options.note } : {}),
        ...(backward ? { backward: true } : {}),
        ...(reopeningShipped ? { reopened: true } : {}),
        ...(approvedByHuman ? { approvedByHuman: true } : {}),
        ...(verifiedByHuman ? { verifiedByHuman: true } : {}),
        ...(verifiedByTopAgent ? { verifiedByTopAgent: true, authorization: grant } : {}),
        ...(attests ? { attestationSemantics: ACTOR_AUTHORITY_SPLIT_SEMANTICS } : {}),
      },
    },
  };
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one exhaustive switch over the action union reads better than eleven indirections.
const reduceAction = (
  graph: readonly Task[],
  current: Task,
  action: TaskActionRequest,
  context: TaskMutationContext,
): { readonly next: Task; readonly drafts: readonly ActivityDraft[] } => {
  let next: Task = {
    ...current,
    links: { ...current.links },
    dependsOn: [...current.dependsOn],
    files: [...current.files],
  };
  const before: ActivityDraft[] = [];

  const appendClarification = (text: string, source: string): ActivityDraft => {
    if (next.clarifications.length >= MAX_TASK_CLARIFICATIONS) {
      throw new TaskError('too-long', `${current.id} already holds ${MAX_TASK_CLARIFICATIONS} clarifications`);
    }
    next = {
      ...next,
      clarifications: [
        ...next.clarifications,
        { text, source, at: context.at, by: context.actor.id, byName: context.actor.name },
      ],
    };
    return { type: 'clarification', data: { text, source } };
  };

  switch (action.action) {
    case 'status': {
      if (action.status === 'blocked') {
        next = { ...next, status: 'blocked', statusReason: action.reason };
        return {
          next,
          drafts: [
            {
              type: 'status',
              data: {
                from: current.status,
                to: 'blocked' as const,
                phaseFrom: current.phase,
                phaseTo: current.phase,
                reason: action.reason,
                ...(action.note !== undefined ? { note: action.note } : {}),
              },
            },
          ],
        };
      }
      const moved = movePhase(
        graph,
        current,
        next,
        taskPhaseFromStatus(action.status),
        action.reason,
        { ...(action.note !== undefined ? { note: action.note } : {}), reopen: false },
        context,
      );
      return { next: moved.next, drafts: [moved.draft] };
    }
    case 'phase': {
      const moved = movePhase(graph, current, next, action.phase, action.reason, { reopen: false }, context);
      return { next: moved.next, drafts: [moved.draft] };
    }
    case 'reopen': {
      if (current.phase !== 'built' && current.phase !== 'live' && current.phase !== 'done') {
        throw new TaskError('transition', `${current.id} can be reopened only from built, live, or done`);
      }
      before.push(appendClarification(action.ask, action.source));
      const moved = movePhase(graph, current, next, 'build', action.reason, { reopen: true }, context);
      return { next: moved.next, drafts: [...before, moved.draft] };
    }
    case 'note':
    case 'feedback':
      return { next, drafts: [{ type: action.action, data: { text: action.text } }] };
    case 'clarify': {
      // The draft must be built first: `appendClarification` rebinds `next`, and an object literal
      // would otherwise capture the pre-append value.
      const draft = appendClarification(action.text, action.source);
      return { next, drafts: [draft] };
    }
    case 'dependency': {
      const dependency: TaskId = action.taskId;
      if (dependency === current.id) throw new TaskError('cycle', `${current.id} cannot depend on itself`);
      const remove = action.remove === true;
      const exists = next.dependsOn.includes(dependency);
      if (remove && !exists) throw new TaskError('invalid', `${current.id} does not depend on ${dependency}`);
      if (!remove && exists) throw new TaskError('invalid', `${current.id} already depends on ${dependency}`);
      if (!remove && next.dependsOn.length >= MAX_TASK_DEPENDENCIES) {
        throw new TaskError('too-long', `${current.id} already declares ${MAX_TASK_DEPENDENCIES} dependencies`);
      }
      next = {
        ...next,
        dependsOn: remove
          ? next.dependsOn.filter(candidate => candidate !== dependency)
          : [...next.dependsOn, dependency],
      };
      assertTaskDag(replaceGraphTask(graph, next));
      return {
        next,
        drafts: [{ type: 'dependency', data: { taskId: dependency, operation: remove ? 'remove' : 'add' } }],
      };
    }
    case 'file': {
      // Advisory: a claim documents intent so two agents can see an overlap. It is never arbitrated
      // here and never blocks anyone's write — that is what makes it safe to record eagerly.
      const remove = action.remove === true;
      const exists = next.files.includes(action.path);
      if (remove && !exists) throw new TaskError('invalid', `${current.id} does not claim ${action.path}`);
      if (!remove && exists) throw new TaskError('invalid', `${current.id} already claims ${action.path}`);
      if (!remove && next.files.length >= MAX_TASK_FILES) {
        throw new TaskError('too-long', `${current.id} already claims ${MAX_TASK_FILES} files`);
      }
      next = {
        ...next,
        files: remove ? next.files.filter(candidate => candidate !== action.path) : [...next.files, action.path],
      };
      return {
        next,
        drafts: [
          {
            type: 'file',
            data: {
              path: action.path,
              operation: remove ? ('remove' as const) : ('add' as const),
              ...(action.reason !== undefined ? { reason: action.reason } : {}),
            },
          },
        ],
      };
    }
    case 'link':
      next = { ...next, links: applyLink(next.links, action.field, action.value) };
      return { next, drafts: [{ type: 'link', data: { field: action.field, value: action.value } }] };
    case 'assign': {
      const assignee = trimOrNull(action.assignee);
      next = { ...next, assignee };
      return { next, drafts: [{ type: 'assign', data: { from: current.assignee, to: assignee } }] };
    }
    case 'order':
      next = { ...next, order: action.order };
      return { next, drafts: [{ type: 'order', data: { from: current.order, to: action.order } }] };
  }
};

/**
 * Applies one action to one task and returns the whole next board.
 *
 * Record and history move together in a single value, so a caller cannot commit the mutation and
 * lose the entry that explains it — in kteam those were two writes to two files.
 */
export const applyTaskAction = (
  snapshot: TaskSnapshot,
  id: string,
  action: TaskActionRequest,
  context: TaskMutationContext,
): TaskMutationOutcome => {
  assertActorCanWriteSession(context.actor, context.sessionId);
  const parsed = TaskActionRequestSchema.safeParse(action);
  if (!parsed.success) {
    throw parseFailure(`refusing an invalid task action: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  const entry = requireTaskEntry(snapshot, id);
  const graph = snapshotTasks(snapshot);
  const reduced = reduceAction(graph, entry.task, parsed.data, context);
  const activity = [...entry.activity, ...stampActivity(reduced.drafts, entry.activity, context)];
  return commit(snapshot, { task: { ...reduced.next, updatedAt: context.at }, activity }, true);
};
