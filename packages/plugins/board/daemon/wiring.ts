import type { AskAnswer, AsksApi } from '@ferretry/core-asks/contract';
import type { FerretsApi, SitrepLine } from '@ferretry/core-ferrets/contract';
import { type ConfigFileDef, type KernelPorts, type StateFileDef } from '@ferretry/kernel/contract';
import {
  type BoardChangedEvent,
  type BoardConfig,
  type BoardFileSchema,
  BoardChanged,
  type Card,
  type CardId,
  type CardRef,
  type CardView,
  type CountersFileSchema,
  type FocusFile,
  type SweepFile,
} from '../contract/index.ts';
import type { z } from 'zod';
import {
  AsksCardObligations,
  CARD_SOURCE,
  gateAnswerOf,
  AsksFerretReader,
  AsksOptIn,
  AsksThreads,
} from './adapters/asks.ts';
import { FerretsHelpers, FerretsLiveness, FerretsParents } from './adapters/ferrets.ts';
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
import { HeldMessages } from './adapters/messages.ts';
import { KernelFerretFocus } from './adapters/store/focus-store.ts';
import { KernelCardStore } from './adapters/store/card-store.ts';
import { KernelSweepMemory } from './adapters/store/sweep-memory.ts';
import {
  BoardService,
  BoardSweep,
  CardAskLinks,
  type CardObligations,
  CardStartRefused,
  type DoneNotifier,
  DoneDeliveryLadder,
  type FerretRoster,
  GateItems,
  LivenessActivityDeriver,
  ReopenDeliveryLadder,
  type ReopenNotifier,
  stageGateLanes,
  startOnCard,
  walkLadder,
  rungsOf,
  type StartOnCardPorts,
  type GateBoard,
  type GateCard,
  BoardIndex,
  stillBuilding,
  ownerDelegation,
} from './lib/board/index.ts';
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
  readonly cards: StateFileDef<string, Card>;
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
  /** Decides `card.moving`: the first no wins. */
  readonly moving: (input: {
    card: CardId;
    from: string;
    to: string;
    by: unknown;
  }) => Promise<{ allow: true } | { allow: false; reason: string }>;
  readonly product: string;
  readonly version: string;
  readonly defs: BoardDefs;
}

/** Everything the plugin assembles, so `index.ts` stays a table of what is provided. */
export interface BoardWorld {
  readonly service: BoardService;
  readonly lanes: LaneSetService;
  readonly switches: BoardSwitchService;
  readonly gates: GateItems;
  readonly obligations: CardObligations;
  readonly focus: KernelFerretFocus;
  readonly watch: GithubWatch;
  readonly sweep: BoardSweep;
  readonly start: (
    id: CardId,
    caller: import('./lib/board/index.ts').BoardCaller,
    key?: string,
  ) => ReturnType<typeof startOnCard>;
  readonly proposalAcceptance: import('./lib/lanes/index.ts').LaneProposalAcceptance;
  readonly helpers: FerretsHelpers;
  readonly liveness: FerretsLiveness;
  readonly parents: FerretsParents;
  readonly watchEnabled: () => boolean;
  readonly watchEvery: () => number;
  readonly gateReconcile: () => Promise<void>;
  readonly applyAnswer: (answer: AskAnswer) => Promise<void>;
  readonly sweepTick: () => Promise<void>;
  readonly lines: (ferret: string) => Promise<readonly SitrepLine[]>;
  readonly heldBy: (ferret: string) => Promise<readonly CardView[]>;
}

/** This daemon has no machine identity port yet (GAP); every card is stamped as made here. */
export const LOCAL_MACHINE = 'local';

const KEPT_START_KEYS = 256;

export const assemble = (needs: BoardWiringNeeds): BoardWorld => {
  const { kernel, asks, ferrets, defs } = needs;
  const diagnostics = { warn: (message: string): void => kernel.log.warn(message) };
  const clock = { now: (): string => kernel.clock.now() as string };
  const serial = new KeyedSerial();

  // ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const store = new KernelCardStore(kernel.state, { cards: defs.cards, counters: defs.counters }, serial, diagnostics);
  const focus = new KernelFerretFocus(kernel.state, defs.focus, ferrets, serial);
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

  // The lane service moves cards through the board service, which reads the lane service: bound late.
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

  // ── talking to ferrets: held until Conversation is reachable (see messages.ts) ────────────────────────────────
  const messages = new HeldMessages(diagnostics);
  const reopen: ReopenNotifier = new ReopenDeliveryLadder(messages, diagnostics);
  const done: DoneNotifier = new DoneDeliveryLadder(messages, diagnostics);

  // ── the service ───────────────────────────────────────────────────────────────────────────────────────────────
  const obligations = new AsksCardObligations(asks);
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
  // gates are told after every committed write of a card; bound late for the same reason as the lanes.
  let gateItems: GateItems | undefined;
  const service = new BoardService({
    store,
    lanes,
    parents,
    focus,
    reopen,
    done,
    activity: new LivenessActivityDeriver({ sessions: liveness, clock }),
    liveness,
    asks: new CardAskLinks(new AsksFerretReader(asks), diagnostics, { of: homeOf }),
    changes: {
      changed: async (_ferret: string, event: BoardChangedEvent) => {
        kernel.events.publish(BoardChanged, event);
      },
    },
    clock,
    diagnostics,
    machineId: () => LOCAL_MACHINE,
    serial,
    adoption: { adopt: async (ferret, proposed) => await adoption.adopt(ferret, proposed) },
    helpers,
    optIn,
    threads: new AsksThreads(asks),
    gates: { written: async id => await gateItems?.written(id) },
  });
  board = service;

  // ── gates: the card's entry into a gate lane is an obligation Asks shows; answering it moves the card ─────────
  const gateCard = async (stored: Card, view?: CardView): Promise<GateCard> => {
    const response = await service.card(stored.id);
    const name = (await lanes.project(stored.projectId))?.name;
    const snapshot = await service.snapshot();
    const index = new BoardIndex(snapshot.cards, LOCAL_MACHINE);
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
      const stored = (await service.snapshot()).cards.find(card => card.id === id);
      return stored === undefined ? undefined : await gateCard(stored);
    },
    cards: async () => {
      const { views } = await service.sweepBoard();
      const snapshot = await service.snapshot();
      const byId = new Map(views.map(view => [view.id, view] as const));
      const out: GateCard[] = [];
      for (const stored of snapshot.cards) out.push(await gateCard(stored, byId.get(stored.id)));
      return out;
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
      told: async (card, message, key) => {
        await walkLadder(messages, diagnostics, rungsOf(card), message, key);
      },
    },
    homes: { of: homeOf },
    diagnostics,
  });
  gateItems = gates;

  // ── starting a ferret on a card ───────────────────────────────────────────────────────────────────────────────
  const startResults = new Map<string, import('../contract/index.ts').CardStartResponse>();
  const startPorts: StartOnCardPorts = {
    card: async id => await service.card(id),
    folderOf: async card => (await needs.projects()?.find(card.projectId as never))?.path,
    live: async () => {
      const all = await ferrets.list();
      const out = new Map<string, CardId | null>();
      for (const each of all)
        if (each.state !== 'stopped') out.set(each.id, (await focus.focusOf(each.id))?.id ?? null);
      return out;
    },
    // Ferrets has no `kill_failed` state: a pane that would not stop reads as stopped (GAP).
    stuck: async () => new Map(),
    exclusive: async (id, work) => await serial.run(`board:start:${id}`, work),
    start: async ({ card, folder, name, prompt }) => {
      const started = await ferrets.start({ folder, name, prompt, by: 'board' });
      if (!started.ok) throw new CardStartRefused(started.error.reason);
      const ferret = started.value;
      // The new ferret holds the card from the first turn: assigned as the owner's act, and its focus.
      await service.assignForOwner(
        card.id,
        ferret,
        ownerDelegation(card).held ?? { owner: card.owner, assignee: card.assignee },
      );
      await focus.setFocus(ferret, { id: card.id } as CardRef, card.title, { anchor: true });
      return { ferret, status: 'started' as const };
    },
    recall: key => startResults.get(key),
    remember: (key, result) => {
      startResults.set(key, result);
      if (startResults.size > KEPT_START_KEYS) startResults.delete(startResults.keys().next().value as string);
    },
    stop: async (ferret, reason) => {
      kernel.log.warn(`stopping ferret ${ferret}: ${reason}`);
      await ferrets.stop(ferret as never, 'now');
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
  const watch = githubWatchJob({
    alerts: {
      mode: async ferret => await messages.mode(ferret),
      send: async ferret => {
        throw new Error(`a board alert for ${ferret} was held: Board cannot reach Conversation on this daemon`);
      },
      withheld: async () => undefined,
    },
    surface: {
      snapshot: async () => await service.snapshot(),
      note: async (card, text) => {
        await service.act(card, { action: 'note', text }, { kind: 'daemon' });
      },
      machineId: () => LOCAL_MACHINE,
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
          })) as never,
      },
      copies: new GitSpawnCopies(kernel.spawn, kernel.clock),
      clock,
      diagnostics,
    },
    watcher: {
      board: {
        snapshot: async () => await service.snapshot(),
        recordPullRequests: async (id, update) => await service.recordPullRequests(id, update),
        act: async (id, request, caller) => await service.act(id, request, caller),
      },
      gh: new GhSpawnRunner(kernel.spawn),
      copies: new GitSpawnCopies(kernel.spawn, kernel.clock),
      sessions: {
        cwdOf: async ferret => (await ferrets.get(ferret as never))?.folder ?? null,
      },
      projects: {
        projects: async () =>
          ((await needs.projects()?.list()) ?? []).map(project => ({
            id: project.id,
            name: project.name,
            path: project.path,
          })) as never,
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

  const applyAnswer = async (answer: AskAnswer): Promise<void> => {
    const shaped = await gateAnswerOf(asks, answer);
    if (shaped === undefined) return;
    const outcome = await gates.answer(shaped);
    if (outcome.handled && 'applied' in outcome) await asks.close(answer.ask, 'answered').catch(() => undefined);
    else if (outcome.handled)
      diagnostics.warn(`the answer to ${answer.ask} was not applied: ${outcome.refused.message}`);
  };

  const heldBy = async (ferret: string): Promise<readonly CardView[]> =>
    (await service.board({ ferret, state: 'open', limit: 100 } as never)).cards;

  return {
    service,
    lanes,
    switches,
    gates,
    obligations,
    focus,
    watch,
    sweep,
    start: async (id, caller, key) => await startOnCard(startPorts, id, caller, key),
    proposalAcceptance: new LaneProposalAcceptance(lanes),
    helpers,
    liveness,
    parents,
    watchEnabled: () => kernel.config.file(defs.config)?.github.watch ?? true,
    watchEvery: () => (kernel.config.file(defs.config)?.github.pollSeconds ?? 60) * 1000,
    gateReconcile: async () => {
      await gates.backfill();
      // An answer Asks recorded that this daemon had not yet applied (it stopped between the two) is applied now; one
      // already applied finds its card gone from that gate and moves nothing.
      for (const answer of await asks.answers({ source: CARD_SOURCE })) await applyAnswer(answer);
    },
    applyAnswer,
    sweepTick: async () => {
      await sweep.tick();
      await gates.sweep();
    },
    lines: async ferret =>
      (await heldBy(ferret)).map(card => ({
        kind: 'card' as const,
        text: `${card.title}${card.progress?.now ? `: ${card.progress.now}` : ''}`,
        ref: `&${card.id}`,
      })),
    heldBy,
  };
};
