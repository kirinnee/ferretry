import {
  type BoardActor,
  type BoardChangedEvent,
  type BoardProjectId,
  type BoardQuarantinedCard,
  type BoardTask,
  type BoardTaskId,
  LANE_TEMPLATES,
  type LaneSet,
  type LaneTemplateName,
  type TaskKind,
  type TaskRef,
  taskIdPrefix,
} from '@ferretry/protocol';
import {
  type BoardChangeSink,
  type BoardServiceDependencies,
  type BoardSnapshot,
  type BoardStore,
  type BoardWrite,
  type AgendaLinkSource,
  type LaneSetSource,
  LivenessActivityDeriver,
  type ReopenNotice,
  type ReopenNotifier,
  type SessionFocus,
  type SessionLiveness,
  type SessionLivenessSource,
  type SessionParents,
  type SessionRoster,
} from '../../../src/lib/board/index.ts';

/** An agenda that names no card. */
const NO_ASKS: AgendaLinkSource = { asksFor: async () => new Map() };

export const MACHINE = 'machine-1';
export const NOW = '2026-10-30T10:00:00.000Z';
export const PROJECT = '11111111-1111-4111-8111-111111111111';
export const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222';

/** A lane set from a template, on a project. */
export const lanes = (
  projectId: BoardProjectId = PROJECT,
  template: LaneTemplateName = 'pr-release-verify',
): LaneSet => ({
  projectId,
  version: 1,
  confirmedBy: 'owner',
  proposedBy: 'lead',
  lanes: [...LANE_TEMPLATES[template].lanes],
  variants: LANE_TEMPLATES[template].variants,
});

const ferret = (sessionId: string): BoardActor => ({ kind: 'ferret', sessionId });

/** A stored card: `F1` by ferret `lead`, in Todo, unless told otherwise. */
export const card = (overrides: Partial<BoardTask> = {}): BoardTask => {
  const id = overrides.id ?? 'F1';
  const laneId = overrides.laneId ?? 'todo';
  return {
    v: 1,
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
  readonly cards = new Map<BoardTaskId, BoardTask>();
  readonly writes: BoardTask[] = [];
  private readonly counters = new Map<string, number>();

  constructor(
    cards: readonly BoardTask[] = [],
    readonly quarantined: readonly BoardQuarantinedCard[] = [],
  ) {
    for (const entry of cards) this.cards.set(entry.id, entry);
  }

  async read(): Promise<BoardSnapshot> {
    return { cards: [...this.cards.values()], quarantined: this.quarantined };
  }

  async allocateId(kind: TaskKind): Promise<BoardTaskId> {
    const prefix = taskIdPrefix(kind);
    const highest = Math.max(
      0,
      ...[...this.cards.keys()].filter(id => id.startsWith(prefix)).map(id => Number(id.slice(1))),
    );
    const next = Math.max(this.counters.get(prefix) ?? 0, highest) + 1;
    this.counters.set(prefix, next);
    return `${prefix}${next}`;
  }

  async write<T>(id: BoardTaskId, decide: (current: BoardTask | undefined) => Promise<BoardWrite<T>>): Promise<T> {
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

  async projectOf(sessionId: string): Promise<BoardProjectId> {
    return this.projects.get(sessionId) ?? PROJECT;
  }

  async laneSet(projectId: BoardProjectId): Promise<LaneSet | null> {
    return this.sets.get(projectId) ?? null;
  }
}

/** Lineage from a child → parent map. */
export class FakeParents implements SessionParents {
  constructor(private readonly parents: Readonly<Record<string, string>> = {}) {}

  async parentOf(sessionId: string): Promise<string | undefined> {
    return this.parents[sessionId];
  }
}

/** A session as the activity tests see it: alive, idle at its prompt and focused on nothing, unless told otherwise. */
export const liveSession = (id: string, overrides: Partial<SessionLiveness> = {}): SessionLiveness => ({
  id,
  status: 'running',
  turnState: 'your-turn',
  focusTask: null,
  declaredWait: false,
  ...overrides,
});

/** A roster holding these sessions, plus any held ids that could not be read. */
export const rosterOf = (sessions: readonly SessionLiveness[], unreadable: readonly string[] = []): SessionRoster => ({
  held: new Set([...sessions.map(session => session.id), ...unreadable]),
  sessions: new Map(sessions.map(session => [session.id, session])),
});

/** The sessions the service tests name, every one alive and idle; counts its reads. */
export class FakeSessions implements SessionLivenessSource {
  reads = 0;

  constructor(
    public current: SessionRoster = rosterOf(
      ['lead', 'child', 'grandchild', 'stranger', 'worker'].map(id => liveSession(id)),
    ),
  ) {}

  async roster(): Promise<SessionRoster> {
    this.reads += 1;
    return this.current;
  }
}

export class FakeFocus implements SessionFocus {
  readonly focused = new Map<string, TaskRef>();

  constructor(
    private readonly sessions: ReadonlySet<string> = new Set(['lead', 'child', 'grandchild', 'stranger', 'worker']),
    private readonly failing = false,
  ) {}

  async setFocus(sessionId: string, task: TaskRef): Promise<boolean> {
    if (this.failing) throw new Error('config is read-only');
    if (!this.sessions.has(sessionId)) return false;
    this.focused.set(sessionId, task);
    return true;
  }

  async focusOf(sessionId: string): Promise<TaskRef | null> {
    return this.focused.get(sessionId) ?? null;
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

export class FakeChanges implements BoardChangeSink {
  readonly events: { readonly sessionId: string; readonly event: BoardChangedEvent }[] = [];

  constructor(private readonly failing: unknown = undefined) {}

  async changed(sessionId: string, event: BoardChangedEvent): Promise<void> {
    if (this.failing !== undefined) throw this.failing;
    this.events.push({ sessionId, event });
  }
}

export interface ServiceWorld extends BoardServiceDependencies {
  readonly store: MemoryBoardStore;
  readonly focus: FakeFocus;
  readonly reopen: FakeReopen;
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
    focus: new FakeFocus(),
    reopen: new FakeReopen(),
    activity: new LivenessActivityDeriver({ sessions: new FakeSessions(), clock: { now: () => NOW } }),
    agenda: NO_ASKS,
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
