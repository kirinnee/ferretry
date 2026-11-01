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
  type BoardActor,
  type BoardActorVia,
  type BoardProjectId,
  type BoardQuery,
  type BoardReopenAttachments,
  type BoardResponse,
  type BoardSkipRequest,
  type BoardSkipResponse,
  type BoardTask,
  type BoardTaskActionRequest,
  type BoardTaskCreateRequest,
  type BoardTaskId,
  type BoardTaskResponse,
  BoardTaskSchema,
  type BoardTaskView,
  formatTaskRef,
  type Lane,
  type LaneSet,
  type LaneTrigger,
  type TaskKind,
  type TaskRef,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import type { SerialExecutor } from '../ports.ts';
import { NO_SUB_FERRETS, type SubFerretDirectory, subFerretRefusal } from '../sub-ferret/index.ts';
import { type BoardCaller, type BoardStanding, effectiveAssignee, mayHandDown, standingOf } from './authority.ts';
import {
  applyAction,
  type CardContext,
  type CardOutcome,
  newCard,
  requireLocalCard,
  requireStanding,
  triggerMove,
  withEvent,
} from './card-actions.ts';
import { deriveView, gatherDerivation, neighbourhoodOf } from './derive.ts';
import { BoardError, BoardUnavailableError } from './errors.ts';
import { BoardIndex, blockedBy, cardCategory, type LaneSets } from './graph.ts';
import { ancestorsOf } from './lineage.ts';
import { cardAudience, decideAskedBy } from './origin.ts';
import type {
  ActivityDeriver,
  AgendaLinkSource,
  BoardChangeSink,
  BoardClock,
  BoardDiagnostics,
  BoardSnapshot,
  BoardStore,
  LaneSetSource,
  OwnerWords,
  ProjectAdopter,
  BoardAttachmentSource,
  DoneNotifier,
  ReopenNotifier,
  SessionFocus,
  SessionParents,
  DoneNotice,
} from './ports.ts';
import { applyPrUpdate, type PrUpdate, type PrUpdateOutcome } from './pr-cache.ts';
import { countsOf, inScope, pageOf, passesFilters } from './query.ts';
import { doneLane, doneMove, doneNote } from './signal-done.ts';

export interface BoardServiceDependencies {
  readonly store: BoardStore;
  readonly lanes: LaneSetSource;
  readonly parents: SessionParents;
  readonly focus: SessionFocus;
  readonly reopen: ReopenNotifier;
  /** Tells a card's ferret the owner marked it done. */
  readonly done: DoneNotifier;
  readonly activity: ActivityDeriver;
  readonly agenda: AgendaLinkSource;
  readonly changes: BoardChangeSink;
  readonly clock: BoardClock;
  readonly diagnostics: BoardDiagnostics;
  /** This daemon's id, once its identity is open; a write before then is refused as unavailable. */
  readonly machineId: () => string | undefined;
  /** The release this daemon runs when it reads as one; a card whose PR shipped in it is running here. */
  readonly runningVersion?: () => string | null;
  /** The board-wide section dependency writes share. */
  readonly serial: Pick<SerialExecutor, 'run'>;
  /** Moves a ferret on the Unfiled board onto the board of the repository it stands in, at its first card. */
  readonly adoption?: ProjectAdopter;
  /** Who started whom: a sub-ferret may only note and link PRs on its own card. Absent, every caller is a lead. */
  readonly subFerrets?: SubFerretDirectory;
  /** The attachment store, for a move back that carries files. Absent, such a move is refused. */
  readonly attachments?: BoardAttachmentSource;
  /** What the owner said to a session, for deciding whether a card's ask is theirs. Absent, no ask matches. */
  readonly ownerWords?: OwnerWords;
  /**
   * Told after every committed write of a card, by any path (docs/board.md § Gates ask the owner): the gate items
   * follow the card's lane from here. Total in spirit: a failure is a diagnostic, never the write's.
   */
  readonly gates?: CardWriteObserver;
}

/** What follows a card's lane after each write: the gate items (`GateItems`). */
export interface CardWriteObserver {
  written(id: BoardTaskId): Promise<void>;
}

/** What `fy signal done` did to the ferret's focus card. */
export interface SignalDoneOutcome {
  /** The card as written: the note, and the move when there was one. */
  readonly task: BoardTask;
  /** The lane it moved to; `null` when it stayed. */
  readonly moved: Lane | null;
  /** Why a move the rule called for was refused (an owner gate, a blocker); the note was kept. */
  readonly held?: string;
}

/** The serial key every dependency write shares. */
export const DEPENDENCY_SECTION = 'board:dependencies';

/** The line a reopened card's ferret is told (§2.9): a plain sentence, with no tag around it. */
export const reopenMessage = (
  task: Pick<BoardTask, 'id'>,
  by: BoardActor,
  reason: string,
  byVia?: BoardActorVia,
): string => `${formatTaskRef(task)} was reopened by ${reopenerWords(by, byVia)}: ${reason}`;

const reopenerWords = (by: BoardActor, byVia: BoardActorVia | undefined): string => {
  if (by.kind === 'owner') return byVia === 'admin-token' ? ADMIN_TOKEN_ACTOR_WORDS : 'the owner';
  return by.sessionId ?? `the ${by.kind}`;
};

/**
 * The line a card's ferret is told the owner closed it: a plain sentence, with no tag around it. A batch
 * (one ferret's cards closed together) lists them.
 */
export const doneMessage = (
  tasks: readonly Pick<BoardTask, 'id' | 'title'>[],
  by: DoneNotice['by'] = 'owner',
): string => {
  const named = tasks.map(task => `${formatTaskRef(task)} “${task.title}”`);
  const who = by === 'owner' ? 'The owner' : `The${ADMIN_TOKEN_ACTOR_WORDS.slice('the'.length)}`;
  return named.length === 1
    ? `${who} marked ${named[0]} done.`
    : `${who} marked these cards done: ${named.join(', ')}.`;
};

/**
 * How a caller that acts as the owner is recorded beside its actor: `admin-token` for the host's token with no
 * ferret's credential, so no surface shows it as the owner (`BoardActorVia`). Nothing for anyone else.
 */
const viaOf = (caller: BoardCaller): { readonly actorVia?: BoardActorVia } =>
  caller.kind === 'owner' && caller.via === 'admin-token' ? { actorVia: 'admin-token' } : {};

/** The board actor a caller is recorded as. */
export const actorOf = (caller: BoardCaller): BoardActor => {
  if (caller.kind === 'owner') return { kind: 'owner' };
  if (caller.kind === 'ferret') return { kind: 'ferret', sessionId: caller.sessionId };
  return caller.sessionId === undefined ? { kind: 'daemon' } : { kind: 'daemon', sessionId: caller.sessionId };
};

const sessionOf = (caller: BoardCaller): string | undefined => (caller.kind === 'owner' ? undefined : caller.sessionId);

/** Refuses to store a card the protocol would refuse to read back: sizes, counts, coherence. */
const requireValidCard = (task: BoardTask): BoardTask => {
  const parsed = BoardTaskSchema.safeParse(task);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
  throw new BoardError(
    'invalid',
    `that would leave ${formatTaskRef(task)} invalid (${where}${issue?.message ?? 'unknown problem'})`,
  );
};

/**
 * What a sub-ferret may still write: a note on its own card, a PR or branch link, so the PR's facts move the
 * card on their own, and an external trigger it saw happen (a deploy) on the card it is doing, so the card
 * moves as a fact would move it. Authority still decides WHICH card; everything else is its lead's to do.
 */
const subFerretMay = (request: BoardTaskActionRequest): boolean =>
  request.action === 'note' ||
  request.action === 'trigger' ||
  (request.action === 'link' && (request.pr !== undefined || request.branch !== undefined));

const SUB_FERRET_DOING: Readonly<Record<BoardTaskActionRequest['action'], string>> = {
  move: 'move cards',
  focus: 'change which card they work on',
  block: 'block cards',
  unblock: 'unblock cards',
  depend: 'add dependencies to cards',
  undepend: 'remove dependencies from cards',
  drop: 'drop cards',
  reopen: 'reopen cards',
  clarify: 'clarify cards',
  link: 'link a commit or doc to cards',
  assign: 'reassign cards',
  note: 'note on cards',
  edit: 'edit cards',
  file: 'claim files on cards',
  order: 'reorder cards',
  reparent: 'move cards under another card',
  refile: 'refile cards',
  snooze: 'snooze cards',
  trigger: 'report events on cards',
};

const subFerretDoing = (request: BoardTaskActionRequest): string => SUB_FERRET_DOING[request.action];

export class BoardService {
  constructor(private readonly ports: BoardServiceDependencies) {}

  // -------------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------------

  /** One page of a board, or of every board. Closed and dropped cards only when the query asks. */
  async board(query: BoardQuery): Promise<BoardResponse> {
    const snapshot = await this.ports.store.read();
    const laneSets = await this.laneSetsOf([
      ...snapshot.cards.map(card => card.projectId),
      ...(query.project === undefined ? [] : [query.project]),
    ]);
    const index = new BoardIndex(snapshot.cards, this.ports.machineId() ?? '');
    const derivation = await gatherDerivation(snapshot.cards, index, laneSets, this.ports);
    const scoped = snapshot.cards
      .map(card => ({ view: deriveView(card, derivation), category: cardCategory(card, laneSets) }))
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
  async snapshot(): Promise<{ readonly cards: readonly BoardTask[]; readonly laneSets: LaneSets }> {
    const { cards } = await this.ports.store.read();
    return { cards, laneSets: await this.laneSetsOf(cards.map(card => card.projectId)) };
  }

  /** Every card's view, closed and dropped included, with every board's lanes: the board sweep's one read. */
  async sweepBoard(): Promise<{ readonly views: readonly BoardTaskView[]; readonly laneSets: LaneSets }> {
    const snapshot = await this.ports.store.read();
    const laneSets = await this.laneSetsOf(snapshot.cards.map(card => card.projectId));
    const index = new BoardIndex(snapshot.cards, this.ports.machineId() ?? '');
    const derivation = await gatherDerivation(snapshot.cards, index, laneSets, this.ports);
    return { views: snapshot.cards.map(card => deriveView(card, derivation)), laneSets };
  }

  /**
   * Stores who asked for every card that lacks it (a card from before it was stored), by the same rule a new card
   * is decided by, except that a stored creator of kind `owner` proves nothing (a ferret holding the admin token
   * wrote that too). Idempotent; writes no history and does not touch the card's last-touched time. A card that
   * cannot be decided or written is reported and left for the next boot.
   */
  async backfillAskedBy(): Promise<number> {
    const { cards } = await this.ports.store.read();
    let stored = 0;
    for (const { id, askedBy } of cards) {
      if (askedBy !== undefined) continue;
      try {
        const done = await this.ports.store.write(id, async current => {
          if (current === undefined || current.askedBy !== undefined) return { task: null, result: false };
          const next = requireValidCard({ ...current, askedBy: await this.askedByOf(current, false) });
          return { task: next, result: true };
        });
        if (done) stored += 1;
      } catch (error) {
        this.ports.diagnostics.warn(
          `board: could not store who asked for ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return stored;
  }

  /** One card, in full, with its board's lanes. */
  async task(id: BoardTaskId): Promise<BoardTaskResponse> {
    return await this.view(await this.ports.store.read(), id);
  }

  /** The card an old task became: `<session>:<old id>`, as `legacyRef` records it. */
  async taskByLegacyRef(legacyRef: string): Promise<BoardTaskResponse> {
    const snapshot = await this.ports.store.read();
    const card = snapshot.cards.find(candidate => candidate.legacyRef === legacyRef);
    if (card === undefined) throw new BoardError('not-found', `no card came from the old task ${legacyRef}`);
    return await this.view(snapshot, card.id);
  }

  // -------------------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------------------

  /**
   * A new card (§3.1): a counter id, the caller as owner (or the assignee the owner named), the board of
   * the caller's project unless one is named, and the variant's first backlog lane unless one is named.
   */
  async create(request: BoardTaskCreateRequest, caller: BoardCaller): Promise<BoardTaskResponse> {
    await this.refuseSubFerret(caller, 'create cards');
    const machineId = this.requireMachine();
    const owner = sessionOf(caller) ?? request.assignee;
    if (owner === undefined || owner === null) {
      throw new BoardError('invalid', 'a card needs a ferret to own it: name its assignee, who owns it too');
    }
    const projectId = request.projectId ?? (await this.projectOf(caller));
    const laneSet = await this.requireLaneSet(projectId);
    const snapshot = await this.ports.store.read();
    const index = new BoardIndex(snapshot.cards, machineId);
    if (request.parent !== null) {
      const parent = requireLocalCard(index, request.parent, 'parent');
      requireStanding('adopt', await this.standing(caller, parent), parent);
    }
    const id = await this.ports.store.allocateId(request.kind);
    const card = await this.insert(id, request, {
      machineId,
      caller,
      owner,
      projectId,
      laneSet,
      index,
    });
    await this.afterWrite(caller, card, [card.projectId], true);
    return await this.view(await this.ports.store.read(), id);
  }

  /** The next id of a kind from the machine-wide counter, for a card a caller must name before it exists. */
  async reserve(kind: TaskKind): Promise<BoardTaskId> {
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
    id: BoardTaskId,
    request: BoardTaskCreateRequest,
    spawn: { readonly owner: string; readonly by: string; readonly focus: string; readonly projectId: BoardProjectId },
  ): Promise<BoardTask> {
    const machineId = this.requireMachine();
    const laneSet = await this.requireLaneSet(spawn.projectId);
    const index = new BoardIndex((await this.ports.store.read()).cards, machineId);
    if (request.parent !== null) requireLocalCard(index, request.parent, 'parent');
    const caller: BoardCaller = { kind: 'daemon', sessionId: spawn.by };
    const card = await this.insert(id, request, {
      machineId,
      caller,
      owner: spawn.owner,
      projectId: spawn.projectId,
      laneSet,
      index,
    });
    await this.afterWrite(caller, card, [card.projectId]);
    if (
      !(await this.ports.focus.setFocus(spawn.focus, { id: card.id }, card.title, { anchor: true }).catch(() => false))
    ) {
      this.ports.diagnostics.warn(`could not focus ${spawn.focus} on ${formatTaskRef(card)}`);
    }
    return card;
  }

  /**
   * Whether the lead may hand an EXISTING card to a sub-ferret (`fy new --card`): the card is here, not dropped,
   * and the lead may reassign it. Throws the refusal otherwise; changes nothing.
   */
  async requireHandOver(id: BoardTaskId, lead: string): Promise<BoardTask> {
    const machineId = this.requireMachine();
    const card = new BoardIndex((await this.ports.store.read()).cards, machineId).get({ id });
    if (card === undefined)
      throw new BoardError('not-found', `there is no card ${formatTaskRef({ id })} on this machine`);
    if (card.dropped !== null) {
      throw new BoardError(
        'invalid',
        `${formatTaskRef(card)} is dropped; reopen it before you hand it to a sub-ferret`,
      );
    }
    // The assignee may hand it down; the child does not exist yet, and `handOver` proves it is the lead's own.
    const standing = await this.standing({ kind: 'ferret', sessionId: lead }, card);
    if (standing !== 'assignee') requireStanding('assign', standing, card);
    return card;
  }

  /**
   * `fy new --card`, once the sub-ferret's session exists: the lead's existing card is assigned to it — its owner
   * and parent stay — and becomes the session's focus and delegation anchor. Never makes a second card. The
   * assignment is recorded as the lead's; the lead's own focus is not touched.
   */
  async handOver(id: BoardTaskId, lead: string, session: string): Promise<BoardTask> {
    const caller: BoardCaller = { kind: 'ferret', sessionId: lead };
    const outcome = await this.ports.store.write(id, async current => {
      const card = this.requireCard(current, id);
      if (card.dropped !== null) {
        throw new BoardError(
          'invalid',
          `${formatTaskRef(card)} is dropped; reopen it before you hand it to a sub-ferret`,
        );
      }
      const applied = applyAction(
        card,
        { action: 'assign', assignee: session },
        await this.context(card, caller, session),
      );
      const task = requireValidCard(applied.task as BoardTask);
      return { task, result: task };
    });
    await this.afterWrite({ kind: 'daemon', sessionId: lead }, outcome, [outcome.projectId]);
    if (!(await this.ports.focus.setFocus(session, { id }, outcome.title, { anchor: true }).catch(() => false))) {
      this.ports.diagnostics.warn(`could not focus ${session} on ${formatTaskRef(outcome)}`);
    }
    return outcome;
  }

  /**
   * `fy signal done` on the ferret's focus card (§3.1 item 5): the message as the ferret's note, and — still
   * in an `active` lane with no PR — the daemon's automatic `signal.done` move to where the work is checked,
   * with the message as the reason ({@link doneLane}, {@link doneMove}). The note and the move are one
   * write. An owner gate or an unfinished blocker holds the card, keeps the note, and says why in `held`. `null` when the session has no focus card here.
   */
  async signalDone(sessionId: string, message: string | undefined): Promise<SignalDoneOutcome | null> {
    const machineId = this.requireMachine();
    const focus = await this.ports.focus.focusOf(sessionId);
    if (focus === null || (focus.machineId !== undefined && focus.machineId !== machineId)) return null;
    const caller: BoardCaller = { kind: 'ferret', sessionId };
    const outcome = await this.ports.store.write<SignalDoneOutcome | null>(focus.id, async current => {
      if (current === undefined) return { task: null, result: null };
      const context = await this.context(current, caller);
      const noted = applyAction(current, { action: 'note', text: doneNote(message) }, context).task as BoardTask;
      const target = doneLane(current, context.laneSet);
      if (target === null) return { task: requireValidCard(noted), result: { task: noted, moved: null } };
      const blockers = blockedBy(current, context.index, context.laneSets);
      const move = doneMove(noted, target, context.laneSet, blockers, message, {
        now: context.now,
        actor: { kind: 'daemon', sessionId },
      });
      if ('held' in move) {
        return { task: requireValidCard(noted), result: { task: noted, moved: null, held: move.held } };
      }
      const task = requireValidCard(move.task);
      return { task, result: { task, moved: target } };
    });
    if (outcome === null) return null;
    await this.afterWrite(caller, outcome.task, [outcome.task.projectId]);
    return outcome;
  }

  /** One action on one card. */
  async act(id: BoardTaskId, request: BoardTaskActionRequest, caller: BoardCaller): Promise<BoardTaskResponse> {
    // An assign is judged inside the write: a sub-ferret that is the card's assignee may hand it down (`decide`).
    if (!subFerretMay(request) && request.action !== 'assign') {
      await this.refuseSubFerret(caller, subFerretDoing(request));
    }
    if (request.action === 'focus' && caller.kind !== 'ferret') {
      throw new BoardError('invalid', 'focus is for a ferret: it names the card its session works on');
    }
    const write = async () =>
      await this.ports.store.write(id, async current => {
        const card = this.requireCard(current, id);
        const outcome = await this.decide(card, request, caller);
        return { task: outcome.task === null ? null : requireValidCard(outcome.task), result: { card, outcome } };
      });
    const { card, outcome } =
      request.action === 'depend' ? await this.ports.serial.run(DEPENDENCY_SECTION, write) : await write();
    if (request.action === 'focus') {
      if (
        !(await this.ports.focus.setFocus((caller as { sessionId: string }).sessionId, { id: card.id }, card.title, {
          anchor: true,
        }))
      ) {
        throw new BoardError('not-found', 'there is no session to focus');
      }
    }
    if (outcome.task !== null) {
      await this.afterWrite(caller, outcome.task, [...new Set([card.projectId, outcome.task.projectId])]);
      await this.deliverReopen(caller, outcome, outcome.task);
      await this.deliverDone(caller, request, card, outcome.task);
    }
    return await this.view(await this.ports.store.read(), id);
  }

  /**
   * `fy task skip "<why>"` (§3.4): the calling ferret records why its work needs no card — chit-chat, or the
   * owner said not to track it — so the turn-end check stays quiet until it takes one. It is a decision about
   * the ferret's own session, so only a ferret makes it, and only for itself.
   */
  async skip(request: BoardSkipRequest, caller: BoardCaller): Promise<BoardSkipResponse> {
    if (caller.kind !== 'ferret') {
      throw new BoardError('invalid', 'skip is for a ferret: it records why its own session has no card');
    }
    const skip = { reason: request.reason, at: this.ports.clock.now() };
    if (!(await this.ports.focus.skip(caller.sessionId, skip))) {
      throw new BoardError('not-found', 'there is no session to record the skip on');
    }
    return { sessionId: caller.sessionId, skip };
  }

  /**
   * A daemon move on a real signal (work started, PR opened, merged, released; §3.1). Lands in the lane
   * the trigger names for the card's workflow, never backwards. `null` when the card did not move.
   */
  async trigger(
    id: BoardTaskId,
    trigger: LaneTrigger,
    options: { readonly sessionId?: string; readonly reason?: string } = {},
  ): Promise<BoardTaskResponse | null> {
    const caller: BoardCaller =
      options.sessionId === undefined ? { kind: 'daemon' } : { kind: 'daemon', sessionId: options.sessionId };
    const moved = await this.ports.store.write(id, async current => {
      const card = this.requireCard(current, id);
      const context = await this.context(card, caller);
      const next = triggerMove(card, trigger, options.reason, context);
      return { task: next === null ? null : requireValidCard(next), result: next };
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
  async recordPullRequests(id: BoardTaskId, update: PrUpdate): Promise<PrUpdateOutcome> {
    const caller: BoardCaller = { kind: 'daemon' };
    const outcome = await this.ports.store.write(id, async current => {
      const card = this.requireCard(current, id);
      const applied = applyPrUpdate(card, update, await this.context(card, caller));
      const task = applied.task === null ? null : requireValidCard(applied.task);
      return { task, result: { ...applied, task } };
    });
    if (outcome.task !== null) await this.afterWrite(caller, outcome.task, [outcome.task.projectId]);
    return outcome;
  }

  /**
   * Moves the cards of the lanes a lane edit removed to the lanes it named (`moves`: removed → kept),
   * after the edited set is stored (U3's `CardRelocator`). Safe to repeat: a card no longer in a removed
   * lane of this project is left alone. The direction of such a move is not defined — its lane is gone —
   * so it is recorded as a daemon move that says why: `reason`, else that the lane was removed. Returns the
   * cards it moved.
   */
  async relocate(
    projectId: BoardProjectId,
    moves: Readonly<Record<string, string>>,
    reason?: string,
  ): Promise<readonly BoardTaskId[]> {
    const pending = (await this.ports.store.read()).cards.filter(
      card => card.projectId === projectId && moves[card.laneId] !== undefined,
    );
    const moved: BoardTaskId[] = [];
    for (const { id } of pending) {
      const task = await this.ports.store.write(id, async current => {
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
          { now: this.ports.clock.now(), actor: { kind: 'daemon' } },
        );
        const valid = requireValidCard({ ...next, laneId: to });
        return { task: valid, result: valid };
      });
      if (task === null) continue;
      moved.push(task.id);
      await this.afterWrite({ kind: 'daemon' }, task, [projectId]);
    }
    return moved;
  }

  // -------------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------------

  /** Writes a brand-new card under a counter id; the id already holding a card is the counter's fault. */
  /** A new card never fails for want of the owner's words; the backfill lets it, so the card waits for the next boot. */
  private async askedByOf(card: Pick<BoardTask, 'createdBy' | 'ask'>, ownerApp: boolean, lenient = false) {
    return await decideAskedBy(card, ownerApp, async sessionId => {
      try {
        return (await this.ports.ownerWords?.said(sessionId)) ?? [];
      } catch (error) {
        if (!lenient) throw error;
        this.ports.diagnostics.warn(
          `board: could not read what the owner said to ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    });
  }

  private async insert(
    id: BoardTaskId,
    request: BoardTaskCreateRequest,
    facts: {
      readonly machineId: string;
      readonly caller: BoardCaller;
      readonly owner: string;
      readonly projectId: BoardProjectId;
      readonly laneSet: LaneSet;
      readonly index: BoardIndex;
    },
  ): Promise<BoardTask> {
    const made = newCard(request, {
      id,
      machineId: facts.machineId,
      now: this.ports.clock.now(),
      actor: actorOf(facts.caller),
      ...viaOf(facts.caller),
      standing: facts.caller.kind === 'owner' ? 'owner-human' : 'owner',
      owner: facts.owner,
      projectId: facts.projectId,
      laneSet: facts.laneSet,
      index: facts.index,
    });
    const card = requireValidCard({
      ...made,
      askedBy: await this.askedByOf(made, facts.caller.kind === 'owner' && facts.caller.via === undefined, true),
    });
    await this.ports.store.write(id, async current => {
      if (current !== undefined)
        throw new BoardUnavailableError(`the counter issued ${id}, which a card already holds`);
      return { task: card, result: undefined };
    });
    return card;
  }

  private async decide(card: BoardTask, request: BoardTaskActionRequest, caller: BoardCaller): Promise<CardOutcome> {
    // A sub-ferret reports what it saw on the card it is doing, not on others its standing reaches.
    if (request.action === 'trigger' && caller.kind === 'ferret' && caller.sessionId !== effectiveAssignee(card)) {
      await this.refuseSubFerret(caller, 'report events on a card they are not doing');
    }
    const context = await this.context(card, caller, request.action === 'assign' ? request.assignee : undefined);
    if (request.action === 'assign' && context.handsDown !== true) {
      await this.refuseSubFerret(caller, subFerretDoing(request));
    }
    const target =
      request.action === 'refile' && request.projectId !== card.projectId
        ? await this.ports.lanes.laneSet(request.projectId)
        : null;
    const parentStanding =
      request.action === 'reparent' && request.parent !== null
        ? await this.parentStanding(request.parent, caller, context.index)
        : null;
    const attachments =
      (request.action === 'move' || request.action === 'reopen') && request.attachments !== undefined
        ? await this.attachmentsFor(card, request.attachments, context.standing)
        : undefined;
    return applyAction(
      card,
      request,
      attachments === undefined ? context : { ...context, attachments },
      target,
      parentStanding,
    );
  }

  /**
   * The files a move back carries, found where the app uploaded them. They are the OWNER's ("Not good" with a
   * picture), and they must sit in the session of a ferret the reopen is delivered to — the card's assignee or
   * its owner ferret — so a request cannot pull another session's files onto this card.
   */
  private async attachmentsFor(
    card: BoardTask,
    request: BoardReopenAttachments,
    standing: BoardStanding,
  ): Promise<NonNullable<CardContext['attachments']>> {
    const ref = formatTaskRef(card);
    if (standing !== 'owner-human') {
      throw new BoardError('forbidden', `only the owner sends files with a move back of ${ref}`, ['owner-human']);
    }
    if (request.from !== effectiveAssignee(card) && request.from !== card.owner) {
      throw new BoardError(
        'invalid',
        `the files for ${ref} must be uploaded to its ferret (${effectiveAssignee(card)}), not ${request.from}`,
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
  private async context(card: BoardTask, caller: BoardCaller, assignee?: string | null) {
    const snapshot = await this.ports.store.read();
    const index = new BoardIndex(snapshot.cards, this.requireMachine());
    const laneSet = await this.requireLaneSet(card.projectId);
    const projects = card.dependsOn.map(dependency => index.get(dependency.task)?.projectId);
    const laneSets = await this.laneSetsOf(
      projects.filter((project): project is BoardProjectId => project !== undefined),
    );
    const standing = await this.standing(caller, card);
    const handsDown =
      assignee !== undefined &&
      assignee !== null &&
      standing === 'assignee' &&
      mayHandDown(caller, standing, assignee, await ancestorsOf(assignee, this.ports.parents));
    return {
      now: this.ports.clock.now(),
      runningVersion: this.ports.runningVersion?.() ?? null,
      actor: actorOf(caller),
      ...viaOf(caller),
      standing,
      ...(handsDown ? { handsDown } : {}),
      audience: cardAudience(card),
      laneSet,
      index,
      laneSets: new Map([...laneSets, [card.projectId, laneSet]]),
    };
  }

  /** The caller's standing on a card; the owner's lineage is walked only for a ferret that is not it. */
  private async standing(caller: BoardCaller, card: BoardTask) {
    const ancestors =
      caller.kind === 'ferret' && caller.sessionId !== card.owner
        ? await ancestorsOf(card.owner, this.ports.parents)
        : [];
    return standingOf(caller, card, ancestors);
  }

  private requireCard(current: BoardTask | undefined, id: BoardTaskId): BoardTask {
    if (current === undefined) throw new BoardError('not-found', `there is no card &${id} on this machine`);
    return current;
  }

  /** A sub-ferret reports to its lead instead of writing the board: the refusal says whom to tell. */
  private async refuseSubFerret(caller: BoardCaller, doing: string): Promise<void> {
    if (caller.kind !== 'ferret') return;
    const refusal = await subFerretRefusal(this.ports.subFerrets ?? NO_SUB_FERRETS, caller.sessionId, doing);
    if (refusal !== null) throw new BoardError('forbidden', refusal);
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
    const session = sessionOf(caller);
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

  private async view(snapshot: BoardSnapshot, id: BoardTaskId): Promise<BoardTaskResponse> {
    const card = snapshot.cards.find(candidate => candidate.id === id);
    if (card === undefined) {
      const damaged = snapshot.quarantined.some(entry => entry.id === id);
      throw new BoardError(
        'not-found',
        damaged
          ? `card &${id} is quarantined: its file is damaged and kept as evidence`
          : `there is no card &${id} on this machine`,
      );
    }
    const laneSets = await this.laneSetsOf(snapshot.cards.map(entry => entry.projectId));
    const index = new BoardIndex(snapshot.cards, this.ports.machineId() ?? '');
    // One card derives only what its view reads, never the whole board.
    const derivation = await gatherDerivation(
      neighbourhoodOf(card, index),
      index,
      laneSets,
      this.ports,
      snapshot.cards,
    );
    return { task: deriveView(card, derivation), laneSet: laneSets.get(card.projectId) ?? null };
  }

  /**
   * What follows a committed write: a ferret's write focuses its session on the card (§3.3), and the
   * fleet feed hears `board.changed`, journalled on the writer's session — the card's owner ferret's
   * when the owner or the daemon wrote it, because a feed event always belongs to a session.
   */
  private async afterWrite(
    caller: BoardCaller,
    task: BoardTask,
    projects: readonly BoardProjectId[],
    anchor = false,
  ): Promise<void> {
    if (caller.kind === 'ferret') {
      await this.ports.focus
        .setFocus(caller.sessionId, { id: task.id }, task.title, { anchor })
        .catch((error: unknown) => this.warn(`could not focus ${caller.sessionId} on ${formatTaskRef(task)}`, error));
    }
    const session = sessionOf(caller) ?? task.owner;
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
  private async deliverReopen(caller: BoardCaller, outcome: CardOutcome, task: BoardTask): Promise<void> {
    const reopened = outcome.reopened;
    if (reopened === undefined) return;
    if (caller.kind === 'ferret' && caller.sessionId === effectiveAssignee(task)) return;
    await this.ports.reopen
      .reopened({
        task,
        ...reopened,
        by: actorOf(caller),
        ...(viaOf(caller).actorVia === undefined ? {} : { byVia: 'admin-token' as const }),
      })
      .catch((error: unknown) => this.warn(`could not deliver the reopen of ${formatTaskRef(task)}`, error));
  }

  /** Tells the card's ferret the owner closed it: only the owner's move into a closed lane from an open one. */
  private async deliverDone(
    caller: BoardCaller,
    request: BoardTaskActionRequest,
    before: BoardTask,
    after: BoardTask,
  ): Promise<void> {
    if (caller.kind !== 'owner' || request.action !== 'move') return;
    const laneSets = await this.laneSetsOf([after.projectId]);
    if (cardCategory(after, laneSets) !== 'closed' || cardCategory(before, laneSets) === 'closed') return;
    await this.ports.done
      .done([{ task: after, by: caller.via === 'admin-token' ? 'admin-token' : 'owner' }])
      .catch((error: unknown) => this.warn(`could not tell the ferret ${formatTaskRef(after)} is done`, error));
  }

  private warn(what: string, error: unknown): void {
    this.ports.diagnostics.warn(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
