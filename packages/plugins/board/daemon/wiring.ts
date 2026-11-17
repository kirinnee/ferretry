import type { AskAnswer, AsksApi } from '@ferretry/core-asks/contract';
import {
  FerretIdSchema,
  type FerretsApi,
  type FerretStartedPayload,
  PERSON_ORIGIN,
  type SitrepLine,
} from '@ferretry/core-ferrets/contract';
import { ProjectIdSchema } from '@ferretry/plugin-projects/contract';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import type { ConfigFileDef, KernelPorts, StateFileDef } from '@ferretry/kernel/contract';
import {
  type BoardChangedEvent,
  type BoardConfig,
  type BoardFileSchema,
  BoardChanged,
  type Task,
  type TaskId,
  type TaskRef,
  type TaskView,
  type CountersFileSchema,
  type FocusTask,
  type FocusFile,
  type LaneSet,
  type OrphanedTasks,
  BoardQuerySchema,
  parseGateReference,
  type SweepFile,
} from '../contract/index.ts';
import type { z } from 'zod';
import {
  AsksTaskObligations,
  TASK_SOURCE,
  gateAnswerOf,
  AsksTaskAskReader,
  AsksOptIn,
  AsksThreads,
} from './adapters/asks.ts';
import { FerretsHelpers, FerretsLiveness, FerretsNames, FerretsParents } from './adapters/ferrets.ts';
import { GhSpawnRunner, GitSpawnCopies } from './adapters/github.ts';
import {
  BoardFiles,
  BoardSwitchFiles,
  FerretProjectStamps,
  FerretsProjectFacts,
  GitProjectFacts,
  GitRepositoryProbe,
  LaneSetFiles,
  UsedProjects,
  AsksLaneProposals,
} from './adapters/lanes/index.ts';
import { ConversationMessages } from './adapters/messages.ts';
import { ConversationOwnerWords } from './adapters/owner-words.ts';
import { BoardWorkSource } from './adapters/work-source.ts';
import { KernelFerretFocus } from './adapters/store/focus-store.ts';
import { KernelTaskStore } from './adapters/store/task-store.ts';
import { KernelSweepMemory } from './adapters/store/sweep-memory.ts';
import {
  BoardService,
  BoardSweep,
  TaskAskLinks,
  type TaskObligations,
  TaskStartRefused,
  type DoneNotifier,
  DoneDeliveryLadder,
  type FerretRoster,
  GateItems,
  gateTasksOf,
  LivenessActivityDeriver,
  ReopenDeliveryLadder,
  type ReopenNotifier,
  stageGateLanes,
  startOnTask,
  walkLadder,
  rungsOf,
  type StartOnTaskPorts,
  type GateBoard,
  type GateTask,
  BoardError,
  BoardIndex,
  stillBuilding,
  ownerDelegation,
  BoardGateCheck,
  BoardTurnCheck,
  FerretTasks,
  type GateCheckItem,
  type TranscriptEvent,
} from './lib/board/index.ts';
import { prOf } from './lib/board/task-pr.ts';
import { githubWatchJob, type GithubWatch } from './lib/github/index.ts';
import {
  BoardSwitchService,
  FerretBoardResolver,
  FerretProjects,
  InferredLaneProposer,
  KeyedSerial,
  LaneSetService,
  ProjectAdoption,
  expandProjectRoots,
  LaneProposalAcceptance,
} from './lib/lanes/index.ts';

type Counters = z.infer<typeof CountersFileSchema>;

/** The state files and config this half reads, from the manifest's own declarations. */
export interface BoardDefs {
  readonly cards: StateFileDef<string, Task>;
  readonly counters: StateFileDef<string, Counters>;
  readonly boards: StateFileDef<string, z.infer<typeof BoardFileSchema>>;
  readonly sweep: StateFileDef<string, SweepFile>;
  readonly focus: StateFileDef<string, FocusFile>;
  readonly config: ConfigFileDef<BoardConfig>;
}

export interface BoardWiringNeeds {
  readonly kernel: KernelPorts;
  readonly asks: AsksApi;
  readonly ferrets: FerretsApi;
  readonly projects: () => import('@ferretry/plugin-projects/contract').ProjectsApi | undefined;
  /** Conversation, when it is on (optional `uses`, D2 #12): Board's messages, alerts and transcript reads go through it. */
  readonly conversation: () => ConversationApi | undefined;
  /** Decides `card.moving` inside every lane change's write, by any path: the first no wins. */
  readonly moving: NonNullable<import('./lib/board/index.ts').BoardServiceDependencies['moving']>;
  /** Publishes `board.card-moved` once a lane change landed. */
  readonly moved: NonNullable<import('./lib/board/index.ts').BoardServiceDependencies['moved']>;
  readonly product: string;
  readonly version: string;
  readonly defs: BoardDefs;
}

/** Everything the plugin assembles, so `index.ts` stays a table of what is provided. */
export interface BoardWorld {
  readonly service: BoardService;
  /** Board's tasks as work, for Conversation's `search.sources`: `fy search` and `search_work` find them. */
  readonly workSource: BoardWorkSource;
  readonly lanes: LaneSetService;
  readonly switches: BoardSwitchService;
  readonly gates: GateItems;
  readonly obligations: TaskObligations;
  readonly focus: KernelFerretFocus;
  readonly watch: GithubWatch;
  readonly sweep: BoardSweep;
  readonly start: (
    id: TaskId,
    caller: import('./lib/board/index.ts').BoardCaller,
    key?: string,
  ) => ReturnType<typeof startOnTask>;
  readonly proposalAcceptance: import('./lib/lanes/index.ts').LaneProposalAcceptance;
  readonly helpers: FerretsHelpers;
  readonly liveness: FerretsLiveness;
  readonly parents: FerretsParents;
  readonly watchEnabled: () => boolean;
  readonly gateReconcile: (signal?: AbortSignal) => Promise<void>;
  readonly applyAnswer: (answer: AskAnswer) => Promise<'applied' | { readonly refused: string }>;
  readonly sweepTick: (signal?: AbortSignal) => Promise<void>;
  readonly lines: (ferret: string) => Promise<readonly SitrepLine[]>;
  readonly heldBy: (ferret: string) => Promise<readonly TaskView[]>;
  /** The lane set of every project that has a task (`BoardApi.laneSets`). */
  readonly laneSets: () => Promise<readonly LaneSet[]>;
  /** Every open orphaned task with every board's lanes, from one snapshot (`BoardApi.orphanedCards`). */
  readonly orphanedCards: () => Promise<OrphanedTasks>;
  /** The task a ferret works on with its lane set, when it is on this machine (`BoardApi.focusOf`). Not-found is `undefined`. */
  readonly focusCard: (ferret: string) => Promise<FocusTask | undefined>;
  /** `turn.ended` (Conversation): the turn-end check and the gate check, each failure said, never thrown. */
  readonly turnEnded: (ferret: string) => Promise<void>;
  /** `ferret.started` (Ferrets): the started ferret's task (today's `SessionCards`). Never rejects. */
  readonly ferretStarted: (started: FerretStartedPayload) => Promise<void>;
}

/**
 * The machine a task is made on: the daemon's id from the kernel's read-only identity port {daemonId, daemonName}
 * (lead decisions DECISIONS-1 #1, D2 #13; today's `attachmentDaemonId`). GAP: that port is the kernel porter's and is
 * not on 5.0 yet, so until it merges this reads nothing — and a task is then refused ("the daemon identity is not
 * open yet") rather than stamped with a made-up id that a stored task would keep for good. Board stays in
 * `ports-pending.json` until it lands.
 */
export const machineIdOf = (kernel: KernelPorts): string | undefined => {
  const identity = (kernel as KernelPorts & { readonly identity?: { readonly daemonId?: unknown } }).identity;
  return typeof identity?.daemonId === 'string' && identity.daemonId !== '' ? identity.daemonId : undefined;
};

const KEPT_START_KEYS = 256;

/** The labels of the ferrets the daemon starts for itself (today's `ordinaryFerret`): no task is made for them. */
const DAEMON_WORKER_LABELS: ReadonlySet<string> = new Set(['ferretry-learning', 'ferretry-guide-builder']);

export const assemble = (needs: BoardWiringNeeds): BoardWorld => {
  const { kernel, asks, ferrets, defs } = needs;
  const machineId = (): string | undefined => machineIdOf(kernel);
  const diagnostics = { warn: (message: string): void => kernel.log.warn(message) };
  const clock = { now: (): string => kernel.clock.now() as string };
  const serial = new KeyedSerial();

  // ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const store = new KernelTaskStore(kernel.state, { cards: defs.cards, counters: defs.counters }, serial, diagnostics);
  const focus = new KernelFerretFocus(kernel.state, defs.focus, ferrets, serial, diagnostics);
  const sweepMemory = new KernelSweepMemory(kernel.state, defs.sweep, diagnostics);

  // ── ferrets ───────────────────────────────────────────────────────────────────────────────────────────────────
  const parents = new FerretsParents(ferrets);
  const helpers = new FerretsHelpers(ferrets);
  const liveness = new FerretsLiveness(ferrets, focus, serial);

  // ── boards and lanes ──────────────────────────────────────────────────────────────────────────────────────────
  const files = new BoardFiles(kernel.state, defs.boards, serial);
  const stamps = new FerretProjectStamps();
  const facts = new FerretsProjectFacts(ferrets, stamps);
  const probe = new GitRepositoryProbe(kernel.spawn);
  const gitFacts = new GitProjectFacts(kernel.spawn, probe);
  const registry = new UsedProjects(needs.projects);
  const ferretProjects = new FerretProjects(facts, registry, probe, ['/tmp', '/var/tmp', '/private/tmp']);
  const switches = new BoardSwitchService(new BoardSwitchFiles(files), clock);

  // The lane service moves tasks through the board service, which reads the lane service: bound late.
  let board: BoardService | undefined;
  const boardService = (): BoardService => {
    if (board === undefined) throw new Error('the board service is not built yet');
    return board;
  };
  const lanes = new LaneSetService(
    new LaneSetFiles(files),
    registry,
    ferretProjects,
    new AsksLaneProposals(asks),
    {
      relocate: async (project, moves, by) => {
        await boardService().relocate(project, moves, undefined, by);
      },
    },
    parents,
  );
  const proposer = new InferredLaneProposer(lanes, gitFacts);
  const adoption = new ProjectAdoption({
    ferrets: facts,
    repositories: probe,
    registry,
    lanes,
    proposer,
    stamp: stamps,
    places: async () => {
      const config = kernel.config.file(defs.config);
      const roots = (config?.projectRoots ?? []).filter(root => !root.startsWith('~'));
      return {
        projectRoots: expandProjectRoots(roots, '/'),
        home: '/',
        scratchRoots: ['/tmp', '/var/tmp', '/private/tmp'],
      };
    },
    serial,
  });
  const boards = new FerretBoardResolver(facts, ferretProjects, adoption);

  // ── talking to ferrets: through Conversation when it is on, held with a warning when it is off (messages.ts) ───
  const messages = new ConversationMessages(needs.conversation, ferrets, helpers, diagnostics);
  const reopen: ReopenNotifier = new ReopenDeliveryLadder(messages, diagnostics);
  const done: DoneNotifier = new DoneDeliveryLadder(messages, diagnostics);

  // ── the service ───────────────────────────────────────────────────────────────────────────────────────────────
  const obligations = new AsksTaskObligations(asks);
  const optIn = new AsksOptIn(asks).with({
    isOn: async project => await switches.isOn(project),
    nameOf: async project => (await lanes.project(project))?.name ?? project,
  });
  const homeOf = async (ferret: string): Promise<string> => {
    let current = ferret;
    for (let step = 0; step < 16; step += 1) {
      const parent = await parents.parentOf(current);
      if (parent === undefined) return current;
      current = parent;
    }
    return current;
  };
  // gates are told after every committed write of a task; bound late for the same reason as the lanes.
  let gateItems: GateItems | undefined;
  const service = new BoardService({
    store,
    lanes,
    parents,
    names: new FerretsNames(ferrets),
    focus,
    reopen,
    done,
    activity: new LivenessActivityDeriver({ sessions: liveness, clock }),
    liveness,
    asks: new TaskAskLinks(new AsksTaskAskReader(asks), diagnostics),
    changes: {
      changed: async (_ferret: string, event: BoardChangedEvent) => {
        kernel.events.publish(BoardChanged, event);
      },
    },
    clock,
    diagnostics,
    machineId,
    serial,
    adoption: { adopt: async (ferret, proposed) => await adoption.adopt(ferret, proposed) },
    helpers,
    optIn,
    // What the owner said to a ferret, read through Conversation (strict for a ferret's private choice, F-0001).
    ownerWords: new ConversationOwnerWords(needs.conversation),
    threads: new AsksThreads(asks),
    gates: { written: async id => await gateItems?.written(id) },
    moving: needs.moving,
    moved: needs.moved,
  });
  board = service;

  // ── gates: the card's entry into a gate lane is an obligation Asks shows; answering it moves the task ─────────
  const gateTask = async (stored: Task, view?: TaskView): Promise<GateTask> => {
    const response = await service.card(stored.id);
    const name = (await lanes.project(stored.projectId))?.name;
    const snapshot = await service.snapshot();
    const index = new BoardIndex(snapshot.cards, machineId() ?? '');
    return {
      task: stored,
      laneSet: response.laneSet,
      audience: await service.audienceOf(stored),
      blockedBy: (view ?? response.card).blockedBy,
      building: stillBuilding(stored, index, snapshot.laneSets),
      ...(name === undefined ? {} : { projectName: name }),
    };
  };
  const gateBoard: GateBoard = {
    card: async id => {
      const stored = (await service.snapshot()).cards.find(task => task.id === id);
      return stored === undefined ? undefined : await gateTask(stored);
    },
    // One sweep and one snapshot for the whole board; every task is built from them (v4's one-sweep shape), with no
    // per-card derivation.
    cards: async () => {
      const { views, laneSets } = await service.sweepBoard();
      const snapshot = await service.snapshot();
      return await gateTasksOf({
        views,
        cards: snapshot.cards,
        laneSets: snapshot.laneSets.size >= laneSets.size ? snapshot.laneSets : laneSets,
        machineId: machineId() ?? '',
        projectName: async project => (await lanes.project(project))?.name,
        audienceOf: async task => await service.audienceOf(task),
        blockedByOf: async task => (await service.card(task.id)).card.blockedBy,
      });
    },
    act: async (id, request, caller, expect) => {
      await service.act(id, request, caller, expect);
    },
    closeNothingToTry: async (id, expect, reason) => await service.closeWhereNothingToTry(id, expect, reason),
  };
  const gates = new GateItems({
    obligations,
    board: gateBoard,
    lanes: stageGateLanes,
    words: {
      told: async (task, message, key) => {
        await walkLadder(messages, diagnostics, rungsOf(task), message, key);
      },
    },
    homes: { of: homeOf },
    diagnostics,
  });
  gateItems = gates;

  // ── starting a ferret on a task ───────────────────────────────────────────────────────────────────────────────
  const startResults = new Map<string, import('../contract/index.ts').TaskStartResponse>();
  const startPorts: StartOnTaskPorts = {
    card: async id => await service.card(id),
    folderOf: async task => {
      const project = ProjectIdSchema.safeParse(task.projectId);
      return project.success ? (await needs.projects()?.find(project.data))?.path : undefined;
    },
    live: async () => {
      const all = await ferrets.list();
      const out = new Map<string, TaskId | null>();
      for (const each of all)
        if (each.state !== 'stopped') out.set(each.id, (await focus.focusOf(each.id))?.id ?? null);
      return out;
    },
    // Ferrets has no `kill_failed` state: a pane that would not stop reads as stopped (GAP).
    stuck: async () => new Map(),
    exclusive: async (id, work) => await serial.run(`board:start:${id}`, work),
    start: async ({ card: task, folder, name, prompt }) => {
      // Only the owner reaches this (`startOnTask` refuses any other caller before the port is asked), so it is a person's start.
      const started = await ferrets.start({ folder, name, prompt, by: 'board' }, PERSON_ORIGIN);
      if (!started.ok) throw new TaskStartRefused(started.error.reason);
      const ferret = started.value;
      // The new ferret holds the task from the first turn: assigned as the owner's act, and its focus.
      await service.assignForOwner(
        task.id,
        ferret,
        ownerDelegation(task).held ?? { owner: task.owner, assignee: task.assignee },
      );
      await focus.setFocus(ferret, { id: task.id } as TaskRef, task.title, { anchor: true });
      return { ferret, status: 'started' as const };
    },
    recall: key => startResults.get(key),
    remember: (key, result) => {
      startResults.set(key, result);
      if (startResults.size > KEPT_START_KEYS) startResults.delete(startResults.keys().next().value as string);
    },
    stop: async (ferret, reason) => {
      kernel.log.warn(`stopping ferret ${ferret}: ${reason}`);
      await ferrets.stop(FerretIdSchema.parse(ferret), 'now');
    },
    bin: 'fy',
  };

  // ── the GitHub watch and the sweep ────────────────────────────────────────────────────────────────────────────
  let seed = kernel.clock.nowMs() % 2147483647 || 1;
  const random = (): number => {
    seed = (seed * 48271) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const roster = async (): Promise<FerretRoster> => await liveness.roster();
  // ONE working-copies instance for the refile and the watcher, so a refile inside a tick reuses that tick's answers.
  const workingCopies = new GitSpawnCopies(kernel.spawn, kernel.clock);
  const watch = githubWatchJob({
    alerts: {
      mode: async ferret => await messages.mode(ferret),
      send: async (ferret, message) => {
        await messages.send(ferret, message, `board-alert-${kernel.ids.mint('alert')}`);
      },
      withheld: async (ferret, message) => await messages.withheld(ferret, message),
    },
    surface: {
      snapshot: async () => await service.snapshot(),
      note: async (task, text) => {
        await service.act(task, { action: 'note', text }, { kind: 'daemon' });
      },
      machineId,
    },
    roster,
    helpers,
    refiler: {
      board: {
        snapshot: async () => await service.snapshot(),
        act: async (id, request, caller) => await service.act(id, request, caller),
      },
      sessions: boards,
      lanes: {
        laneSet: async project => await lanes.laneSet(project),
        propose: async (project, ferret) => await proposer.propose(project, ferret),
      },
      projects: {
        projects: async () =>
          ((await needs.projects()?.list()) ?? []).map(project => ({
            id: project.id,
            name: project.name,
            path: project.path,
          })),
      },
      copies: workingCopies,
      clock,
      diagnostics,
    },
    watcher: {
      board: {
        snapshot: async () => await service.snapshot(),
        recordPullRequests: async (id, update) => await service.recordPullRequests(id, update),
        act: async (id, request, caller) => await service.act(id, request, caller),
      },
      gh: new GhSpawnRunner(kernel.spawn, kernel.clock),
      copies: workingCopies,
      sessions: {
        cwdOf: async ferret => {
          const id = FerretIdSchema.safeParse(ferret);
          return id.success ? ((await ferrets.get(id.data))?.folder ?? null) : null;
        },
      },
      projects: {
        projects: async () =>
          ((await needs.projects()?.list()) ?? []).map(project => ({
            id: project.id,
            name: project.name,
            path: project.path,
          })),
      },
      transcripts: messages,
      version: needs.version,
    },
    clock: { now: clock.now, random },
    diagnostics,
  });

  const sweep = new BoardSweep({
    board: service,
    sessions: liveness,
    guard: liveness,
    memory: sweepMemory,
    nudges: {
      send: async (ferret, message) => {
        await watch.alerts.send(ferret, message);
      },
    },
    clock,
    diagnostics,
  });

  // ── the turn-end checks (Conversation's `turn.ended`; today's fyd.ts:10727-10783) ─────────────────────────────
  const tailEvents = async (ferret: string, limit: number): Promise<readonly TranscriptEvent[]> => {
    const read = await messages.tail(ferret, limit);
    return read.kind === 'read' ? read.events : [];
  };
  const boardOn = async (ferret: string): Promise<boolean> => await switches.isOn(await lanes.projectOf(ferret));
  const readable = async (): Promise<boolean> => needs.conversation() !== undefined;
  const checkSend = async (ferret: string, sendId: string, message: string): Promise<void> => {
    await messages.send(ferret, message, sendId);
  };
  const turnCheck = new BoardTurnCheck(
    {
      readable,
      boardOn,
      tail: tailEvents,
      focus: {
        focusOf: async ferret => await focus.focusOf(ferret),
        skipOf: async ferret => await focus.skipOf(ferret),
      },
      card: async ref => await service.card(ref.id),
      send: checkSend,
      // GAP: Conversation offers no journal write, so the nudge is logged, not journalled on the ferret.
      record: async (ferret, seen) => kernel.log.info(`board check nudged ${ferret} after: ${seen.join(', ')}`),
      now: () => kernel.clock.nowMs(),
    },
    'fy',
  );
  const gateCheck = new BoardGateCheck(
    {
      readable,
      boardOn,
      tail: tailEvents,
      // GAP: Asks' summary carries no task for a ferret's own ask, so a duplicate of a task's gate ask is not found.
      open: async ferret =>
        (await asks.open({ ferret: FerretIdSchema.parse(ferret), state: 'open' })).map(
          (ask): GateCheckItem => ({
            id: ask.id,
            raisedBy: ask.raisedBy.kind === 'owner' ? 'human' : ask.raisedBy.kind === 'ferret' ? 'agent' : 'daemon',
            card: null,
            waitingSince: ask.raisedAt,
            notice: ask.kind === 'notice',
            gateOf:
              ask.source === TASK_SOURCE
                ? [parseGateReference(ask.entry)?.cardId].flatMap(id => (id === undefined ? [] : [id]))
                : [],
          }),
        ),
      card: async ref => await service.card(ref.id),
      send: checkSend,
      record: async (ferret, items) => kernel.log.info(`board gate check told ${ferret} about ${items.join(', ')}`),
    },
    'fy',
  );
  const turnEnded = async (ferret: string): Promise<void> => {
    for (const [name, check] of [
      ['turn', turnCheck],
      ['gate', gateCheck],
    ] as const)
      await check
        .check(ferret)
        .catch((error: unknown) => diagnostics.warn(`the board ${name} check of ${ferret} failed: ${String(error)}`));
  };

  // ── a started ferret's task (Ferrets' `ferret.started`; today's SessionCards) ───────────────────────────────
  const ferretTasks = new FerretTasks({
    board: service,
    lanes,
    starts: {
      projectForStart: async start =>
        await ferretProjects.projectForStart({
          folder: start.cwd,
          ...(start.parent === undefined ? {} : { parent: start.parent }),
        }),
    },
    switches,
    proposer,
    adoption,
    projects: { nameOf: async project => (await lanes.project(project))?.name ?? project },
    focus,
    diagnostics,
    bin: 'fy',
  });
  const ferretStarted = async (started: FerretStartedPayload): Promise<void> => {
    // The board's own start assigned its task already; a daemon worker (a learning miner, a guide builder) is not work
    // on a board. GAP: a warden's lineage is not in the payload, so a warden's helper is not told apart.
    if (started.by === 'board' || (started.label !== undefined && DAEMON_WORKER_LABELS.has(started.label))) return;
    try {
      if (started.card !== undefined) {
        // `--task`: handed over, or the ferret is stopped with the reason (today refused it before the launch; the
        // observe hook runs once the record is written, so the stop comes just after).
        const stop = async (reason: string): Promise<void> => {
          diagnostics.warn(`stopping ${started.ferret}: ${reason}`);
          await ferrets.stop(started.ferret, 'now', reason);
        };
        const handed = await ferretTasks.startOn(started.parent, started.card as TaskId);
        if (handed.delegation === undefined)
          return await stop(handed.refusal ?? `task ${started.card} cannot be handed over`);
        await ferretTasks.takeOver(handed.delegation, started.ferret, stop);
        return;
      }
      if (started.brief === undefined) return;
      const opened = await ferretTasks.open({
        ferret: started.ferret,
        name: started.name,
        brief: started.brief,
        parent: started.parent,
        ...(started.by === 'pack' ? { viaPack: true as const } : {}),
      });
      for (const note of opened.notes) kernel.log.info(`${started.ferret}: ${note}`);
    } catch (error) {
      diagnostics.warn(`the task of ${started.ferret} could not be made: ${String(error)}`);
    }
  };

  /**
   * Asks calls this BEFORE it records the answer (#1552: the task moves first): a refusal leaves the ask open and is the
   * sentence the owner is told. A replay finds the task gone from that gate and moves nothing.
   */
  const applyAnswer = async (answer: AskAnswer): Promise<'applied' | { readonly refused: string }> => {
    const shaped = await gateAnswerOf(asks, answer);
    if (shaped === undefined) return { refused: 'that question can no longer be read, so nothing was moved' };
    const outcome = await gates.answer(shaped);
    // An answer to a `card` entry that is not a gate's moved nothing: it is refused, so Asks keeps the ask open.
    if (!outcome.handled) return { refused: 'that question is not a task’s gate, so nothing was moved' };
    if ('applied' in outcome) return 'applied';
    return { refused: outcome.refused.message };
  };

  const heldBy = async (ferret: string): Promise<readonly TaskView[]> =>
    (await service.board(BoardQuerySchema.parse({ ferret, state: 'open', limit: 100 }))).cards;

  return {
    service,
    workSource: new BoardWorkSource(service),
    lanes,
    switches,
    gates,
    obligations,
    focus,
    watch,
    sweep,
    start: async (id, caller, key) => await startOnTask(startPorts, id, caller, key),
    proposalAcceptance: new LaneProposalAcceptance(lanes),
    helpers,
    liveness,
    parents,
    watchEnabled: () => kernel.config.file(defs.config)?.github.watch ?? true,
    gateReconcile: async signal => {
      await gates.backfill(signal);
    },
    applyAnswer,
    sweepTick: async signal => {
      await sweep.tick(signal);
      await gates.sweep(signal);
    },
    lines: async ferret => {
      const held = await heldBy(ferret);
      if (held.length === 0) return [];
      const { laneSets } = await service.snapshot();
      return held.map(task => {
        const lane = laneSets.get(task.projectId)?.lanes.find(candidate => candidate.id === task.laneId)?.name;
        const pr = prOf(task.links.prs);
        return {
          kind: 'card' as const,
          text: `${task.title}${task.progress?.now ? `: ${task.progress.now}` : ''}`,
          ref: `&${task.id}`,
          ...(lane === undefined ? {} : { lane }),
          ...(pr === undefined ? {} : { pr }),
        };
      });
    },
    heldBy,
    laneSets: async () => [...(await service.snapshot()).laneSets.values()],
    orphanedCards: async () => {
      const { views, laneSets } = await service.orphanedCards();
      return { cards: views, laneSets: [...laneSets.values()] };
    },
    focusCard: async ferret => {
      const ref = await focus.focusOf(ferret);
      if (ref === null) return undefined;
      // A task of another machine is not answered here: its id means nothing in this store (today's guard).
      if (ref.machineId !== undefined && ref.machineId !== machineId()) return undefined;
      try {
        return await service.card(ref.id);
      } catch (error) {
        if (error instanceof BoardError && error.code === 'not-found') return undefined;
        throw error;
      }
    },
    turnEnded,
    ferretStarted,
  };
};
