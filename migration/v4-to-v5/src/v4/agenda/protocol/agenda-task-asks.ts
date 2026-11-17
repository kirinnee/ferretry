// VENDORED from v4.291.5 (64fd8cbcc811e2341f1ab18be170d76106a44852) packages/protocol/src/lib/agenda-card-asks.ts, verbatim.
// The converter's own frozen v4 reader: never imported by the product. Do not edit; re-vendor instead.
/**
 * TASK ASKS — the pure facts both ends read off `AgendaItem.cardAsks` (docs/agenda.md § Task asks): which asks are
 * open, which one an older app is shown, which task an agenda carries, the stage an ask puts it in, and the
 * reference of the agenda the daemon opens for a task nobody's agenda carries yet. Total.
 */
import type { AgendaTaskAsk, AgendaGate, AgendaItem } from './agenda.ts';
import { gateReference, parseGateFollowupReference } from './agenda-gate.ts';
import type { AgendaStage } from './agenda-state.ts';
import type { TaskRef } from './board-refs.ts';

/** The prefix of the `sourceRef` of the agenda the daemon opens for a task: `card-agenda:<task>`. */
const TASK_AGENDA_REFERENCE_PREFIX = 'card-agenda:';
const TASK_ID = /^[BFIC][1-9][0-9]{0,8}$/u;

/** The `sourceRef` of the one agenda the daemon opens, on the task's ferret's behalf, for a task nobody's agenda carries. */
export const taskAgendaReference = (taskId: string): string => `${TASK_AGENDA_REFERENCE_PREFIX}${taskId}`;

/** The task a `card-agenda:` reference names, or `undefined` for any other reference. */
export const parseTaskAgendaReference = (sourceRef: string | null | undefined): string | undefined => {
  if (typeof sourceRef !== 'string' || !sourceRef.startsWith(TASK_AGENDA_REFERENCE_PREFIX)) return undefined;
  const taskId = sourceRef.slice(TASK_AGENDA_REFERENCE_PREFIX.length);
  return TASK_ID.test(taskId) ? taskId : undefined;
};

/** A task ask's stable name: its gate's reference, one per entry of the task into the lane. */
export const taskAskReference = (ask: Pick<AgendaTaskAsk, 'gate'>): string => gateReference(ask.gate);

/** Whether the owner has yet to answer this ask. */
export const isOpenTaskAsk = (ask: Pick<AgendaTaskAsk, 'answer'>): boolean => ask.answer === undefined;

/** An agenda's open task asks, oldest first. */
export const openTaskAsks = (item: { readonly cardAsks?: readonly AgendaTaskAsk[] | undefined }): AgendaTaskAsk[] =>
  (item.cardAsks ?? []).filter(isOpenTaskAsk);

/** Whether an agenda carries a task ask the owner has yet to answer: that makes it a blocker of its task. */
export const hasOpenTaskAsk = (item: { readonly cardAsks?: readonly Pick<AgendaTaskAsk, 'answer'>[] | undefined }) =>
  (item.cardAsks ?? []).some(isOpenTaskAsk);

/**
 * Whether an agenda asks the owner NOTHING BUT its task asks: its open asks are all there is to answer, so the push they
 * made when they were put is its whole signal and a stop never names it again. The task agenda the daemon opened is
 * that; a ferret's thread is, until its ferret asks it something NEW (its turn with the owner starts after the asks).
 */
export const asksOnlyTaskAsks = (
  item: Pick<AgendaItem, 'raisedBy' | 'sourceRef' | 'waitingSince'> & {
    readonly cardAsks?: readonly Pick<AgendaTaskAsk, 'answer' | 'at'>[] | undefined;
  },
): boolean => {
  const open = (item.cardAsks ?? []).filter(isOpenTaskAsk);
  if (open.length === 0) return false;
  if (item.raisedBy === 'daemon' && parseTaskAgendaReference(item.sourceRef) !== undefined) return true;
  return Date.parse(item.waitingSince) <= Math.max(...open.map(ask => Date.parse(ask.at)));
};

/** The task ask an app that predates task asks is shown (`gateAttached`): the first open one. */
export const mirroredTaskAsk = (item: {
  readonly cardAsks?: readonly AgendaTaskAsk[] | undefined;
}): AgendaTaskAsk | undefined => openTaskAsks(item)[0];

/** The task ask on this agenda with this reference, open or answered. */
export const taskAskOf = (
  item: { readonly cardAsks?: readonly AgendaTaskAsk[] | undefined },
  reference: string,
): AgendaTaskAsk | undefined => (item.cardAsks ?? []).find(ask => taskAskReference(ask) === reference);

/** What a task ask needs of the owner: a test to try (its gate can send the task back with words), else a plan to approve. */
export const taskAskStage = (gate: Pick<AgendaGate, 'options'>): Extract<AgendaStage, 'test' | 'plan'> =>
  gate.options.some(option => option.outcome === 'reopen-with-agenda') ? 'test' : 'plan';

/**
 * Whether an open agenda can carry a task's ask: a ferret's own item, or one the daemon raised on a ferret's behalf (the
 * task's own agenda, a Not good follow-up). Not a notice, a gate item from before task asks, nor an item that is
 * something else for the owner to do (an input, a confirmation, a copied plan, a task plan, a 2FA seed, a phone
 * approval, a sign-in rule). The ONE test the engine and the boot migration share.
 */
export const canCarryTaskAsk = (
  item: Pick<
    AgendaItem,
    | 'notice'
    | 'gate'
    | 'kind'
    | 'confirms'
    | 'copyPlan'
    | 'taskPlan'
    | 'twoFactorSeed'
    | 'phoneApproval'
    | 'signInRuleSuggestion'
    | 'signInRuleSuspended'
    | 'raisedBy'
    | 'source'
    | 'sourceRef'
  >,
): boolean =>
  item.notice !== true &&
  item.gate === undefined &&
  item.kind !== 'input' &&
  item.confirms === undefined &&
  item.copyPlan === undefined &&
  item.taskPlan === undefined &&
  item.twoFactorSeed === undefined &&
  item.phoneApproval === undefined &&
  item.signInRuleSuggestion === undefined &&
  item.signInRuleSuspended === undefined &&
  (item.raisedBy === 'agent' ||
    (item.raisedBy === 'daemon' &&
      item.source === 'task' &&
      (parseTaskAgendaReference(item.sourceRef) !== undefined ||
        parseGateFollowupReference(item.sourceRef) !== undefined)));

const sameTask = (ref: TaskRef, taskId: string, machineId: string | undefined): boolean =>
  ref.id === taskId && (ref.machineId === undefined || machineId === undefined || ref.machineId === machineId);

/**
 * Whether an agenda CARRIES a task: it is about the task (`task`), or it carries one of the task's asks. A notice
 * carries nothing: it is read, never answered.
 */
export const carriesTask = (
  item: Pick<AgendaItem, 'task' | 'cardAsks' | 'notice'> & { readonly relatedTasks?: readonly TaskRef[] | undefined },
  taskId: string,
  machineId?: string,
): boolean => {
  if (item.notice === true) return false;
  if (item.task !== undefined && item.task !== null && sameTask(item.task, taskId, machineId)) return true;
  // The tasks a merge brought in (`relatedTasks`, docs/agenda.md § Merge and split) ride the agenda too.
  if ((item.relatedTasks ?? []).some(ref => sameTask(ref, taskId, machineId))) return true;
  return (item.cardAsks ?? []).some(ask => ask.gate.cardId === taskId);
};
