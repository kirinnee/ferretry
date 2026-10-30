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
  type BoardActor,
  type BoardProjectId,
  type BoardQuery,
  type BoardResponse,
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
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import type { SerialExecutor } from '../ports.ts';
import { type BoardCaller, effectiveAssignee, standingOf } from './authority.ts';
import {
  applyAction,
  type CardOutcome,
  newCard,
  requireLocalCard,
  requireStanding,
  triggerMove,
  withEvent,
} from './card-actions.ts';
import { deriveView, gatherDerivation } from './derive.ts';
import { BoardError, BoardUnavailableError } from './errors.ts';
import { BoardIndex, blockedBy, cardCategory, type LaneSets } from './graph.ts';
import { ancestorsOf } from './lineage.ts';
import type {
  ActivityDeriver,
  AgendaLinkSource,
  BoardChangeSink,
  BoardClock,
  BoardDiagnostics,
  BoardSnapshot,
  BoardStore,
  LaneSetSource,
  ReopenNotifier,
  SessionFocus,
  SessionParents,
} from './ports.ts';
import { countsOf, inScope, pageOf, passesFilters } from './query.ts';
import { doneLane, doneMove, doneNote } from './signal-done.ts';

export interface BoardServiceDependencies {
  readonly store: BoardStore;
  readonly lanes: LaneSetSource;
  readonly parents: SessionParents;
  readonly focus: SessionFocus;
  readonly reopen: ReopenNotifier;
  readonly activity: ActivityDeriver;
  readonly agenda: AgendaLinkSource;
  readonly changes: BoardChangeSink;
  readonly clock: BoardClock;
  readonly diagnostics: BoardDiagnostics;
  /** This daemon's id, once its identity is open; a write before then is refused as unavailable. */
  readonly machineId: () => string | undefined;
  /** The board-wide section dependency writes share. */
  readonly serial: Pick<SerialExecutor, 'run'>;
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

/** The line a reopened card's ferret is told (§2.9). */
export const reopenMessage = (task: Pick<BoardTask, 'id'>, by: BoardActor, reason: string): string =>
  `[reopened ${formatTaskRef(task)} by ${by.kind === 'owner' ? 'owner' : (by.sessionId ?? by.kind)}: ${reason}]`;

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

  /** Every card's view, closed and dropped included, with every board's lanes: the board sweep's one read. */
  async sweepBoard(): Promise<{ readonly views: readonly BoardTaskView[]; readonly laneSets: LaneSets }> {
    const snapshot = await this.ports.store.read();
    const laneSets = await this.laneSetsOf(snapshot.cards.map(card => card.projectId));
    const index = new BoardIndex(snapshot.cards, this.ports.machineId() ?? '');
    const derivation = await gatherDerivation(snapshot.cards, index, laneSets, this.ports);
    return { views: snapshot.cards.map(card => deriveView(card, derivation)), laneSets };
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
    await this.afterWrite(caller, card, [card.projectId]);
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
    if (!(await this.ports.focus.setFocus(spawn.focus, { id: card.id }).catch(() => false))) {
      this.ports.diagnostics.warn(`could not focus ${spawn.focus} on ${formatTaskRef(card)}`);
    }
    return card;
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
      if (!(await this.ports.focus.setFocus((caller as { sessionId: string }).sessionId, { id: card.id }))) {
        throw new BoardError('not-found', 'there is no session to focus');
      }
    }
    if (outcome.task !== null) {
      await this.afterWrite(caller, outcome.task, [...new Set([card.projectId, outcome.task.projectId])]);
      await this.deliverReopen(caller, outcome, outcome.task);
    }
    return await this.view(await this.ports.store.read(), id);
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
   * Moves the cards of the lanes a lane edit removed to the lanes it named (`moves`: removed → kept),
   * after the edited set is stored (U3's `CardRelocator`). Safe to repeat: a card no longer in a removed
   * lane of this project is left alone. The direction of such a move is not defined — its lane is gone —
   * so it is recorded as a daemon move that says why. Returns the cards it moved.
   */
  async relocate(projectId: BoardProjectId, moves: Readonly<Record<string, string>>): Promise<readonly BoardTaskId[]> {
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
            reason: `lane ${current.laneId} was removed from the board`,
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
    const card = requireValidCard(
      newCard(request, {
        id,
        machineId: facts.machineId,
        now: this.ports.clock.now(),
        actor: actorOf(facts.caller),
        standing: facts.caller.kind === 'owner' ? 'owner-human' : 'owner',
        owner: facts.owner,
        projectId: facts.projectId,
        laneSet: facts.laneSet,
        index: facts.index,
      }),
    );
    await this.ports.store.write(id, async current => {
      if (current !== undefined)
        throw new BoardUnavailableError(`the counter issued ${id}, which a card already holds`);
      return { task: card, result: undefined };
    });
    return card;
  }

  private async decide(card: BoardTask, request: BoardTaskActionRequest, caller: BoardCaller): Promise<CardOutcome> {
    const context = await this.context(card, caller);
    const target =
      request.action === 'refile' && request.projectId !== card.projectId
        ? await this.ports.lanes.laneSet(request.projectId)
        : null;
    return applyAction(card, request, context, target);
  }

  private async context(card: BoardTask, caller: BoardCaller) {
    const snapshot = await this.ports.store.read();
    const index = new BoardIndex(snapshot.cards, this.requireMachine());
    const laneSet = await this.requireLaneSet(card.projectId);
    const projects = card.dependsOn.map(dependency => index.get(dependency.task)?.projectId);
    const laneSets = await this.laneSetsOf(
      projects.filter((project): project is BoardProjectId => project !== undefined),
    );
    return {
      now: this.ports.clock.now(),
      actor: actorOf(caller),
      standing: await this.standing(caller, card),
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

  private async projectOf(caller: BoardCaller): Promise<BoardProjectId> {
    const session = sessionOf(caller);
    return session === undefined ? UNFILED_PROJECT_ID : await this.ports.lanes.projectOf(session);
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
    const derivation = await gatherDerivation(snapshot.cards, index, laneSets, this.ports);
    return { task: deriveView(card, derivation), laneSet: laneSets.get(card.projectId) ?? null };
  }

  /**
   * What follows a committed write: a ferret's write focuses its session on the card (§3.3), and the
   * fleet feed hears `board.changed`, journalled on the writer's session — the card's owner ferret's
   * when the owner or the daemon wrote it, because a feed event always belongs to a session.
   */
  private async afterWrite(caller: BoardCaller, task: BoardTask, projects: readonly BoardProjectId[]): Promise<void> {
    if (caller.kind === 'ferret') {
      await this.ports.focus
        .setFocus(caller.sessionId, { id: task.id })
        .catch((error: unknown) => this.warn(`could not focus ${caller.sessionId} on ${formatTaskRef(task)}`, error));
    }
    const session = sessionOf(caller) ?? task.owner;
    for (const projectId of projects) {
      await this.ports.changes
        .changed(session, { projectId, taskIds: [task.id] })
        .catch((error: unknown) => this.warn(`could not publish board.changed for ${formatTaskRef(task)}`, error));
    }
  }

  /** Tells the card's ferret it was sent back — unless the ferret doing it is who sent it. */
  private async deliverReopen(caller: BoardCaller, outcome: CardOutcome, task: BoardTask): Promise<void> {
    const reopened = outcome.reopened;
    if (reopened === undefined) return;
    if (caller.kind === 'ferret' && caller.sessionId === effectiveAssignee(task)) return;
    await this.ports.reopen
      .reopened({ task, ...reopened, by: actorOf(caller) })
      .catch((error: unknown) => this.warn(`could not deliver the reopen of ${formatTaskRef(task)}`, error));
  }

  private warn(what: string, error: unknown): void {
    this.ports.diagnostics.warn(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
