/**
 * THE BOARD SERVICE: every read and write of the project boards (`board-design.md` §2), over injected
 * ports and nothing else.
 *
 * A write is one card's read-decide-write inside that card's serial section ({@link BoardStore.write}).
 * Dependency writes are also serialized board-wide, because a cycle can be closed by two writes to two
 * different cards at once and only one of them may see the graph without the other's edge.
 *
 * What happens AFTER a write commits — the session's focus, the reopen delivery, the `board.changed`
 * event — can no longer undo it, so a failure there is reported to {@link BoardDiagnostics} and the
 * caller still gets the card it changed.
 */
import {
  ADMIN_TOKEN_ACTOR_WORDS,
  type TaskActor,
  type BoardEditableField,
  BoardEditableFieldSchema,
  type BoardIdsResponse,
  type BoardMergeGateResponse,
  type AskRef,
  type BoardProjectId,
  type BoardQuery,
  type BoardReopenAttachments,
  type BoardResponse,
  type BoardSkipRequest,
  type BoardSkipResponse,
  type Task,
  type TaskActionRequest,
  type TaskCreateRequest,
  type TaskId,
  type TaskResponse,
  CardSchema,
  type TaskView,
  categoryOf,
  formatTaskRef,
  type Lane,
  type LaneSet,
  type LaneTrigger,
  type TaskKind,
  type TaskRef,
  UNFILED_PROJECT_ID,
} from '../../../contract/index.ts';
import { describeRelocationProblem, relocationProblems } from '../lanes/lane-set-policy.ts';
import type { RelocationAuthority } from '../lanes/ports.ts';
import { helperRefusal, NO_HELPERS, type HelperDirectory } from './helper-limits.ts';
import { presenceOf, type FerretLivenessGuard, type FerretRoster } from './activity.ts';
import {
  type BoardCaller,
  type BoardStanding,
  type TaskAudience,
  claimableFrom,
  effectiveAssignee,
  mayDo,
  mayHandDown,
  standingOf,
} from './authority.ts';
import {
  applyAction,
  type TaskContext,
  type TaskOutcome,
  closeAsDaemon,
  closeNothingToTry,
  newTask,
  requireLocalTask,
  requireStanding,
  triggerMove,
  withEvent,
} from './task-actions.ts';
import { queueBehindClashes } from './clash-queue.ts';
import { deriveView, gatherDerivation, neighbourhoodOf } from './derive.ts';
import { mergeGateOf } from './merge-gate.ts';
import { BoardError, BoardUnavailableError } from './errors.ts';
import { gateEntry, nothingToTryReason, stageGateLanes, tryItVerdict } from './gate-policy.ts';
import { BoardIndex, blockedBy, taskCategory, type LaneSets, stillBuilding } from './graph.ts';
import { ancestorsOf } from './lineage.ts';
import { approvalProblem, taskLicence, offBoardRefusal } from './opt-in.ts';
import { taskAudience, decideAskedBy } from './origin.ts';
import type {
  ActivityDeriver,
  TaskAskLinkSource,
  BoardAttachmentSource,
  BoardChangeSink,
  BoardClock,
  BoardDiagnostics,
  BoardOptIn,
  BoardSnapshot,
  BoardStore,
  BoardThreads,
  BoardWrite,
  DoneNotice,
  DoneNotifier,
  LaneSetSource,
  OwnerWords,
  ProjectAdopter,
  ReopenNotifier,
  FerretFocus,
  FerretNames,
  FerretParents,
} from './ports.ts';
import { applyPrUpdate, type PrUpdate, type PrUpdateOutcome } from './pr-cache.ts';
import { compareViews, countsOf, inScope, isOpenOnBoard, pageOf, passesFilters } from './query.ts';
import { returnTask, returnLead } from './return-to-lead.ts';
import { doneLane, doneMove, doneNote } from './signal-done.ts';
import { helperCloseReason } from './sub-task-close.ts';
import { defaultVisibility, visibilityVerdict } from './visibility.ts';
import { ASK_REFERENCE_SIGIL } from '@ferretry/core-asks/contract';

/** Runs work one at a time per key; work under different keys runs together (the kernel's keyed serial). */
interface BoardSerial {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
}

export interface BoardServiceDependencies {
  readonly store: BoardStore;
  readonly lanes: LaneSetSource;
  readonly parents: FerretParents;
  /** The name a ferret's act is recorded by (`CardActor`), looked up once per act. */
  readonly names: FerretNames;
  readonly focus: FerretFocus;
  readonly reopen: ReopenNotifier;
  /** Tells a card's ferret the owner marked it done. */
  readonly done: DoneNotifier;
  readonly activity: ActivityDeriver;
  /**
   * Which sessions are alive, so a live lead may ADOPT a card whose owner ferret and assignee have both ended (docs/board.md
   * § An orphaned card is adopted). The adoption is judged INSIDE a hold on the sessions it rests on (the owner ferret, the
   * assignee and the adopter), against a roster read after the hold was taken, so none of them can end or resume
   * between that read and the card landing on disk. Absent, nothing can be shown to be orphaned and every adoption is refused.
   */
  readonly liveness?: FerretLivenessGuard;
  readonly asks: TaskAskLinkSource;
  readonly changes: BoardChangeSink;
  readonly clock: BoardClock;
  readonly diagnostics: BoardDiagnostics;
  /** This daemon's id, once its identity is open; a write before then is refused as unavailable. */
  readonly machineId: () => string | undefined;
  /** The release this daemon runs when it reads as one; a card whose PR shipped in it is running here. */
  readonly runningVersion?: () => string | null;
  /** The board-wide section dependency writes share. */
  readonly serial: BoardSerial;
  /** Moves a ferret on the Unfiled board onto the board of the repository it stands in, at its first card. */
  readonly adoption?: ProjectAdopter;
  /** Who started whom: a helper may only note and link PRs on its own card. Absent, every caller is a lead. */
  readonly helpers?: HelperDirectory;
  /** The attachment store, for a move back that carries files. Absent, such a move is refused. */
  readonly attachments?: BoardAttachmentSource;
  /** What the owner said to a session, for deciding whether a card's ask is theirs. Absent, no ask matches. */
  readonly ownerWords?: OwnerWords;
  /**
   * The board is opt-in (`opt-in.ts`): whether a ferret may make a card where its board is off. Absent, every
   * board reads as on, as it did before the switch.
   */
  readonly optIn?: BoardOptIn;
  /** The caller's open agenda threads a card may be made for (`--thread`). Absent, a card naming one is refused. */
  readonly threads?: BoardThreads;
  /**
   * Told after every committed write of a card, by any path (docs/board.md § Cards show progress): the gate items
   * follow the card's lane from here. Total in spirit: a failure is a diagnostic, never the write's.
   */
  readonly gates?: TaskWriteObserver;
  /**
   * `card.moving` (the decide hook Board offers): asked inside the write of EVERY lane change, whatever made it — an
   * act, a gate answer, a trigger, the watcher, a refile, the sweep, a close — so a no leaves the card where it is.
   * Absent, every move is allowed.
   */
  readonly moving?: (
    input: TaskMoveInput,
  ) => Promise<{ readonly allow: true } | { readonly allow: false; readonly reason: string }>;
  /** Told once a lane change landed (`board.card-moved`). Total in spirit: never fails the write. */
  readonly moved?: (input: Omit<TaskMoveInput, 'by'>) => void;
}

/** One lane change, as `card.moving` is asked about it: the card, the lanes and who moves it. */
export interface TaskMoveInput {
  readonly card: TaskId;
  readonly from: string;
  readonly to: string;
  readonly by: TaskActor;
}

/** What follows a card's lane after each write: the gate items (`GateItems`). */
/** Who held a card when a start judged it: what the assignment write must still find, or nothing is assigned. */
export interface TaskHolders {
  readonly owner: string;
  readonly assignee: string | null;
}

/**
 * The standing of the sessions an adoption rests on, held still while its card is written: `fresh` is their roster read
 * after the hold was taken, and `held` names them (the card's owner ferret, its assignee and the adopter).
 */
interface AdoptionHold {
  readonly fresh: FerretRoster;
  readonly held: readonly string[];
}

export interface TaskWriteObserver {
  written(id: TaskId): Promise<void>;
}

/** What `fy signal done` did to the ferret's focus card. */
export interface SignalDoneOutcome {
  /** The card as written: the note, and the move when there was one. */
  readonly task: Task;
  /** The lane it moved to; `null` when it stayed. */
  readonly moved: Lane | null;
  /** Why a move the rule called for was refused (an owner gate, a blocker); the note was kept. */
  readonly held?: string;
}

/** The serial key every dependency write shares. */
export const DEPENDENCY_SECTION = 'board:dependencies';

/** The line a reopened card's ferret is told (§2.9): a plain sentence, with no tag around it. */
export const reopenMessage = (task: Pick<Task, 'id'>, by: TaskActor, reason: string): string =>
  `${formatTaskRef(task)} was reopened by ${reopenerWords(by)}: ${reason}`;

const reopenerWords = (by: TaskActor): string => {
  if (by.kind === 'owner') return by.via === 'admin-token' ? ADMIN_TOKEN_ACTOR_WORDS : 'the owner';
  return by.kind === 'ferret' ? by.name : 'the daemon';
};

/**
 * The line a card's ferret is told the owner closed it: a plain sentence, with no tag around it. A batch
 * (one ferret's cards closed together) lists them.
 */
export const doneMessage = (tasks: readonly Pick<Task, 'id' | 'title'>[], by: DoneNotice['by'] = 'owner'): string => {
  const named = tasks.map(task => `${formatTaskRef(task)} “${task.title}”`);
  const who = by === 'owner' ? 'The owner' : `The${ADMIN_TOKEN_ACTOR_WORDS.slice('the'.length)}`;
  return named.length === 1
    ? `${who} marked ${named[0]} done.`
    : `${who} marked these tasks done: ${named.join(', ')}.`;
};

/** Who a relocation is recorded as: the owner (with how they acted), or the daemon. */
const callerOf = (by: RelocationAuthority): BoardCaller =>
  by.kind === 'owner'
    ? by.via === undefined
      ? { kind: 'owner' }
      : { kind: 'owner', via: by.via }
    : { kind: 'daemon' };

/**
 * The board actor a caller is recorded as: the owner (with `via: 'admin-token'` for the host's token with no
 * ferret's credential, so no surface shows it as the owner), a ferret by the name Ferrets knows it by now, or
 * the daemon, with the ferret whose session caused the act when the act carried one.
 */
export const actorOf = async (caller: BoardCaller, names: FerretNames): Promise<TaskActor> => {
  if (caller.kind === 'owner')
    return caller.via === 'admin-token' ? { kind: 'owner', via: 'admin-token' } : { kind: 'owner' };
  if (caller.kind === 'ferret')
    return { kind: 'ferret', name: await names.nameOf(caller.ferret), ferret: caller.ferret };
  return caller.ferret === undefined ? { kind: 'daemon' } : { kind: 'daemon', ferret: caller.ferret };
};

const ferretOf = (caller: BoardCaller): string | undefined => (caller.kind === 'owner' ? undefined : caller.ferret);

/** Refuses to store a card the protocol would refuse to read back: sizes, counts, coherence. */
const requireValidTask = (task: Task): Task => {
  const parsed = CardSchema.safeParse(task);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
  throw new BoardError(
    'invalid',
    `that would leave ${formatTaskRef(task)} invalid (${where}${issue?.message ?? 'unknown problem'})`,
  );
};

/**
 * What a helper may still write: a note on its own card, a PR or branch link, so the PR's facts move the
 * card on their own, and an external trigger it saw happen (a deploy) on the card it is doing, so the card
 * moves as a fact would move it. Authority still decides WHICH card; everything else is its lead's to do.
 */
const subFerretMay = (request: TaskActionRequest): boolean =>
  request.action === 'note' ||
  request.action === 'claim' ||
  request.action === 'trigger' ||
  (request.action === 'link' && (request.pr !== undefined || request.branch !== undefined));

/** The fields a helper may write on a card it holds: where the work stands and how the owner checks it. */
const HOLDER_FIELDS: readonly BoardEditableField[] = ['progress', 'howToTest'];

/**
 * An edit that names only the card's status and/or How to test (and at least one of them): the one edit a helper
 * may make, on a card it holds. Any other field, or a visibility, in the same edit makes it the lead's alone.
 */
const isHolderFieldEdit = (request: TaskActionRequest): boolean =>
  request.action === 'edit' &&
  request.visibility === undefined &&
  BoardEditableFieldSchema.options.every(field => HOLDER_FIELDS.includes(field) || request[field] === undefined) &&
  HOLDER_FIELDS.some(field => request[field] !== undefined);

/**
 * What a helper may do on a card it HOLDS (its assignee, else its owner) and no other: move it, change its focus to
 * it, claim or release the files it will touch (docs/design/clash-queue.md), link a commit or doc to it, set its status and How to test (an edit that names ONLY those: any other field is refused whole). Judged in {@link BoardService.decide}, where the card is in hand; claiming a card its
 * lead holds is what makes it the holder, so these are also the only refusals that point at `claim`.
 */
const holderOnly = (request: TaskActionRequest): boolean =>
  request.action === 'move' ||
  request.action === 'file' ||
  request.action === 'focus' ||
  isHolderFieldEdit(request) ||
  (request.action === 'link' && request.pr === undefined && request.branch === undefined);

const SUB_FERRET_DOING: Readonly<Record<TaskActionRequest['action'], string>> = {
  move: 'move tasks',
  focus: 'change which task they work on',
  block: 'block tasks',
  unblock: 'unblock tasks',
  depend: 'add dependencies to tasks',
  undepend: 'remove dependencies from tasks',
  drop: 'drop a task outside your own subtree',
  reopen: 'reopen tasks',
  clarify: 'clarify tasks',
  link: 'link a commit or doc to tasks',
  assign: 'reassign a task outside your own subtree',
  claim: 'claim tasks',
  adopt: 'adopt tasks',
  note: 'note on tasks',
  edit: 'edit tasks',
  file: 'claim files on tasks',
  order: 'reorder tasks',
  reparent: 'move tasks under another task',
  refile: 'refile tasks',
  snooze: 'snooze tasks',
  visibility: 'make tasks public or private',
  trigger: 'report events on tasks',
};

const subFerretDoing = (request: TaskActionRequest): string => SUB_FERRET_DOING[request.action];

export class BoardService {
  constructor(private readonly ports: BoardServiceDependencies) {}

  /**
   * THE one write of a card: the store's read-decide-write, with `card.moving` asked of any lane change inside it (a
   * no refuses the write in words, nothing stored) and `board.card-moved` told once it landed.
   */
  private async write<T>(id: TaskId, decide: (current: Task | undefined) => Promise<BoardWrite<T>>): Promise<T> {
    let landed: Omit<TaskMoveInput, 'by'> | undefined;
    const result = await this.ports.store.write(id, async current => {
      const decision = await decide(current);
      const next = decision.task;
      landed = undefined;
      if (next === null || current === undefined || next.laneId === current.laneId) return decision;
      const move = { card: id, from: current.laneId, to: next.laneId };
      const by = next.history.at(-1)?.actor ?? { kind: 'daemon' as const };
      const verdict = (await this.ports.moving?.({ ...move, by })) ?? { allow: true as const };
      if (!verdict.allow) throw new BoardError('forbidden', verdict.reason);
      landed = move;
      return decision;
    });
    if (landed !== undefined) {
      try {
        this.ports.moved?.(landed);
      } catch (error) {
        this.ports.diagnostics.warn(`board: the move of ${id} could not be announced: ${String(error)}`);
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------------

  /** One page of a board, or of every board. Closed and dropped cards only when the query asks. */
  async board(query: BoardQuery): Promise<BoardResponse> {
    const snapshot = await this.ports.store.read();
    const laneSets = await this.laneSetsOf([
      ...snapshot.cards.map(task => task.projectId),
      ...(query.project === undefined ? [] : [query.project]),
    ]);
    const index = new BoardIndex(snapshot.cards, this.ports.machineId() ?? '');
    const derivation = await gatherDerivation(snapshot.cards, index, laneSets, this.ports);
    const scoped = snapshot.cards
      .map(task => ({ view: deriveView(task, derivation), category: taskCategory(task, laneSets) }))
      .filter(entry => inScope(query, entry));
    const page = pageOf(
      query,
      scoped.filter(entry => passesFilters(query, entry)).map(entry => entry.view),
    );
    return {
      projectId: query.project ?? null,
      laneSet: query.project === undefined ? null : (laneSets.get(query.project) ?? null),
      cards: [...page.cards],
      counts: countsOf(query, scoped),
      nextCursor: page.nextCursor,
      quarantined: [...snapshot.quarantined],
    };
  }

  /**
   * Every readable card, as stored, with the lanes of each board they are on: what the daemon's own
   * automation reasons over. Nothing is derived, so it costs one store read and one lane read per board.
   */
  async snapshot(): Promise<{ readonly cards: readonly Task[]; readonly laneSets: LaneSets }> {
    const { cards: tasks } = await this.ports.store.read();
    return { cards: tasks, laneSets: await this.laneSetsOf(tasks.map(task => task.projectId)) };
  }

  /** Every card's view, closed and dropped included, with every board's lanes: the board sweep's one read. */
  async sweepBoard(
    signal?: AbortSignal,
  ): Promise<{ readonly views: readonly TaskView[]; readonly laneSets: LaneSets }> {
    const snapshot = await this.ports.store.read();
    const laneSets = await this.laneSetsOf(snapshot.cards.map(task => task.projectId));
    const index = new BoardIndex(snapshot.cards, this.ports.machineId() ?? '');
    const derivation = await gatherDerivation(snapshot.cards, index, laneSets, this.ports, signal);
    return { views: snapshot.cards.map(task => deriveView(task, derivation)), laneSets };
  }

  /**
   * Every open card that is orphaned, in board order, with every board's lanes: `sweepBoard`'s one read narrowed to
   * what the Warden reports, so the whole set is judged against one store read and one derivation of activity.
   */
  async orphanedCards(): Promise<{ readonly views: readonly TaskView[]; readonly laneSets: LaneSets }> {
    const { views, laneSets } = await this.sweepBoard();
    const orphaned = views
      .filter(
        view => view.activity === 'orphaned' && isOpenOnBoard(taskCategory(view, laneSets), view.dropped !== null),
      )
      .sort(compareViews);
    return { views: orphaned, laneSets };
  }

  /**
   * Closes a helper whose ferret ended (the board sweep found it gone): a sub-card with no PR to ship, closed as
   * the daemon with the reason "helper finished". Judged again inside the card's write, so a card that gained a PR
   * or moved since the sweep read it is left alone. `true` when it closed.
   */
  async closeEndedHelper(id: TaskId): Promise<boolean> {
    const caller: BoardCaller = { kind: 'daemon' };
    const closed = await this.write(id, async current => {
      if (current === undefined) return { task: null, result: null };
      const context = await this.context(current, caller);
      const reason = helperCloseReason(current, context.laneSet);
      const task = reason === null ? null : closeAsDaemon(current, reason, context);
      return { task: task === null ? null : requireValidTask(task), result: task };
    });
    if (closed === null) return false;
    await this.afterWrite(caller, closed, [closed.projectId]);
    return true;
  }

  /**
   * The daemon closes a card that sits at a try-it gate with nothing to try (`closeNothingToTry`): the one move past a
   * gate that is not the owner's. `expect` is checked inside the card's write, as an answer's is: the card must still sit
   * in that lane by that entry, or nothing is written. The verdict itself is judged AGAIN there, against the card and its
   * dependencies as they are now (steps, a block or an unfinished dependency can arrive without moving the card): the
   * card closes only when that is still `nothing`, for the very reason `reason` states. `true` when it closed.
   * Never reachable from a route or `fy`.
   */
  async closeWhereNothingToTry(
    id: TaskId,
    expect: { readonly laneId: string; readonly entry: number },
    reason: string,
  ): Promise<boolean> {
    const caller: BoardCaller = { kind: 'daemon' };
    const closed = await this.write(id, async current => {
      if (current === undefined) return { task: null, result: null };
      if (current.laneId !== expect.laneId || gateEntry(current) !== expect.entry) return { task: null, result: null };
      const context = await this.context(current, caller);
      const lane = context.laneSet.lanes.find(candidate => candidate.id === current.laneId);
      // A lane this board does not know offers no options: no try-it, so the verdict asks and nothing closes.
      const verdict = tryItVerdict(
        {
          ...current,
          blockedBy: blockedBy(current, context.index, context.laneSets),
          building: stillBuilding(current, context.index, context.laneSets),
        },
        { options: lane === undefined ? [] : [...stageGateLanes.options(lane)] },
      );
      if (verdict.kind !== 'nothing' || nothingToTryReason(verdict.why) !== reason) return { task: null, result: null };
      const task = closeNothingToTry(current, reason, context);
      return { task: task === null ? null : requireValidTask(task), result: task };
    });
    if (closed === null) return false;
    await this.afterWrite(caller, closed, [closed.projectId]);
    return true;
  }

  /**
   * Hands a card whose ferret (`from`) ended to `lead`, the nearest live lead above that ferret (the board sweep found
   * it): assigned as the daemon, with `returned to <lead>: <ferret> finished` in its history. The decision is made
   * again INSIDE the card's write, against the card as it is now AND the sessions as they are now: `settle` holds the
   * standing of the sessions the return rests on (the ferret, the ended ones above it, the lead) and hands the write a
   * roster of exactly those, read after the hold was taken, so none of them can end or resume between that read and
   * the card landing on disk. A card that moved, was reassigned, dropped or closed, whose ferret is back, or whose
   * nearest live lead is no longer `lead`, is left alone; the next sweep plans it afresh. The journal and the notices
   * run after the hold is released. `true` when it moved.
   */
  async returnToLead(
    id: TaskId,
    plan: { readonly lead: string; readonly from: string },
    settle: <T>(work: (fresh: FerretRoster) => Promise<T>) => Promise<T>,
  ): Promise<boolean> {
    const caller: BoardCaller = { kind: 'daemon' };
    const returned = await settle(
      async fresh =>
        await this.write(id, async current => {
          if (current === undefined || current.dropped !== null || effectiveAssignee(current) !== plan.from) {
            return { task: null, result: null };
          }
          const context = await this.context(current, caller);
          const category = categoryOf(context.laneSet, current.laneId);
          const lead = returnLead(current, category.ok ? category.value : undefined, fresh);
          if (lead !== plan.lead) return { task: null, result: null };
          const task = requireValidTask(returnTask(current, plan.lead, plan.from, context));
          return { task, result: task };
        }),
    );
    if (returned === null) return false;
    await this.afterWrite(caller, returned, [returned.projectId]);
    return true;
  }

  /** Every readable card id on this machine, closed and dropped included: one store read, nothing derived. */
  async ids(): Promise<BoardIdsResponse> {
    const { cards: tasks } = await this.ports.store.read();
    return { ids: tasks.map(task => task.id) };
  }

  /**
   * Whether a PR may merge as far as the queue goes (`mergeGateOf`, docs/design/clash-queue.md), from one read of
   * the board: the cards it could not read are named, since any of them might link the PR.
   */
  async mergeGate(pr: string): Promise<BoardMergeGateResponse> {
    const snapshot = await this.ports.store.read();
    const laneSets = await this.laneSetsOf(snapshot.cards.map(task => task.projectId));
    const index = new BoardIndex(snapshot.cards, this.requireMachine());
    const unreadable = snapshot.quarantined.map(task => task.id);
    const answer = mergeGateOf(pr, { index, laneSets, unreadable });
    if (answer === null) throw new BoardError('invalid', `not a GitHub pull request URL: ${pr}`);
    return answer;
  }

  /** One card, in full, with its board's lanes. */
  async card(id: TaskId): Promise<TaskResponse> {
    return await this.view(await this.ports.store.read(), id);
  }

  // -------------------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------------------

  /**
   * A new card (§3.1): a counter id, the caller as owner (or the assignee the owner named), the board of
   * the caller's project unless one is named, and the variant's first backlog lane unless one is named.
   */
  async create(request: TaskCreateRequest, caller: BoardCaller): Promise<TaskResponse> {
    await this.refuseSubFerret(caller, 'create tasks');
    // One Yes makes one card: two creates on the same approval are decided one after the other.
    if (caller.kind === 'ferret' && request.approval !== undefined) {
      const key = `board:approval:${caller.ferret}:${request.approval}`;
      return await this.ports.serial.run(key, async () => await this.createLicensed(request, caller));
    }
    return await this.createLicensed(request, caller);
  }

  private async createLicensed(request: TaskCreateRequest, caller: BoardCaller): Promise<TaskResponse> {
    const machineId = this.requireMachine();
    const owner = ferretOf(caller) ?? request.assignee;
    if (owner === undefined || owner === null) {
      throw new BoardError('invalid', 'a task needs a ferret to own it: name its assignee, who owns it too');
    }
    const projectId = request.projectId ?? (await this.projectOf(caller));
    const laneSet = await this.requireLaneSet(projectId);
    const snapshot = await this.ports.store.read();
    const index = new BoardIndex(snapshot.cards, machineId);
    const parent = request.parent === null ? undefined : requireLocalTask(index, request.parent, 'parent');
    if (parent !== undefined) requireStanding('adopt', await this.standing(caller, parent), parent);
    const approval = await this.requireLicence(caller, projectId, {
      parent,
      named: request.approval,
      cards: snapshot.cards,
    });
    const thread = await this.requireThread(caller, request.thread);
    const id = await this.ports.store.allocateId(request.kind);
    const task = await this.insert(id, request, {
      machineId,
      caller,
      owner,
      projectId,
      laneSet,
      index,
      approval,
    });
    // After the insert: a failed create never leaves a thread linked to a card that does not exist.
    const unlinked = await this.linkThread(thread, { id, machineId }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await this.afterWrite(caller, task, [task.projectId], true);
    if (unlinked !== undefined) throw unlinked;
    return await this.view(await this.ports.store.read(), id);
  }

  /** The next id of a kind from the machine-wide counter, for a card a caller must name before it exists. */
  async reserve(kind: TaskKind): Promise<TaskId> {
    this.requireMachine();
    return await this.ports.store.allocateId(kind);
  }

  /**
   * A card the daemon makes for a session it is starting (§3.1), under the id {@link reserve} gave the
   * start to name in the brief. The daemon decided who owns it, so no caller's standing is asked; the
   * parent must still be a card on this machine. `by` is the session the card is recorded as made from
   * (the lead of a `fy new`, else the session itself), and `focus` is the session that will work on it.
   */
  async spawn(
    id: TaskId,
    request: TaskCreateRequest,
    spawn: { readonly owner: string; readonly by: string; readonly focus: string; readonly projectId: BoardProjectId },
  ): Promise<Task> {
    const machineId = this.requireMachine();
    const laneSet = await this.requireLaneSet(spawn.projectId);
    const index = new BoardIndex((await this.ports.store.read()).cards, machineId);
    if (request.parent !== null) requireLocalTask(index, request.parent, 'parent');
    const caller: BoardCaller = { kind: 'daemon', ferret: spawn.by };
    const task = await this.insert(id, request, {
      machineId,
      caller,
      owner: spawn.owner,
      projectId: spawn.projectId,
      laneSet,
      index,
    });
    await this.afterWrite(caller, task, [task.projectId]);
    if (
      !(await this.ports.focus.setFocus(spawn.focus, { id: task.id }, task.title, { anchor: true }).catch(() => false))
    ) {
      this.ports.diagnostics.warn(`could not focus ${spawn.focus} on ${formatTaskRef(task)}`);
    }
    return task;
  }

  /**
   * Whether the lead may hand an EXISTING card to a helper (`fy new --card`): the card is here, not dropped,
   * and the lead may reassign it. Throws the refusal otherwise; changes nothing.
   */
  async requireHandOver(id: TaskId, lead: string): Promise<Task> {
    const machineId = this.requireMachine();
    const task = new BoardIndex((await this.ports.store.read()).cards, machineId).get({ id });
    if (task === undefined)
      throw new BoardError('not-found', `there is no task ${formatTaskRef({ id })} on this machine`);
    if (task.dropped !== null) {
      throw new BoardError('invalid', `${formatTaskRef(task)} is dropped; reopen it before you hand it to a helper`);
    }
    // The assignee may hand it down; the child does not exist yet, and `handOver` proves it is the lead's own.
    const standing = await this.standing({ kind: 'ferret', ferret: lead }, task);
    if (standing !== 'assignee') requireStanding('assign', standing, task);
    return task;
  }

  /**
   * `fy new --card`, once the helper's session exists: the lead's existing card is assigned to it — its owner
   * and parent stay — and becomes the session's focus and delegation anchor. Never makes a second card. The
   * assignment is recorded as the lead's; the lead's own focus is not touched.
   */
  async handOver(id: TaskId, lead: string, session: string, held: TaskHolders): Promise<Task> {
    const outcome = await this.assignTo(id, { kind: 'ferret', ferret: lead }, session, 'hand it to a helper', held);
    await this.afterWrite({ kind: 'daemon', ferret: lead }, outcome, [outcome.projectId]);
    return await this.focusOn(outcome, session);
  }

  /**
   * The owner's "start a ferret on it" (`startOnCard`), once the new session exists: the card is assigned to it
   * as the owner's act and becomes the session's focus and anchor. Refused, with nothing changed, when the card
   * was dropped in the meantime — the same write that assigns it reads that, so a drop and this cannot both win.
   */
  async assignForOwner(id: TaskId, session: string, held: TaskHolders): Promise<Task> {
    const outcome = await this.assignTo(id, { kind: 'owner' }, session, 'start a ferret on it', held);
    await this.afterWrite({ kind: 'owner' }, outcome, [outcome.projectId]);
    return await this.focusOn(outcome, session);
  }

  private async assignTo(
    id: TaskId,
    caller: BoardCaller,
    session: string,
    doing: string,
    held: TaskHolders,
  ): Promise<Task> {
    return await this.write(id, async current => {
      const boardTask = this.requireCard(current, id);
      // The caller's authority survives a change of assignee (a lead keeps the card it owns, the owner has it always), so
      // authority alone cannot tell a second start from the first: the card must still be held as the start judged it.
      if (boardTask.owner !== held.owner || boardTask.assignee !== held.assignee) {
        throw new BoardError(
          'version-conflict',
          `${formatTaskRef(boardTask)} changed hands since you chose it (now held by ${effectiveAssignee(boardTask)}); nothing was assigned`,
        );
      }
      if (boardTask.dropped !== null)
        throw new BoardError('invalid', `${formatTaskRef(boardTask)} is dropped; reopen it before you ${doing}`);
      const category = categoryOf(await this.requireLaneSet(boardTask.projectId), boardTask.laneId);
      if (category.ok && category.value === 'closed')
        throw new BoardError('invalid', `${formatTaskRef(boardTask)} is closed; reopen it before you ${doing}`);
      const applied = applyAction(
        boardTask,
        { action: 'assign', assignee: session },
        await this.context(boardTask, caller, session),
      );
      const task = requireValidTask(applied.task as Task);
      return { task, result: task };
    });
  }

  private async focusOn(task: Task, session: string): Promise<Task> {
    if (!(await this.ports.focus.setFocus(session, { id: task.id }, task.title, { anchor: true }).catch(() => false))) {
      this.ports.diagnostics.warn(`could not focus ${session} on ${formatTaskRef(task)}`);
    }
    return task;
  }

  /**
   * `fy signal done` on the ferret's focus card (§3.1 item 5): the message as the ferret's note, and — still
   * in an `active` lane with no PR — the daemon's automatic `signal.done` move to where the work is checked,
   * with the message as the reason ({@link doneLane}, {@link doneMove}). The note and the move are one
   * write. An owner gate or an unfinished blocker holds the card, keeps the note, and says why in `held`. `null` when the session has no focus card here.
   */
  async signalDone(ferret: string, message: string | undefined): Promise<SignalDoneOutcome | null> {
    const machineId = this.requireMachine();
    const focus = await this.ports.focus.focusOf(ferret);
    if (focus === null || (focus.machineId !== undefined && focus.machineId !== machineId)) return null;
    const caller: BoardCaller = { kind: 'ferret', ferret };
    const outcome = await this.ports.store.write<SignalDoneOutcome | null>(focus.id, async current => {
      if (current === undefined) return { task: null, result: null };
      const context = await this.context(current, caller);
      const noted = applyAction(current, { action: 'note', text: doneNote(message) }, context).task as Task;
      // A helper (a sub-card with no PR to ship) closes with its ferret's done; the owner never tests it.
      const closing = helperCloseReason(noted, context.laneSet);
      if (closing !== null) {
        const closed = closeAsDaemon(noted, closing, context);
        const lane =
          closed === null ? undefined : context.laneSet.lanes.find(candidate => candidate.id === closed.laneId);
        if (closed !== null && lane !== undefined) {
          return { task: requireValidTask(closed), result: { task: closed, moved: lane } };
        }
      }
      const target = doneLane(current, context.laneSet);
      if (target === null) return { task: requireValidTask(noted), result: { task: noted, moved: null } };
      const blockers = blockedBy(current, context.index, context.laneSets);
      const move = doneMove(noted, target, context.laneSet, blockers, message, {
        now: context.now,
        actor: { kind: 'daemon' },
      });
      if ('held' in move) {
        return { task: requireValidTask(noted), result: { task: noted, moved: null, held: move.held } };
      }
      const task = requireValidTask(move.task);
      // Where it landed: the lane done names, or a gate on the way, where it stops.
      const moved = context.laneSet.lanes.find(lane => lane.id === task.laneId) ?? target;
      return { task, result: { task, moved } };
    });
    if (outcome === null) return null;
    await this.afterWrite(caller, outcome.task, [outcome.task.projectId]);
    return outcome;
  }

  /**
   * One action on one card. `expect` (an answer to a gate item) is checked inside the card's write: the card must
   * still sit in that lane by that entry, or nothing is written.
   */
  async act(
    id: TaskId,
    request: TaskActionRequest,
    caller: BoardCaller,
    expect?: { readonly laneId: string; readonly entry: number },
  ): Promise<TaskResponse> {
    // An assign is judged inside the write: a helper that is the card's assignee may hand it down (`decide`).
    // A drop and an assign are judged inside the write (`decide`): a helper that leads a subtree may plan it.
    // A holder-only action is judged in the write against the card's current holder (`decide`).
    if (!subFerretMay(request) && !holderOnly(request) && request.action !== 'assign' && request.action !== 'drop') {
      await this.refuseSubFerret(caller, subFerretDoing(request));
    }
    if (request.action === 'focus' && caller.kind !== 'ferret') {
      throw new BoardError('invalid', 'focus is for a ferret: it names the task its session works on');
    }
    const write = async (hold?: AdoptionHold) =>
      await this.write(id, async current => {
        const task = this.requireCard(current, id);
        if (expect !== undefined && (task.laneId !== expect.laneId || gateEntry(task) !== expect.entry)) {
          throw new BoardError('invalid', `${formatTaskRef(task)} has moved on from the gate the answer was about`);
        }
        const outcome = await this.decide(task, request, caller, hold);
        return { task: outcome.task === null ? null : requireValidTask(outcome.task), result: { card: task, outcome } };
      });
    const { card: task, outcome } =
      request.action === 'depend' || (request.action === 'file' && request.release !== true)
        ? await this.ports.serial.run(DEPENDENCY_SECTION, write)
        : request.action === 'adopt'
          ? await this.holdingAdopters(id, caller, write)
          : await write();
    if (request.action === 'focus') {
      if (
        !(await this.ports.focus.setFocus((caller as { ferret: string }).ferret, { id: task.id }, task.title, {
          anchor: true,
        }))
      ) {
        throw new BoardError('not-found', 'there is no session to focus');
      }
    }
    if (outcome.task !== null) {
      await this.afterWrite(caller, outcome.task, [...new Set([task.projectId, outcome.task.projectId])]);
      await this.deliverReopen(caller, outcome, outcome.task);
      await this.deliverDone(caller, request, task, outcome.task);
    }
    return await this.view(await this.ports.store.read(), id);
  }

  /**
   * `fy card skip "<why>"` (§3.4): the calling ferret records why its work needs no card — chit-chat, or the
   * owner said not to track it — so the turn-end check stays quiet until it takes one. It is a decision about
   * the ferret's own session, so only a ferret makes it, and only for itself.
   */
  async skip(request: BoardSkipRequest, caller: BoardCaller): Promise<BoardSkipResponse> {
    if (caller.kind !== 'ferret') {
      throw new BoardError('invalid', 'skip is for a ferret: it records why its own session has no task');
    }
    const skip = { reason: request.reason, at: this.ports.clock.now() };
    if (!(await this.ports.focus.skip(caller.ferret, skip))) {
      throw new BoardError('not-found', 'there is no session to record the skip on');
    }
    return { ferret: caller.ferret, skip };
  }

  /**
   * A daemon move on a real signal (work started, PR opened, merged, released; §3.1). Lands in the lane
   * the trigger names for the card's workflow, never backwards. `null` when the card did not move.
   */
  async trigger(
    id: TaskId,
    trigger: LaneTrigger,
    options: { readonly ferret?: string; readonly reason?: string } = {},
  ): Promise<TaskResponse | null> {
    const caller: BoardCaller =
      options.ferret === undefined ? { kind: 'daemon' } : { kind: 'daemon', ferret: options.ferret };
    const moved = await this.write(id, async current => {
      const task = this.requireCard(current, id);
      const context = await this.context(task, caller);
      const next = triggerMove(task, trigger, options.reason, context);
      return { task: next === null ? null : requireValidTask(next), result: next };
    });
    if (moved === null) return null;
    await this.afterWrite(caller, moved, [moved.projectId]);
    return await this.view(await this.ports.store.read(), id);
  }

  /**
   * What the GitHub watcher learned of a card's PRs (`pr-cache.ts`): the cache, the automatic links, the
   * notes and the moves they trigger, as ONE daemon write. The nudges are handed back for the watcher to
   * send, because who hears them is not the board's to decide.
   */
  async recordPullRequests(id: TaskId, update: PrUpdate): Promise<PrUpdateOutcome> {
    const caller: BoardCaller = { kind: 'daemon' };
    const outcome = await this.write(id, async current => {
      const boardTask = this.requireCard(current, id);
      const applied = applyPrUpdate(boardTask, update, await this.context(boardTask, caller));
      const task = applied.task === null ? null : requireValidTask(applied.task);
      return { task, result: { ...applied, task } };
    });
    if (outcome.task !== null) await this.afterWrite(caller, outcome.task, [outcome.task.projectId]);
    return outcome;
  }

  /**
   * Moves the cards of the lanes a lane edit removed to the lanes it named (`moves`: removed → kept),
   * after the edited set is stored (U3's `CardRelocator`). Safe to repeat: a card no longer in a removed
   * lane of this project is left alone. The direction of such a move is not defined — its lane is gone —
   * so it is recorded as `by`'s move that says why: `reason`, else that the lane was removed. `by` is the
   * owner for their own edit or their Accept of a proposal; anyone else is the daemon, which never closes a
   * card here: a move into a closed lane is left undone and said in the diagnostics (the lane service already
   * refused any gate it would pass). Returns the cards it moved.
   */
  async relocate(
    projectId: BoardProjectId,
    moves: Readonly<Record<string, string>>,
    reason?: string,
    by: RelocationAuthority = { kind: 'daemon' },
  ): Promise<readonly TaskId[]> {
    const refused =
      by.kind === 'owner' ? new Map<string, string>() : await this.refusedRelocations(projectId, moves, by);
    const pending = (await this.ports.store.read()).cards.filter(task => {
      if (task.projectId !== projectId || moves[task.laneId] === undefined) return false;
      const why = refused.get(task.laneId);
      if (why === undefined) return true;
      this.ports.diagnostics.warn(
        `board: left ${formatTaskRef(task)} in ${task.laneId}: the daemon's relocation ${why}`,
      );
      return false;
    });
    const moved: TaskId[] = [];
    for (const { id } of pending) {
      const task = await this.write(id, async current => {
        const to = current === undefined || current.projectId !== projectId ? undefined : moves[current.laneId];
        if (current === undefined || to === undefined || to === current.laneId) return { task: null, result: null };
        const next = withEvent(
          current,
          {
            type: 'moved',
            from: current.laneId,
            to,
            backward: false,
            reason: reason ?? `lane ${current.laneId} was removed from the board`,
          },
          { now: this.ports.clock.now(), actor: await actorOf(callerOf(by), this.ports.names) },
        );
        const valid = requireValidTask({ ...next, laneId: to });
        return { task: valid, result: valid };
      });
      if (task === null) continue;
      moved.push(task.id);
      await this.afterWrite(callerOf(by), task, [projectId]);
    }
    return moved;
  }

  /**
   * The moves of a relocation that is not the owner's that only the owner may make (`relocationProblems`): into a
   * closed lane or a lane the set lacks, forward out of a gate or past one. Judged against the lanes as they are now. Removed lane → why.
   */
  private async refusedRelocations(
    projectId: BoardProjectId,
    moves: Readonly<Record<string, string>>,
    _by: Extract<RelocationAuthority, { kind: 'daemon' }>,
  ): Promise<ReadonlyMap<string, string>> {
    const after = (await this.ports.lanes.laneSet(projectId)) ?? { lanes: [] };
    const problems = relocationProblems(after, after, moves);
    return new Map(problems.map(problem => [problem.from, describeRelocationProblem(problem)]));
  }

  // -------------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------------

  /** Writes a brand-new card under a counter id; the id already holding a card is the counter's fault. */
  /**
   * A new card never fails for want of the owner's words; the backfill lets it, so the card waits for the next boot.
   * A caller that needs the answer settled (a ferret's choice to hide a card) asks for it strictly: not knowing is
   * an unavailable board, never a guess that a later boot would have to take back.
   */
  private async askedByOf(
    task: Pick<Task, 'createdBy' | 'ask'>,
    ownerApp: boolean,
    options: { readonly lenient?: boolean; readonly strict?: boolean } = {},
  ) {
    return await decideAskedBy(task, ownerApp, async ferret => {
      try {
        if (options.strict && this.ports.ownerWords === undefined) throw new Error('owner words are unavailable');
        return (await this.ports.ownerWords?.said(ferret, { strict: options.strict })) ?? [];
      } catch (error) {
        if (!options.lenient) throw error;
        this.ports.diagnostics.warn(
          `board: could not read what the owner said to ${ferret}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    });
  }

  private async insert(
    id: TaskId,
    request: TaskCreateRequest,
    facts: {
      readonly machineId: string;
      readonly caller: BoardCaller;
      readonly owner: string;
      readonly projectId: BoardProjectId;
      readonly laneSet: LaneSet;
      readonly index: BoardIndex;
      /** The owner's Yes the card rests on, when that is what let a ferret make it. */
      readonly approval?: AskRef;
    },
  ): Promise<Task> {
    const made = newTask(request, {
      id,
      machineId: facts.machineId,
      now: this.ports.clock.now(),
      actor: await actorOf(facts.caller, this.ports.names),
      standing: facts.caller.kind === 'owner' ? 'owner-human' : 'owner',
      owner: facts.owner,
      projectId: facts.projectId,
      laneSet: facts.laneSet,
      index: facts.index,
    });
    // A ferret's explicit private is only as good as the asker it rests on: an owner's ask it cannot yet tell from
    // an agent's must not be hidden for good, so that lookup may not fail softly here.
    const hides = request.visibility === 'private' && facts.caller.kind !== 'owner';
    const ownerApp = facts.caller.kind === 'owner' && facts.caller.via === undefined;
    const askedBy = hides
      ? await this.settledAskedBy(made, ownerApp)
      : await this.askedByOf(made, ownerApp, { lenient: true });
    const visibility = request.visibility ?? defaultVisibility({ ...made, askedBy });
    const visibilitySource = request.visibility === undefined ? 'default' : 'chosen';
    if (request.visibility !== undefined) {
      const standing = facts.caller.kind === 'owner' ? 'owner-human' : 'owner';
      const refusal = visibilityVerdict({ ...made, askedBy }, request.visibility, standing);
      if (refusal !== null) throw new BoardError('forbidden', refusal.message, refusal.allowed);
    }
    const task = requireValidTask({
      ...made,
      askedBy,
      visibility,
      visibilitySource,
      ...(facts.approval === undefined ? {} : { approval: facts.approval }),
    });
    const persist = async (ready: Task): Promise<Task> => {
      await this.write(id, async current => {
        if (current !== undefined)
          throw new BoardUnavailableError(`the counter issued ${id}, which a task already holds`);
        return { task: ready, result: undefined };
      });
      return ready;
    };
    if (task.files.length === 0) return await persist(task);
    // A card born with claims is queued behind the open cards whose claims clash (docs/design/clash-queue.md). The
    // board is read again inside the dependency section, so a claim landing meanwhile is seen.
    return await this.ports.serial.run(DEPENDENCY_SECTION, async () => {
      const index = new BoardIndex((await this.ports.store.read()).cards, facts.machineId);
      const laneSets: LaneSets = new Map([[facts.projectId, facts.laneSet]]);
      const queued = queueBehindClashes(task, task.files, {
        index,
        laneSets,
        now: task.createdAt,
      });
      return await persist(requireValidTask(queued));
    });
  }

  /**
   * Runs an adoption's card write inside a hold on the sessions it rests on: the card's owner ferret, its assignee and the
   * adopter, named from the card as it is read now. The write re-judges them against the card as it is stored then
   * (`orphanedOwner`), so a card that changed hands in the gap is refused rather than adopted. The order is the one
   * `returnToLead` keeps: the sessions settle outside, the card's write is inside. Without a hold (no port, or nothing
   * to hold) the write runs bare and `orphanedOwner` refuses.
   */
  private async holdingAdopters<T>(
    id: TaskId,
    caller: BoardCaller,
    write: (hold?: AdoptionHold) => Promise<T>,
  ): Promise<T> {
    const guard = this.ports.liveness;
    const task = (await this.ports.store.read()).cards.find(each => each.id === id);
    if (guard === undefined || task === undefined || caller.kind !== 'ferret') return await write();
    const held = [...new Set([task.owner, effectiveAssignee(task), caller.ferret])];
    return await guard.settled(held, async fresh => await write({ fresh, held }));
  }

  private async decide(
    task: Task,
    request: TaskActionRequest,
    caller: BoardCaller,
    hold?: AdoptionHold,
  ): Promise<TaskOutcome> {
    // A helper reports what it saw on the card it is doing, not on others its standing reaches.
    if (request.action === 'trigger' && caller.kind === 'ferret' && caller.ferret !== effectiveAssignee(task)) {
      await this.refuseSubFerret(
        caller,
        'report events on a task they are not doing',
        async () => await this.claimCommand(caller, task),
      );
    }
    // The card's current holder may move it, focus on it and link a commit or doc to it; claiming a card is how a
    // helper becomes the holder of one its lead holds, so the refusal says that and nothing else is offered.
    if (holderOnly(request) && caller.kind === 'ferret' && caller.ferret !== effectiveAssignee(task)) {
      await this.refuseSubFerret(caller, subFerretDoing(request), async () => await this.claimCommand(caller, task));
    }
    const adoptedFrom = request.action === 'adopt' ? await this.orphanedOwner(caller, task, hold) : undefined;
    const context = await this.context(task, caller, request.action === 'assign' ? request.assignee : undefined);
    const plans = request.action === 'drop' || (request.action === 'assign' && context.handsDown !== true);
    if (plans && !(await this.inSubtree(caller, task))) {
      await this.refuseSubFerret(
        caller,
        subFerretDoing(request),
        request.action === 'assign'
          ? async () => await this.claimThenAssign(caller, task, request.assignee)
          : undefined,
      );
    }
    const claimedFrom = await this.claimedFrom(caller, task, request, context.standing);
    const refiled = request.action === 'refile' && request.projectId !== task.projectId ? request.projectId : null;
    if (refiled !== null) await this.requireRefileLicence(task, refiled, caller, context.index);
    const target = refiled === null ? null : await this.ports.lanes.laneSet(refiled);
    const parentStanding =
      request.action === 'reparent' && request.parent !== null
        ? await this.parentStanding(request.parent, caller, context.index)
        : null;
    const attachments =
      (request.action === 'move' || request.action === 'reopen') && request.attachments !== undefined
        ? await this.attachmentsFor(task, request.attachments, context.standing)
        : undefined;
    const hidden = await this.settledForHiding(task, request, context.standing);
    try {
      return applyAction(
        hidden,
        request,
        {
          ...context,
          ...(attachments === undefined ? {} : { attachments }),
          ...(claimedFrom === undefined ? {} : { claimedFrom }),
          ...(adoptedFrom === undefined ? {} : { adoptedFrom }),
        },
        target,
        parentStanding,
      );
    } catch (error) {
      // A refusal to a ferret that could take the card first says so: claim it, rather than ask the lead that holds it.
      // An assign is not offered this here: whether a claim would let it through is judged above (`claimThenAssign`).
      if (
        claimedFrom !== undefined &&
        request.action !== 'claim' &&
        request.action !== 'assign' &&
        error instanceof BoardError &&
        error.code === 'forbidden'
      ) {
        throw new BoardError(
          error.code,
          `${error.message}; your lead holds it: claim it first: fy task claim ${formatTaskRef(task)}`,
          error.allowed,
        );
      }
      throw error;
    }
  }

  /**
   * The ended owner ferret a live lead may ADOPT this card from, or the refusal: the caller is a lead (the roster read under
   * the hold says it was started by nobody: a caller it cannot place is refused, never presumed a lead), alive, working on
   * the card's own board; the card is open work; and its owner ferret AND its assignee are both ended, as that same
   * roster says (a session the roster cannot read is never taken for ended). The hold names the holders of the card as it
   * was read before the write; a card that has other holders now is refused. Nothing else about authority changes: the
   * adopter is then the card's owner ferret and assignee, and judged as one.
   */
  private async orphanedOwner(caller: BoardCaller, task: Task, hold: AdoptionHold | undefined): Promise<string> {
    const ref = formatTaskRef(task);
    if (caller.kind !== 'ferret')
      throw new BoardError(
        'forbidden',
        `adopt is a ferret's: the owner assigns ${ref} with \`fy task assign ${ref} <ferret>\``,
      );
    if (task.dropped !== null) throw new BoardError('invalid', `${ref} is dropped: nothing to adopt`);
    const category = categoryOf(await this.requireLaneSet(task.projectId), task.laneId);
    if (category.ok && category.value === 'closed')
      throw new BoardError('invalid', `${ref} is closed: nothing to adopt`);
    if (hold === undefined)
      throw new BoardError(
        'forbidden',
        `which ferrets are alive cannot be read here, so ${ref} cannot be shown to be orphaned`,
      );
    const roster = hold.fresh;
    const holders = [...new Set([task.owner, effectiveAssignee(task)])];
    if (holders.some(holder => !hold.held.includes(holder))) {
      throw new BoardError('version-conflict', `${ref} changed hands while it was being adopted: try again`);
    }
    const alive = holders.filter(holder => presenceOf(roster, holder) !== 'dead');
    if (alive.length > 0) {
      throw new BoardError(
        'forbidden',
        `${ref} is not orphaned: ${alive.join(', ')} ${alive.length === 1 ? 'has' : 'have'} not ended`,
      );
    }
    if (presenceOf(roster, caller.ferret) !== 'alive')
      throw new BoardError('forbidden', `only a live ferret may adopt ${ref}`);
    const session = roster.sessions.get(caller.ferret);
    if (session?.lead !== undefined)
      throw new BoardError(
        'forbidden',
        `only a lead may adopt ${ref}: ${caller.ferret} was started by ${session.lead}`,
      );
    if (session?.configRead !== true)
      throw new BoardError(
        'forbidden',
        `only a lead may adopt ${ref}: who started ${caller.ferret} cannot be read, so it is not shown to be a lead`,
      );
    if ((await this.ports.lanes.projectOf(caller.ferret)) !== task.projectId) {
      throw new BoardError(
        'forbidden',
        `${ref} is on another board than the one you work on: only a lead on its board may adopt it`,
      );
    }
    return task.owner;
  }

  /**
   * The lead the caller may claim the card from (`claimableFrom`), read from the session registry's lineage: asked only
   * for a claim, and for a ferret with no standing on the card, whose refusal can then name the claim.
   */
  private async claimedFrom(
    caller: BoardCaller,
    task: Task,
    request: TaskActionRequest,
    standing: BoardStanding,
  ): Promise<string | undefined> {
    if (caller.kind !== 'ferret' || (request.action !== 'claim' && standing !== 'reader')) return undefined;
    return claimableFrom(caller, task, await ancestorsOf(caller.ferret, this.ports.parents));
  }

  /**
   * The claim to offer a refused assign: only when claiming the card WOULD let it through, which is a hand-down to a
   * descendant the daemon's lineage proves. An assign to nobody, upward or sideways stays forbidden to the card's holder
   * too, so it is the lead's to do.
   */
  private async claimThenAssign(caller: BoardCaller, task: Task, assignee: string | null): Promise<string | undefined> {
    if (caller.kind !== 'ferret' || assignee === null || assignee === caller.ferret) return undefined;
    if (!(await ancestorsOf(assignee, this.ports.parents)).includes(caller.ferret)) return undefined;
    return await this.claimCommand(caller, task);
  }

  /** `fy card claim &F12` when the caller may claim the card; `undefined` when it may not. */
  private async claimCommand(caller: BoardCaller, task: Task): Promise<string | undefined> {
    if (caller.kind !== 'ferret') return undefined;
    const from = claimableFrom(caller, task, await ancestorsOf(caller.ferret, this.ports.parents));
    return from === undefined ? undefined : `fy task claim ${formatTaskRef(task)}`;
  }

  /**
   * The card as a ferret's choice to make it private must judge it: with who asked for it settled, because an
   * unsettled agent-asked card may be the owner's. Any other request, and the owner, judge the card as stored.
   */
  private async settledForHiding(task: Task, request: TaskActionRequest, standing: BoardStanding) {
    const hides = (request.action === 'edit' || request.action === 'visibility') && request.visibility === 'private';
    if (!hides || standing === 'owner-human' || task.askedBy === 'person') return task;
    return { ...task, askedBy: await this.settledAskedBy(task, false) };
  }

  /** Who asked for the card, or an unavailable board when that cannot be read: a guess here would hide a card for good. */
  private async settledAskedBy(task: Pick<Task, 'createdBy' | 'ask'>, ownerApp: boolean) {
    // Strict (F-0001): the owner's words come from Conversation (the queue, the send ledger and who wrote each turn). A
    // read that cannot be made, Conversation being off included, is an unavailable board, never a guess.
    try {
      return await this.askedByOf(task, ownerApp, { strict: true });
    } catch (error) {
      throw new BoardUnavailableError(
        `who asked for this task cannot be settled right now: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The files a move back carries, found where the app uploaded them. They are the OWNER's ("Not good" with a
   * picture), and they must sit in the session of a ferret the reopen is delivered to — the card's assignee or
   * its owner ferret — so a request cannot pull another session's files onto this card.
   */
  private async attachmentsFor(
    task: Task,
    request: BoardReopenAttachments,
    standing: BoardStanding,
  ): Promise<NonNullable<TaskContext['attachments']>> {
    const ref = formatTaskRef(task);
    if (standing !== 'owner-human') {
      throw new BoardError('forbidden', `only the owner sends files with a move back of ${ref}`, ['owner-human']);
    }
    if (request.from !== effectiveAssignee(task) && request.from !== task.owner) {
      throw new BoardError(
        'invalid',
        `the files for ${ref} must be uploaded to its ferret (${effectiveAssignee(task)}), not ${request.from}`,
      );
    }
    const source = this.ports.attachments;
    if (source === undefined) throw new BoardError('invalid', 'this daemon cannot carry files with a move back');
    const files = await source.describe(request.from, request.ids).catch((error: unknown) => {
      throw new BoardError(
        'invalid',
        `a file sent with ${ref} is not in its ferret's session: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return { request, files };
  }

  /** The caller's standing on the card a re-parent would put a card under; `null` when that card is not here. */
  private async parentStanding(parent: TaskRef, caller: BoardCaller, index: BoardIndex) {
    const found = index.isLocal(parent) ? index.get(parent) : undefined;
    return found === undefined ? null : await this.standing(caller, found);
  }

  /**
   * `assignee` is the session an assign would name: when the caller is the card's assignee and that session is one of
   * its own descendants, the context says the card is handed down.
   */
  private async context(task: Task, caller: BoardCaller, assignee?: string | null) {
    const snapshot = await this.ports.store.read();
    const index = new BoardIndex(snapshot.cards, this.requireMachine());
    const laneSet = await this.requireLaneSet(task.projectId);
    const projects = task.dependsOn.map(dependency => index.get(dependency.task)?.projectId);
    const laneSets = await this.laneSetsOf(
      projects.filter((project): project is BoardProjectId => project !== undefined),
    );
    const standing = await this.standing(caller, task);
    const handsDown =
      assignee !== undefined &&
      assignee !== null &&
      standing === 'assignee' &&
      mayHandDown(caller, standing, assignee, await ancestorsOf(assignee, this.ports.parents));
    return {
      now: this.ports.clock.now(),
      runningVersion: this.ports.runningVersion?.() ?? null,
      actor: await actorOf(caller, this.ports.names),
      standing,
      ...(handsDown ? { handsDown } : {}),
      audience: await this.audienceOf(task),
      laneSet,
      index,
      laneSets: new Map([...laneSets, [task.projectId, laneSet]]),
    };
  }

  /**
   * Who a card's gates ask (`cardAudience`): the session that wrote it is read for whether a ferret started it, and a
   * read that fails reads as the owner's.
   */
  async audienceOf(task: Pick<Task, 'createdBy' | 'ask' | 'askedBy'>): Promise<TaskAudience> {
    const writer = task.createdBy.kind === 'ferret' ? task.createdBy.ferret : undefined;
    const parent = writer === undefined ? undefined : await this.ports.parents.parentOf(writer).catch(() => undefined);
    return taskAudience(task, parent !== undefined);
  }

  /**
   * The caller's standing on a card; the lineages of its owner and of its assignee are walked only for a ferret that
   * is neither.
   */
  private async standing(caller: BoardCaller, task: Task) {
    if (caller.kind === 'ferret' && caller.ferret === task.owner) return standingOf(caller, task, [], []);
    const [owners, assignees] = await this.lineages(caller, task);
    return standingOf(caller, task, owners, assignees);
  }

  /**
   * Whether the card is in the caller's subtree: the caller owns it, or its owner or its assignee is a descendant of
   * the caller. A lead that owns a card is the root of its own subtree, so a card returned to it (assignee = owner)
   * can still be dropped or handed to a replacement.
   */
  private async inSubtree(caller: BoardCaller, task: Task): Promise<boolean> {
    if (caller.kind !== 'ferret') return false;
    if (caller.ferret === task.owner) return true;
    const [owners, assignees] = await this.lineages(caller, task);
    return owners.includes(caller.ferret) || assignees.includes(caller.ferret);
  }

  /** The leads above the card's owner and above its assignee; empty for the caller that is that very ferret. */
  private async lineages(caller: BoardCaller, task: Task): Promise<readonly [readonly string[], readonly string[]]> {
    if (caller.kind !== 'ferret') return [[], []];
    const assignee = effectiveAssignee(task);
    return [
      caller.ferret === task.owner ? [] : await ancestorsOf(task.owner, this.ports.parents),
      caller.ferret === assignee || assignee === task.owner ? [] : await ancestorsOf(assignee, this.ports.parents),
    ];
  }

  private requireCard(current: Task | undefined, id: TaskId): Task {
    if (current === undefined) throw new BoardError('not-found', `there is no task &${id} on this machine`);
    return current;
  }

  /**
   * The board is opt-in (`opt-in.ts`): a ferret's card on a board that is off needs a live parent it holds on that
   * board, or the owner's Yes (`named`, judged here; `carried` when the card already rests on one), else it is
   * refused with what to do instead. Answers the approval a NEW card rests on, when that is what let it through;
   * nobody but a ferret is asked.
   */
  private async requireLicence(
    caller: BoardCaller,
    projectId: BoardProjectId,
    proof: {
      readonly parent: Task | undefined;
      readonly named?: string;
      readonly carried?: boolean;
      readonly cards: readonly Task[];
    },
  ): Promise<AskRef | undefined> {
    const optIn = this.ports.optIn;
    if (caller.kind !== 'ferret' || optIn === undefined) return undefined;
    // A switch that cannot be read is off (docs/board.md): the rule fails closed, never open.
    const boardOn = await optIn.isOn(projectId).catch(() => false);
    const named = boardOn ? undefined : proof.named;
    let problem: string | undefined;
    if (named !== undefined) {
      const item = await optIn.answered(caller.ferret, named).catch(() => undefined);
      const usedBy = proof.cards.find(task => task.approval?.ferret === caller.ferret && task.approval.id === named);
      problem = approvalProblem(named, item, caller.ferret, usedBy) ?? undefined;
    }
    const licence = taskLicence({
      boardOn,
      parent: proof.parent !== undefined && proof.parent.projectId === projectId && (await this.live(proof.parent)),
      approved: proof.carried === true || (named !== undefined && problem === undefined),
    });
    if (licence === 'approval' && named !== undefined) return { ferret: caller.ferret, id: named };
    if (licence !== null) return undefined;
    const board = await optIn.nameOf(projectId).catch(() => projectId);
    throw new BoardError('forbidden', offBoardRefusal(board, problem));
  }

  /**
   * The thread a new card is made to carry out, when it names one: an OPEN item on the CALLER's own agenda that the
   * caller raised, neither a gate item nor a notice, and not linked to a card already. Throws the refusal.
   */
  private async requireThread(caller: BoardCaller, named: string | undefined): Promise<AskRef | undefined> {
    if (named === undefined) return undefined;
    const ref = `${ASK_REFERENCE_SIGIL}${named}`;
    if (caller.kind !== 'ferret') {
      throw new BoardError('invalid', `--thread names a thread on a ferret's own asks; ${ref} is not yours to name`);
    }
    const item = await this.ports.threads?.open(caller.ferret, named).catch(() => undefined);
    if (item === undefined) throw new BoardError('invalid', `${ref} is not an open ask of yours`);
    if (item.raisedBy !== 'ferret' || item.raisedByFerret !== caller.ferret) {
      throw new BoardError('invalid', `${ref} is not an ask you raised`);
    }
    if (item.gate || item.notice) {
      throw new BoardError('invalid', `${ref} is not a thread: a gate ask or a notice carries no task`);
    }
    if (item.card !== null) {
      throw new BoardError('invalid', `${ref} is already linked to ${formatTaskRef(item.card)}: one thread, one task`);
    }
    return { ferret: caller.ferret, id: named };
  }

  /** The thread becomes the new card's own: linked, nothing else (the card stays as external as any other). */
  private async linkThread(thread: AskRef | undefined, task: TaskRef): Promise<void> {
    if (thread === undefined || this.ports.threads === undefined) return;
    const linked = await this.ports.threads.link(thread.ferret, thread.id, task).catch(() => undefined);
    if (linked !== undefined && linked.ok) return;
    const why = linked === undefined ? 'its asks could not be read' : linked.message;
    throw new BoardError(
      'invalid',
      `${ASK_REFERENCE_SIGIL}${thread.id} was not linked to the new task, which was created without it: ${why}`,
    );
  }

  /**
   * A refile onto another board is a card arriving there, so it asks what a create asks: a card made where the board
   * is on is not moved onto one that is off unless its parent there is one the ferret holds, or it rests on a Yes.
   */
  private async requireRefileLicence(
    task: Task,
    projectId: BoardProjectId,
    caller: BoardCaller,
    index: BoardIndex,
  ): Promise<void> {
    const parent = task.parent === null ? undefined : index.get(task.parent);
    const held = parent !== undefined && mayDo('adopt', await this.standing(caller, parent)) ? parent : undefined;
    await this.requireLicence(caller, projectId, {
      parent: held,
      carried: task.approval !== undefined,
      cards: [],
    });
  }

  /** Whether a card is still work: neither dropped nor in its board's closed lanes. */
  private async live(task: Task): Promise<boolean> {
    if (task.dropped !== null) return false;
    const laneSet = await this.ports.lanes.laneSet(task.projectId);
    return laneSet !== null && taskCategory(task, new Map([[task.projectId, laneSet]])) !== 'closed';
  }

  /**
   * Whether `ferret` may put a new card under `id`: the card is on this machine, still work, and the session's
   * standing on it admits a child. `fy new` asks it before it makes a helper's card under the card a brief names.
   */
  async mayAdoptUnder(ferret: string, id: TaskId): Promise<boolean> {
    const task = (await this.ports.store.read()).cards.find(each => each.id === id);
    if (task === undefined || !(await this.live(task))) return false;
    return mayDo('adopt', await this.standing({ kind: 'ferret', ferret }, task));
  }

  /** A helper reports to its lead instead of writing the board: the refusal says whom to tell. */
  private async refuseSubFerret(
    caller: BoardCaller,
    doing: string,
    claim?: () => Promise<string | undefined>,
  ): Promise<void> {
    if (caller.kind !== 'ferret') return;
    const directory = this.ports.helpers ?? NO_HELPERS;
    const refusal = await helperRefusal(directory, caller.ferret, doing);
    if (refusal === null) return;
    // A card its lead holds is the helper's to claim: say that instead of sending it back to the lead.
    const command = await claim?.().catch(() => undefined);
    const claimable =
      command === undefined ? null : await helperRefusal(directory, caller.ferret, doing, undefined, command);
    throw new BoardError('forbidden', claimable ?? refusal);
  }

  private requireMachine(): string {
    const machineId = this.ports.machineId();
    if (machineId === undefined) throw new BoardUnavailableError('the daemon identity is not open yet');
    return machineId;
  }

  private async requireLaneSet(projectId: BoardProjectId): Promise<LaneSet> {
    const laneSet = await this.ports.lanes.laneSet(projectId);
    if (laneSet === null) {
      throw new BoardError(
        'no-lane-set',
        'this project has no lanes yet; propose them first with `fy board lanes propose --template <template>`',
      );
    }
    return laneSet;
  }

  /**
   * The board a caller's new card goes on: its session's, where a ferret on the Unfiled board standing in a
   * repository first has that repository registered and its board taken (`ProjectAdoption`). An adoption that
   * fails leaves the card Unfiled, as it would have been.
   */
  private async projectOf(caller: BoardCaller): Promise<BoardProjectId> {
    const session = ferretOf(caller);
    if (session === undefined) return UNFILED_PROJECT_ID;
    const projectId = await this.ports.lanes.projectOf(session);
    if (projectId !== UNFILED_PROJECT_ID || this.ports.adoption === undefined) return projectId;
    const adopted = await this.ports.adoption.adopt(session).catch((error: unknown) => {
      this.ports.diagnostics.warn(
        `could not register the repository of ${session}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });
    return adopted?.projectId ?? projectId;
  }

  private async laneSetsOf(projects: readonly BoardProjectId[]): Promise<LaneSets> {
    const distinct = [...new Set(projects)];
    const found = await Promise.all(
      distinct.map(async project => [project, await this.ports.lanes.laneSet(project)] as const),
    );
    return new Map(found.filter((entry): entry is readonly [BoardProjectId, LaneSet] => entry[1] !== null));
  }

  private async view(snapshot: BoardSnapshot, id: TaskId): Promise<TaskResponse> {
    const task = snapshot.cards.find(candidate => candidate.id === id);
    if (task === undefined) {
      const damaged = snapshot.quarantined.some(entry => entry.id === id);
      throw new BoardError(
        'not-found',
        damaged
          ? `task &${id} is quarantined: its file is damaged and kept as evidence`
          : `there is no task &${id} on this machine`,
      );
    }
    const laneSets = await this.laneSetsOf(snapshot.cards.map(entry => entry.projectId));
    const index = new BoardIndex(snapshot.cards, this.ports.machineId() ?? '');
    // One card derives only what its view reads, never the whole board.
    const derivation = await gatherDerivation(neighbourhoodOf(task, index), index, laneSets, this.ports);
    return { card: deriveView(task, derivation), laneSet: laneSets.get(task.projectId) ?? null };
  }

  /**
   * What follows a committed write: a ferret's write focuses its session on the card (§3.3), and the
   * fleet feed hears `board.changed`, journalled on the writer's session — the card's owner ferret's
   * when the owner or the daemon wrote it, because a feed event always belongs to a session.
   */
  private async afterWrite(
    caller: BoardCaller,
    task: Task,
    projects: readonly BoardProjectId[],
    anchor = false,
  ): Promise<void> {
    if (caller.kind === 'ferret') {
      await this.ports.focus
        .setFocus(caller.ferret, { id: task.id }, task.title, { anchor })
        .catch((error: unknown) => this.warn(`could not focus ${caller.ferret} on ${formatTaskRef(task)}`, error));
    }
    const session = ferretOf(caller) ?? task.owner;
    for (const projectId of projects) {
      await this.ports.changes
        .changed(session, { projectId, taskIds: [task.id] })
        .catch((error: unknown) => this.warn(`could not publish board.changed for ${formatTaskRef(task)}`, error));
    }
    await this.ports.gates
      ?.written(task.id)
      .catch((error: unknown) => this.warn(`could not bring the gate item of ${formatTaskRef(task)} in line`, error));
  }

  /** Tells the card's ferret it was sent back — unless the ferret doing it is who sent it. */
  private async deliverReopen(caller: BoardCaller, outcome: TaskOutcome, task: Task): Promise<void> {
    const reopened = outcome.reopened;
    if (reopened === undefined) return;
    if (caller.kind === 'ferret' && caller.ferret === effectiveAssignee(task)) return;
    await this.ports.reopen
      .reopened({
        task,
        ...reopened,
        by: await actorOf(caller, this.ports.names),
      })
      .catch((error: unknown) => this.warn(`could not deliver the reopen of ${formatTaskRef(task)}`, error));
  }

  /** Tells the card's ferret the owner closed it: only the owner's move into a closed lane from an open one. */
  private async deliverDone(caller: BoardCaller, request: TaskActionRequest, before: Task, after: Task): Promise<void> {
    if (caller.kind !== 'owner' || request.action !== 'move') return;
    const laneSets = await this.laneSetsOf([after.projectId]);
    if (taskCategory(after, laneSets) !== 'closed' || taskCategory(before, laneSets) === 'closed') return;
    await this.ports.done
      .done([{ task: after, by: caller.via === 'admin-token' ? 'admin-token' : 'owner' }])
      .catch((error: unknown) => this.warn(`could not tell the ferret ${formatTaskRef(after)} is done`, error));
  }

  private warn(what: string, error: unknown): void {
    this.ports.diagnostics.warn(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
