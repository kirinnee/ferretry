import { describe, it } from 'bun:test';
import type { BoardImportSummary, BoardProjectId, BoardTask, LaneSet, TaskKind } from '@ferretry/protocol';
import should from 'should';
import type { BoardSnapshot } from '../../../src/lib/board/index.ts';
import {
  type AskLink,
  BoardImporter,
  type BoardImporterPorts,
  type ImportAgenda,
  type ImportProjects,
  type ImportSessions,
  type LegacySessionTasks,
  type LegacyTaskSource,
  type UnlinkedAsk,
  UNTRIAGED_TITLE,
} from '../../../src/lib/board-import/index.ts';
import type { TaskEntry } from '../../../src/lib/board-import/legacy-snapshot.ts';
import { card, lanes, MACHINE, MemoryBoardStore, NOW, OTHER_PROJECT, PROJECT } from '../board/support.ts';
import { entryOf, oldTask, taskAt } from './support.ts';

class FakeTasks implements LegacyTaskSource {
  reads = 0;
  constructor(public files: readonly LegacySessionTasks[]) {}
  async read() {
    this.reads += 1;
    return this.files;
  }
}

class FakeProjects implements ImportProjects {
  readonly proposals: { projectId: BoardProjectId; sessionId: string }[] = [];
  readonly sets = new Map<BoardProjectId, LaneSet>();
  constructor(
    private readonly projectOfSession: Readonly<Record<string, BoardProjectId>> = {},
    private readonly proposable = true,
  ) {}
  async projectOf(sessionId: string) {
    return this.projectOfSession[sessionId] ?? PROJECT;
  }
  async laneSet(projectId: BoardProjectId) {
    return this.sets.get(projectId) ?? null;
  }
  async propose(projectId: BoardProjectId, sessionId: string) {
    this.proposals.push({ projectId, sessionId });
    if (!this.proposable) return null;
    const set = lanes(projectId, 'pr-release-verify');
    this.sets.set(projectId, set);
    return set;
  }
}

class FakeSessions implements ImportSessions {
  constructor(
    private readonly ids: readonly string[] = [],
    private readonly assignees: Readonly<Record<string, string>> = {},
  ) {}
  async list() {
    return this.ids;
  }
  async exists(value: string) {
    return this.ids.includes(value);
  }
  async resolveAssignee(assignee: string) {
    return this.assignees[assignee] ?? null;
  }
}

class FakeAgenda implements ImportAgenda {
  readonly links: { sessionId: string; links: readonly AskLink[] }[] = [];
  private readonly linked = new Set<string>();
  constructor(
    private readonly asks: Readonly<Record<string, readonly string[]>> = {},
    private readonly failing: 'unlinked' | 'link' | null = null,
  ) {}
  async unlinked(sessionId: string): Promise<readonly UnlinkedAsk[]> {
    if (this.failing === 'unlinked') throw new Error('agenda is locked');
    return (this.asks[sessionId] ?? []).filter(id => !this.linked.has(`${sessionId}/${id}`)).map(id => ({ id }));
  }
  async link(sessionId: string, links: readonly AskLink[]) {
    if (this.failing === 'link') throw new Error('agenda is read-only');
    this.links.push({ sessionId, links });
    for (const link of links) this.linked.add(`${sessionId}/${link.id}`);
    return links.length;
  }
}

class FakeMarker {
  recorded: { at: string; summary: BoardImportSummary }[] = [];
  constructor(
    public did = false,
    private readonly failing = false,
  ) {}
  async ran() {
    return this.did;
  }
  async record(at: string, summary: BoardImportSummary) {
    if (this.failing) throw new Error('disk is full');
    this.recorded.push({ at, summary });
  }
}

class BrokenStore extends MemoryBoardStore {
  constructor(
    private readonly breaks: { read?: true; allocate?: TaskKind; write?: string; fixedId?: string } = {},
    cards: readonly BoardTask[] = [],
  ) {
    super(cards);
  }
  override async read(): Promise<BoardSnapshot> {
    if (this.breaks.read) throw new Error('store is down');
    return super.read();
  }
  override async allocateId(kind: TaskKind) {
    if (this.breaks.allocate === kind) throw new Error('counter is stuck');
    return this.breaks.fixedId ?? super.allocateId(kind);
  }
  override async write<T>(...args: Parameters<MemoryBoardStore['write']>) {
    if (this.breaks.write !== undefined && args[0].startsWith(this.breaks.write)) throw new Error('write failed');
    return super.write(...(args as Parameters<MemoryBoardStore['write']>)) as Promise<T>;
  }
}

const file = (
  sessionId: string,
  entries: readonly TaskEntry[],
  extra: Partial<LegacySessionTasks> = {},
): LegacySessionTasks => ({
  sessionId,
  entries,
  issues: [],
  fatal: false,
  ...extra,
});

interface World {
  readonly importer: BoardImporter;
  readonly tasks: FakeTasks;
  readonly store: MemoryBoardStore;
  readonly projects: FakeProjects;
  readonly agenda: FakeAgenda;
  readonly marker: FakeMarker;
}

const world = (
  files: readonly LegacySessionTasks[],
  parts: {
    store?: MemoryBoardStore;
    projects?: FakeProjects;
    sessions?: FakeSessions;
    agenda?: FakeAgenda;
    marker?: FakeMarker;
    machineId?: () => string | undefined;
  } = {},
): World => {
  const tasks = new FakeTasks(files);
  const store = parts.store ?? new MemoryBoardStore();
  const projects = parts.projects ?? new FakeProjects();
  const agenda = parts.agenda ?? new FakeAgenda();
  const marker = parts.marker ?? new FakeMarker();
  const ports: BoardImporterPorts = {
    tasks,
    store,
    projects,
    sessions: parts.sessions ?? new FakeSessions(),
    agenda,
    marker,
    clock: { now: () => NOW },
    machineId: parts.machineId ?? (() => MACHINE),
  };
  return { importer: new BoardImporter(ports), tasks, store, projects, agenda, marker };
};

const cardsOf = (store: MemoryBoardStore): BoardTask[] => [...store.cards.values()];
const byRef = (store: MemoryBoardStore, ref: string): BoardTask | undefined =>
  cardsOf(store).find(card => card.legacyRef === ref);

describe('BoardImporter: the cards', () => {
  it('should import a task as a card, with its legacy reference, and record the marker', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('in_progress'))])]);

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary).match({
      imported: 1,
      alreadyImported: 0,
      sessions: 1,
      complete: true,
      skipped: false,
      dryRun: false,
      problems: [],
    });
    should(summary.proposedProjects).eql([PROJECT]);
    should(byRef(w.store, 'lead:F1')).match({ laneId: 'implement', owner: 'lead', machineId: MACHINE });
    should(w.marker.recorded).have.length(1);
    should(w.marker.recorded[0]?.at).equal(NOW);
  });

  it('should be a no-op the second time, with or without the marker', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('todo'))])]);
    await w.importer.run();
    const written = w.store.writes.length;

    // Act
    w.marker.did = true;
    const skipped = await w.importer.run();
    const forced = await w.importer.run({ force: true });

    // Assert
    should(skipped).match({ skipped: true, imported: 0, complete: false });
    should(w.tasks.reads).equal(2);
    should(forced).match({ imported: 0, alreadyImported: 1, complete: true });
    should(w.store.writes).have.length(written);
    should(w.projects.proposals).have.length(1);
  });

  it('should only count and change nothing on a dry run, naming the projects that would get lanes', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('todo'))]), file('child', [entryOf(taskAt('todo'))])], {
      projects: new FakeProjects({ child: OTHER_PROJECT }),
    });
    w.marker.did = true;

    // Act
    const summary = await w.importer.run({ dryRun: true });

    // Assert
    should(summary).match({ dryRun: true, imported: 2, complete: false, skipped: false });
    should([...summary.proposedProjects].sort()).eql([PROJECT, OTHER_PROJECT]);
    should(w.store.writes).have.length(0);
    should(w.projects.proposals).have.length(0);
    should(w.marker.recorded).have.length(0);
  });

  it('should not list a project that already has lanes on a dry run', async () => {
    // Arrange
    const projects = new FakeProjects();
    projects.sets.set(PROJECT, lanes());
    const w = world([file('lead', [entryOf(taskAt('todo'))])], { projects });

    // Act
    const summary = await w.importer.run({ dryRun: true });

    // Assert
    should(summary.proposedProjects).eql([]);
    should(summary.imported).equal(1);
  });

  it('should propose a project only once however many sessions are on it', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('todo'))]), file('child', [entryOf(taskAt('todo'))])]);

    // Act
    const summary = await w.importer.run();

    // Assert
    should(w.projects.proposals).eql([{ projectId: PROJECT, sessionId: 'child' }]);
    should(summary.proposedProjects).eql([PROJECT]);
    should(summary.imported).equal(2);
  });

  it('should report a project it could not give lanes and keep the marker back', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('todo'))])], { projects: new FakeProjects({}, false) });

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary.imported).equal(0);
    should(summary.complete).be.false();
    should(summary.problems[0]?.detail).startWith('no lanes could be proposed');
    should(w.marker.recorded).have.length(0);
  });

  it('should skip a bad file, report why, and still import the others', async () => {
    // Arrange
    const issue = { scope: 'snapshot' as const, taskId: null, detail: 'not JSON' };
    const w = world([
      file('broken', [], { fatal: true, issues: [issue] }),
      file('unreadable', [], { fatal: true }),
      file('partial', [entryOf(taskAt('todo'))], { issues: [{ scope: 'task', taskId: 'F9', detail: 'bad record' }] }),
    ]);

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary.imported).equal(1);
    should(summary.problems).eql(
      [
        { sessionId: 'broken', taskId: null, detail: 'not JSON' },
        { sessionId: 'partial', taskId: 'F9', detail: 'bad record' },
        { sessionId: 'unreadable', taskId: null, detail: 'tasks.json could not be read' },
      ].sort(
        (a, b) =>
          ['broken', 'partial', 'unreadable'].indexOf(a.sessionId) -
          ['broken', 'partial', 'unreadable'].indexOf(b.sessionId),
      ),
    );
    should(summary.complete).be.true();
  });

  it('should report a task that cannot become a card, import the rest, and still record the marker', async () => {
    // Arrange
    const bad = entryOf(oldTask({ id: 'F1', title: 'one two three four five six' }));
    const dependent = entryOf(oldTask({ id: 'F2', status: 'blocked', statusReason: 'waiting on F1' }));
    const w = world([file('lead', [bad, dependent])]);

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary.imported).equal(1);
    should(summary.problems).have.length(1);
    should(summary.problems[0]).match({ sessionId: 'lead', taskId: 'F1' });
    should(summary.complete).be.true();
    should(byRef(w.store, 'lead:F1')).be.undefined();
    should(byRef(w.store, 'lead:F2')?.dependsOn).eql([]);
  });

  it('should map assignees and actors through the sessions it knows', async () => {
    // Arrange
    const task = taskAt('todo', {
      assignee: 'Wilfredo',
      createdBy: null,
      clarifications: [{ text: 'use bun', source: 'human', at: NOW, by: 'child', byName: null }],
    });
    const other = taskAt('todo', { id: 'F2', assignee: 'Unknown One', createdBy: 'daemon' });
    const w = world([file('lead', [entryOf(task), entryOf(other)])], {
      sessions: new FakeSessions(['lead', 'child'], { Wilfredo: 'child' }),
    });

    // Act
    await w.importer.run();

    // Assert
    // A task that recorded no creator is the owner's (its gates stay the owner's); one the daemon made stays the daemon's.
    should(byRef(w.store, 'lead:F1')).match({
      assignee: 'child',
      createdBy: { kind: 'owner' },
      clarifications: [{ by: { kind: 'ferret', sessionId: 'child' } }],
    });
    should(byRef(w.store, 'lead:F2')).match({ assignee: 'lead', createdBy: { kind: 'daemon' } });
  });

  it('should keep an old task already imported and fill in only the new ones', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('todo'))])]);
    await w.importer.run();
    w.tasks.files = [file('lead', [entryOf(taskAt('todo')), entryOf(taskAt('todo', { id: 'F2' }))])];

    // Act
    const summary = await w.importer.run({ force: true });

    // Assert
    should(summary).match({ imported: 1, alreadyImported: 1 });
    should(cardsOf(w.store)).have.length(2);
  });

  it('should count a card it finds already written as already imported', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('todo'))])], {
      store: new BrokenStore({ fixedId: 'F1' }, [card({ id: 'F1' })]),
    });

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary).match({ imported: 0, alreadyImported: 1, complete: true });
  });

  it('should withhold the marker when a card cannot be written, and say so', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('todo')), entryOf(taskAt('todo', { id: 'F2' }))])], {
      store: new BrokenStore({ write: 'F1' }),
    });

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary.complete).be.false();
    should(summary.problems[0]).match({ sessionId: 'lead', detail: 'not imported: write failed' });
    should(w.marker.recorded).have.length(0);
  });

  it('should skip a session whose work fails, report it, and carry on', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('todo'))]), file('child', [entryOf(taskAt('todo'))])], {
      store: new BrokenStore({ allocate: 'feature' }),
    });

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary.complete).be.false();
    should(summary.problems.map(problem => problem.detail)).eql([
      'session skipped: counter is stuck',
      'session skipped: counter is stuck',
    ]);
  });

  it('should say the import stopped when the store cannot be read', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('todo'))])], { store: new BrokenStore({ read: true }) });

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary.complete).be.false();
    should(summary.problems).eql([{ sessionId: null, taskId: null, detail: 'the import stopped: store is down' }]);
  });

  it('should treat a missing daemon identity as a failure to retry, not as a lost task', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('todo'))])], { machineId: () => undefined });

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary.complete).be.false();
    should(summary.problems[0]?.detail).equal('session skipped: the daemon identity is not open yet');
    should(w.marker.recorded).have.length(0);
  });

  it('should report a marker it could not write', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('todo'))])], { marker: new FakeMarker(false, true) });

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary).match({ imported: 1, complete: false });
    should(summary.problems[0]?.detail).equal("the import's marker was not written: disk is full");
  });

  it('should stringify a failure that is not an Error', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('todo'))])]);
    w.tasks.read = async () => {
      throw 'plain string';
    };

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary.problems[0]?.detail).equal('the import stopped: plain string');
  });
});

describe('BoardImporter: the agenda', () => {
  const linksOf = (w: World) => w.agenda.links.flatMap(entry => entry.links);

  it('should point the asks at the one task in progress', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('in_progress')), entryOf(taskAt('todo', { id: 'F2' }))])], {
      agenda: new FakeAgenda({ lead: ['A1', 'A2'] }),
    });

    // Act
    const summary = await w.importer.run();

    // Assert
    const target = byRef(w.store, 'lead:F1')!;
    should(linksOf(w)).eql([
      { id: 'A1', task: { id: target.id }, blocking: false },
      { id: 'A2', task: { id: target.id }, blocking: false },
    ]);
    should(summary).match({ linkedAsks: 2, untriagedCards: 0 });
  });

  it('should carry the one task blocked on the owner by a blocking link, not a flag', async () => {
    // Arrange
    const blocked = entryOf(oldTask({ id: 'F1', status: 'blocked', statusReason: 'needs your approval' }));
    const working = entryOf(taskAt('in_progress', { id: 'F2' }));
    const w = world([file('lead', [blocked, working])], { agenda: new FakeAgenda({ lead: ['A1'] }) });

    // Act
    await w.importer.run();

    // Assert
    const card = byRef(w.store, 'lead:F1')!;
    should(linksOf(w)).eql([{ id: 'A1', task: { id: card.id }, blocking: true }]);
    should(card.blocked).be.null();
  });

  it('should flag an owner block as external when the session has no open asks', async () => {
    // Arrange
    const blocked = entryOf(oldTask({ id: 'F1', status: 'blocked', statusReason: 'needs your approval' }));
    const w = world([file('lead', [blocked])]);

    // Act
    await w.importer.run();

    // Assert
    should(byRef(w.store, 'lead:F1')?.blocked).match({ on: 'external', reason: 'needs your approval' });
  });

  it('should file the asks on an "Untriaged asks" card when more than one task is a candidate', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('in_progress')), entryOf(taskAt('in_progress', { id: 'F2' }))])], {
      agenda: new FakeAgenda({ lead: ['A1'] }),
    });

    // Act
    const summary = await w.importer.run();

    // Assert
    const untriaged = cardsOf(w.store).find(card => card.title === UNTRIAGED_TITLE)!;
    should(untriaged).match({ owner: 'lead', kind: 'chore', createdBy: { kind: 'daemon' } });
    should(linksOf(w)).eql([{ id: 'A1', task: { id: untriaged.id }, blocking: false }]);
    should(summary).match({ untriagedCards: 1, linkedAsks: 1 });
  });

  it('should file asks of a session with no task file at all, and reuse the card the next time', async () => {
    // Arrange
    const agenda = new FakeAgenda({ lead: ['A1'] });
    const w = world([], { sessions: new FakeSessions(['lead']), agenda });
    await w.importer.run();
    const agendaLater = new FakeAgenda({ lead: ['A2'] });
    const again = world([], {
      store: w.store,
      sessions: new FakeSessions(['lead']),
      agenda: agendaLater,
      projects: w.projects,
    });

    // Act
    const summary = await again.importer.run();

    // Assert
    should(cardsOf(w.store).filter(card => card.title === UNTRIAGED_TITLE)).have.length(1);
    should(summary).match({ untriagedCards: 0, linkedAsks: 1 });
  });

  it('should send the asks to the untriaged card when the task they pointed at could not be imported', async () => {
    // Arrange
    const bad = entryOf(
      oldTask({ id: 'F1', status: 'in_progress', phase: 'build', title: 'one two three four five six' }),
    );
    const w = world([file('lead', [bad])], { agenda: new FakeAgenda({ lead: ['A1'] }) });

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary.untriagedCards).equal(1);
    should(summary.linkedAsks).equal(1);
  });

  it('should count what a dry run would link, and the card it would make', async () => {
    // Arrange
    const make = (existing: boolean) => {
      const w = world([file('lead', [entryOf(taskAt('todo'))])], { agenda: new FakeAgenda({ lead: ['A1', 'A2'] }) });
      return { w, existing };
    };
    const { w } = make(false);

    // Act
    const summary = await w.importer.run({ dryRun: true });

    // Assert
    should(summary).match({ linkedAsks: 2, untriagedCards: 1, imported: 1 });
    should(w.agenda.links).have.length(0);
  });

  it('should not count a card for a dry run when the one task in progress takes the asks, or one exists', async () => {
    // Arrange
    const working = world([file('lead', [entryOf(taskAt('in_progress'))])], {
      agenda: new FakeAgenda({ lead: ['A1'] }),
    });
    const first = world([], { sessions: new FakeSessions(['lead']), agenda: new FakeAgenda({ lead: ['A1'] }) });
    await first.importer.run();
    const known = world([], {
      store: first.store,
      sessions: new FakeSessions(['lead']),
      agenda: new FakeAgenda({ lead: ['A9'] }),
      projects: first.projects,
    });

    // Act
    const a = await working.importer.run({ dryRun: true });
    const b = await known.importer.run({ dryRun: true });

    // Assert
    should(a.untriagedCards).equal(0);
    should(b.untriagedCards).equal(0);
    should(b.linkedAsks).equal(1);
  });

  it('should skip a session with neither tasks nor asks', async () => {
    // Arrange
    const w = world([], { sessions: new FakeSessions(['idle']) });

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary).match({ imported: 0, complete: true, proposedProjects: [] });
    should(w.projects.proposals).have.length(0);
  });

  it('should withhold the marker when the asks cannot be linked', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('in_progress'))])], {
      agenda: new FakeAgenda({ lead: ['A1'] }, 'link'),
    });

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary.complete).be.false();
    should(summary.problems[0]?.detail).equal('agenda items not linked: agenda is read-only');
  });

  it('should skip a session whose agenda cannot be read', async () => {
    // Arrange
    const w = world([file('lead', [entryOf(taskAt('todo'))])], { agenda: new FakeAgenda({}, 'unlinked') });

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary.complete).be.false();
    should(summary.problems[0]?.detail).equal('session skipped: agenda is locked');
  });

  it('should report an untriaged card it could not write', async () => {
    // Arrange
    const w = world([], {
      sessions: new FakeSessions(['lead']),
      agenda: new FakeAgenda({ lead: ['A1'] }),
      store: new BrokenStore({ allocate: 'chore' }),
    });

    // Act
    const summary = await w.importer.run();

    // Assert
    should(summary.complete).be.false();
    should(summary.problems[0]?.detail).equal('the untriaged-asks card was not created: counter is stuck');
    should(w.agenda.links).have.length(0);
  });

  it('should link the asks of an old task that was imported by an earlier run', async () => {
    // Arrange
    const first = world([file('lead', [entryOf(taskAt('in_progress'))])]);
    await first.importer.run();
    const later = world([file('lead', [entryOf(taskAt('in_progress'))])], {
      store: first.store,
      projects: first.projects,
      agenda: new FakeAgenda({ lead: ['A1'] }),
    });

    // Act
    const summary = await later.importer.run();

    // Assert
    should(summary).match({ imported: 0, alreadyImported: 1, linkedAsks: 1 });
    should(later.agenda.links[0]?.links[0]).match({ task: { id: byRef(first.store, 'lead:F1')!.id } });
  });
});
