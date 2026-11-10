import {
  type CardActor,
  type BoardChangedEvent,
  type BoardProjectId,
  type BoardQuarantinedCard,
  type BoardSkip,
  type Card,
  type CardId,
  defaultLaneTargets,
  LANE_TEMPLATES,
  type Lane,
  type LaneSet,
  type LaneTemplateName,
  type CardKind,
  type CardRef,
  WorkflowSchema,
  cardIdPrefix,
} from '../../contract/index.ts';
import {
  type CardAskLinkSource,
  type HelperDirectory,
  type BoardChangeSink,
  type BoardServiceDependencies,
  type BoardSnapshot,
  type BoardStore,
  type BoardWrite,
  type DoneNotice,
  type DoneNotifier,
  type LaneSetSource,
  LivenessActivityDeriver,
  type ReopenNotice,
  type ReopenNotifier,
  type FerretFocus,
  type FerretLiveness,
  type FerretLivenessSource,
  type FerretNames,
  type FerretParents,
  type FerretRoster,
} from '../../daemon/lib/board/index.ts';

/** An agenda that names no card. */
const NO_ASKS: CardAskLinkSource = { asksFor: async () => new Map() };

export const MACHINE = 'machine-1';
export const NOW = '2026-10-30T10:00:00.000Z';
export const PROJECT = '11111111-1111-4111-8111-111111111111';
export const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222';

// The PR templates as they were before board v3 folded Review/CI into In progress and merged Released with
// To test. Boards stored before then, and hand-made ones, still have these lanes, and every rule (a review
// lane, `release.running`) still runs over them, so the engine's tests keep exercising them here.
const todo: Lane = { id: 'todo', name: 'Todo', category: 'backlog', staleAfter: '3d' };
const plan: Lane = {
  id: 'plan',
  name: 'Plan/Design',
  category: 'active',
  enterOn: ['work.started'],
  ownerGate: true,
  staleAfter: '2h',
};
const implement: Lane = {
  id: 'implement',
  name: 'Implement',
  category: 'active',
  enterOn: ['work.started'],
  staleAfter: '2h',
};
const review: Lane = {
  id: 'review',
  name: 'Review/CI',
  category: 'review',
  enterOn: ['pr.opened', 'pr.ready', 'signal.done'],
  staleAfter: '24h',
};
const merged: Lane = { id: 'merged', name: 'Merged', category: 'shipped', enterOn: ['pr.merged'], staleAfter: '3d' };
const released: Lane = { id: 'released', name: 'Released', category: 'shipped', enterOn: ['release.published'] };
const tested: Lane = {
  id: 'tested',
  name: 'To test',
  category: 'verify',
  enterOn: ['release.running'],
  ownerGate: true,
};
const closed: Lane = { id: 'closed', name: 'Closed', category: 'closed', ownerGate: true };

const classicVariants = (layout: readonly Lane[]): LaneSet['variants'] => {
  const ids = layout.map(lane => lane.id);
  return {
    ...Object.fromEntries(WorkflowSchema.options.map(workflow => [workflow, [...ids]])),
    quick: ids.filter(id => id !== 'plan'),
  };
};

const classic = (layout: readonly Lane[]): Pick<LaneSet, 'lanes' | 'variants'> => ({
  lanes: [...layout],
  variants: classicVariants(layout),
});

/** The pre-v3 layouts of the PR templates, by the template's name. */
const CLASSIC_LAYOUTS = {
  'pr-release-verify': classic([todo, plan, implement, review, merged, released, tested, closed]),
  'pr-release': classic([
    todo,
    plan,
    implement,
    review,
    merged,
    { id: 'released', name: 'Released', category: 'closed', enterOn: ['release.published'] },
  ]),
  pr: classic([
    todo,
    plan,
    implement,
    review,
    { id: 'merged', name: 'Merged', category: 'closed', enterOn: ['pr.merged'] },
  ]),
} as const satisfies Partial<Record<LaneTemplateName, Pick<LaneSet, 'lanes' | 'variants'>>>;

/** A lane set from the live template, on a project. */
export const templateLanes = (
  projectId: BoardProjectId = PROJECT,
  template: LaneTemplateName = 'pr-release-verify',
): LaneSet => ({
  projectId,
  version: 1,
  confirmedBy: 'owner',
  proposedBy: 'lead',
  ...LANE_TEMPLATES[template],
  lanes: [...LANE_TEMPLATES[template].lanes],
});

/**
 * A lane set on a project: the PR templates in their pre-v3 shape ({@link CLASSIC_LAYOUTS}, Review/CI and To
 * test included), every other template as it ships. {@link templateLanes} is the live template.
 */
export const lanes = (
  projectId: BoardProjectId = PROJECT,
  template: LaneTemplateName = 'pr-release-verify',
): LaneSet => {
  const layout = template in CLASSIC_LAYOUTS ? CLASSIC_LAYOUTS[template as keyof typeof CLASSIC_LAYOUTS] : undefined;
  if (layout === undefined) return templateLanes(projectId, template);
  const targets = defaultLaneTargets(layout.lanes);
  if (targets === undefined) throw new Error(`the classic ${template} layout has no Done or Not good lane`);
  return { projectId, version: 1, confirmedBy: 'owner', proposedBy: 'lead', ...layout, ...targets };
};

/** The names fake every world uses: a ferret is named by its id, so a recorded actor is predictable. */
export const NAMES: FerretNames = { nameOf: async ferret => ferret };

/** A ferret as a card records it, named as {@link NAMES} names it. */
export const ferretActor = (ferret: string): Extract<CardActor, { kind: 'ferret' }> => ({
  kind: 'ferret',
  name: ferret,
  ferret,
});

const ferret = ferretActor;

/** A stored card: `F1` by ferret `lead`, in Todo, unless told otherwise. */
export const card = (overrides: Partial<Card> = {}): Card => {
  const id = overrides.id ?? 'F1';
  const laneId = overrides.laneId ?? 'todo';
  return {
    format: 1,
    id,
    machineId: MACHINE,
    projectId: PROJECT,
    laneId,
    kind: 'feature',
    title: 'Board store',
    summary: '',
    ask: { text: 'build the board', source: 'owner' },
    clarifications: [],
    premise: '',
    context: '',
    terms: [],
    brief: '',
    howToTest: '',
    owner: 'lead',
    assignee: null,
    parent: null,
    dependsOn: [],
    blocked: null,
    dropped: null,
    workflow: 'design-first',
    links: { prs: [], branch: null, commits: [], docs: [] },
    files: [],
    order: null,
    createdAt: NOW,
    createdBy: ferret('lead'),
    history: [{ seq: 1, at: NOW, actor: ferret('lead'), type: 'created', laneId }],
    ...overrides,
  };
};

/** A store in memory with the port's contract: per-id writes, quarantine refusals, a counter. */
export class MemoryBoardStore implements BoardStore {
  readonly cards = new Map<CardId, Card>();
  readonly writes: Card[] = [];
  private readonly counters = new Map<string, number>();

  constructor(
    cards: readonly Card[] = [],
    readonly quarantined: readonly BoardQuarantinedCard[] = [],
  ) {
    for (const entry of cards) this.cards.set(entry.id, entry);
  }

  async read(): Promise<BoardSnapshot> {
    return { cards: [...this.cards.values()], quarantined: this.quarantined };
  }

  async allocateId(kind: CardKind): Promise<CardId> {
    const prefix = cardIdPrefix(kind);
    const highest = Math.max(
      0,
      ...[...this.cards.keys()].filter(id => id.startsWith(prefix)).map(id => Number(id.slice(1))),
    );
    const next = Math.max(this.counters.get(prefix) ?? 0, highest) + 1;
    this.counters.set(prefix, next);
    return `${prefix}${next}`;
  }

  async write<T>(id: CardId, decide: (current: Card | undefined) => Promise<BoardWrite<T>>): Promise<T> {
    const decision = await decide(this.cards.get(id));
    if (decision.task !== null) {
      this.cards.set(id, decision.task);
      this.writes.push(decision.task);
    }
    return decision.result;
  }
}

/** Lanes for every project, unless the project is in `missing`. */
export class FakeLanes implements LaneSetSource {
  constructor(
    private readonly sets: ReadonlyMap<BoardProjectId, LaneSet> = new Map([
      [PROJECT, lanes(PROJECT)],
      [OTHER_PROJECT, lanes(OTHER_PROJECT, 'pr')],
    ]),
    private readonly projects: ReadonlyMap<string, BoardProjectId> = new Map(),
  ) {}

  async projectOf(ferret: string): Promise<BoardProjectId> {
    return this.projects.get(ferret) ?? PROJECT;
  }

  async laneSet(projectId: BoardProjectId): Promise<LaneSet | null> {
    return this.sets.get(projectId) ?? null;
  }
}

/** Lineage from a child → parent map. */
export class FakeParents implements FerretParents {
  constructor(private readonly parents: Readonly<Record<string, string>> = {}) {}

  async parentOf(ferret: string): Promise<string | undefined> {
    return this.parents[ferret];
  }
}

/** A session as the activity tests see it: alive, idle at its prompt and focused on nothing, unless told otherwise. */
export const liveSession = (id: string, overrides: Partial<FerretLiveness> = {}): FerretLiveness => ({
  id,
  status: 'idle',
  turnState: 'your-turn',
  focusCard: null,
  declaredWait: false,
  configRead: true,
  ...overrides,
});

/** A roster holding these sessions, plus any held ids that could not be read. */
export const rosterOf = (sessions: readonly FerretLiveness[], unreadable: readonly string[] = []): FerretRoster => ({
  held: new Set([...sessions.map(session => session.id), ...unreadable]),
  sessions: new Map(sessions.map(session => [session.id, session])),
});

/** The sessions the service tests name, every one alive and idle; counts its reads. */
export class FakeSessions implements FerretLivenessSource {
  reads = 0;

  constructor(
    public current: FerretRoster = rosterOf(
      ['lead', 'child', 'grandchild', 'stranger', 'worker'].map(id => liveSession(id)),
    ),
  ) {}

  async roster(): Promise<FerretRoster> {
    this.reads += 1;
    return this.current;
  }

  /** Every set of sessions a commit asked to hold, in order. */
  readonly holds: (readonly string[])[] = [];

  async settled<T>(ids: readonly string[], work: (fresh: FerretRoster) => Promise<T>): Promise<T> {
    this.holds.push(ids);
    return await work(this.current);
  }
}

export class FakeFocus implements FerretFocus {
  readonly focused = new Map<string, CardRef>();
  readonly anchors = new Map<string, CardRef>();
  readonly skips = new Map<string, BoardSkip>();

  constructor(
    private readonly sessions: ReadonlySet<string> = new Set(['lead', 'child', 'grandchild', 'stranger', 'worker']),
    private readonly failing = false,
  ) {}

  async setFocus(
    ferret: string,
    task: CardRef,
    _title?: string,
    options: { readonly anchor?: boolean } = {},
  ): Promise<boolean> {
    if (this.failing) throw new Error('config is read-only');
    if (!this.sessions.has(ferret)) return false;
    this.focused.set(ferret, task);
    if (options.anchor === true) this.anchors.set(ferret, task);
    this.skips.delete(ferret);
    return true;
  }

  async focusOf(ferret: string): Promise<CardRef | null> {
    return this.focused.get(ferret) ?? null;
  }

  async focusOfAll(): Promise<ReadonlyMap<string, CardRef | null>> {
    return new Map(this.focused);
  }

  async anchorOf(ferret: string): Promise<CardRef | null> {
    return this.anchors.get(ferret) ?? null;
  }

  async skip(ferret: string, skip: BoardSkip): Promise<boolean> {
    if (this.failing) throw new Error('config is read-only');
    if (!this.sessions.has(ferret)) return false;
    this.skips.set(ferret, skip);
    return true;
  }

  async skipOf(ferret: string): Promise<BoardSkip | null> {
    return this.skips.get(ferret) ?? null;
  }
}

export class FakeReopen implements ReopenNotifier {
  readonly notices: ReopenNotice[] = [];

  constructor(private readonly failing = false) {}

  async reopened(notice: ReopenNotice): Promise<void> {
    if (this.failing) throw new Error('nobody to tell');
    this.notices.push(notice);
  }
}

export class FakeDone implements DoneNotifier {
  readonly notices: DoneNotice[] = [];

  constructor(private readonly failing = false) {}

  async done(notices: readonly DoneNotice[]): Promise<void> {
    if (this.failing) throw new Error('nobody to tell');
    this.notices.push(...notices);
  }
}

export class FakeChanges implements BoardChangeSink {
  readonly events: { readonly ferret: string; readonly event: BoardChangedEvent }[] = [];

  constructor(private readonly failing: unknown = undefined) {}

  async changed(ferret: string, event: BoardChangedEvent): Promise<void> {
    if (this.failing !== undefined) throw this.failing;
    this.events.push({ ferret, event });
  }
}

export interface ServiceWorld extends BoardServiceDependencies {
  readonly store: MemoryBoardStore;
  readonly focus: FakeFocus;
  readonly reopen: FakeReopen;
  readonly done: FakeDone;
  readonly changes: FakeChanges;
  readonly warnings: string[];
  readonly sections: string[];
}

/** Every port the service takes, as a fake, with any of them swapped. */
export const world = (overrides: Partial<ServiceWorld> = {}): ServiceWorld => {
  const warnings: string[] = [];
  const sections: string[] = [];
  return {
    store: new MemoryBoardStore(),
    lanes: new FakeLanes(),
    parents: new FakeParents({ child: 'lead', grandchild: 'child' }),
    names: NAMES,
    focus: new FakeFocus(),
    reopen: new FakeReopen(),
    done: new FakeDone(),
    activity: new LivenessActivityDeriver({ sessions: new FakeSessions(), clock: { now: () => NOW } }),
    asks: NO_ASKS,
    changes: new FakeChanges(),
    clock: { now: () => NOW },
    diagnostics: { warn: message => warnings.push(message) },
    machineId: () => MACHINE,
    serial: {
      run: async (key, work) => {
        sections.push(key);
        return await work();
      },
    },
    warnings,
    sections,
    ...overrides,
  };
};

/** The `quick` lanes as they were stored before To test: Todo → Doing → Closed, closing on `signal.done`. */
export const oldQuickLanes = (projectId: BoardProjectId = PROJECT): LaneSet => ({
  projectId,
  version: 1,
  confirmedBy: 'owner',
  proposedBy: 'ferretry',
  lanes: [
    { id: 'todo', name: 'Todo', category: 'backlog', staleAfter: '3d', emphasis: 'progress' },
    { id: 'doing', name: 'Doing', category: 'active', enterOn: ['work.started'], staleAfter: '2h' },
    { id: 'closed', name: 'Closed', category: 'closed', enterOn: ['signal.done'], emphasis: 'info' },
  ],
  variants: Object.fromEntries(WorkflowSchema.options.map(workflow => [workflow, ['todo', 'doing', 'closed']])),
  doneLane: 'closed',
  notGoodLane: 'doing',
});

/** `child` and `grandchild` are helpers; `lead` (callsign `lizzette`) and `stranger` are leads. */
export const DIRECTORY: HelperDirectory = {
  leadOf: async ferret => ({ child: 'lead', grandchild: 'child' })[ferret],
  addressOf: async ferret => (ferret === 'lead' ? 'lizzette' : ferret),
};
