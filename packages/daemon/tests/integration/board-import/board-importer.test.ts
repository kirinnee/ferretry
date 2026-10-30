import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoardProjectId, LaneSet } from '@ferretry/protocol';
import should from 'should';
import {
  FileBoardImportMarker,
  FileLegacyTaskSource,
  StorageImportSessions,
} from '../../../src/adapters/board-import/index.ts';
import { FileBoardStore } from '../../../src/adapters/board/file-board-store.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/index.ts';
import {
  type AskLink,
  BoardImporter,
  type ImportAgenda,
  type ImportProjects,
  type UnlinkedAsk,
} from '../../../src/lib/board-import/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { lanes, MACHINE, NOW, OTHER_PROJECT, PROJECT } from '../../unit/board/support.ts';
import { serializeLegacySnapshot, snapshotOf, task } from '../../unit/board-import/legacy-fixtures.ts';

/**
 * The importer over a fixture state home: several sessions' real `tasks.json` files, the real file adapters and
 * the real file board store. Only the project lanes and the agenda are in memory.
 */

const homes = new Set<string>();

class Projects implements ImportProjects {
  readonly proposed: string[] = [];
  private readonly sets = new Map<BoardProjectId, LaneSet | null>([
    [PROJECT, lanes(PROJECT, 'pr-release-verify')],
    [OTHER_PROJECT, null],
  ]);

  async projectOf(sessionId: string): Promise<BoardProjectId> {
    return sessionId === 'unlaned' ? OTHER_PROJECT : PROJECT;
  }

  async laneSet(projectId: BoardProjectId): Promise<LaneSet | null> {
    return this.sets.get(projectId) ?? null;
  }

  async propose(projectId: BoardProjectId): Promise<LaneSet | null> {
    this.proposed.push(projectId);
    const proposal = lanes(projectId, 'pr');
    this.sets.set(projectId, proposal);
    return proposal;
  }
}

class Agenda implements ImportAgenda {
  readonly links = new Map<string, AskLink[]>();
  constructor(private readonly open: Record<string, readonly string[]>) {}

  async unlinked(sessionId: string): Promise<readonly UnlinkedAsk[]> {
    const done = new Set((this.links.get(sessionId) ?? []).map(link => link.id));
    return (this.open[sessionId] ?? []).filter(id => !done.has(id)).map(id => ({ id }));
  }

  async link(sessionId: string, links: readonly AskLink[]): Promise<number> {
    this.links.set(sessionId, [...(this.links.get(sessionId) ?? []), ...links]);
    return links.length;
  }
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-board-import-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const sessionIds = ['busy', 'plain', 'unlaned', 'broken', 'silent'];
  const fileOf = (id: string) => join(home, 'sessions', id, 'tasks.json');
  const plant = async (id: string, text: string) => {
    await mkdir(join(home, 'sessions', id), { recursive: true });
    await writeFile(fileOf(id), text);
  };
  await plant(
    'busy',
    serializeLegacySnapshot(
      snapshotOf(
        task({ id: 'F1' as never, title: 'Now', status: 'in_progress', phase: 'build', assignee: 'plain' }),
        task({ id: 'F2' as never, title: 'Later', status: 'todo', phase: 'todo' }),
        task({
          id: 'F3' as never,
          title: 'Stuck',
          status: 'blocked',
          phase: 'build',
          statusReason: 'waiting for the vendor to answer',
        }),
      ),
    ),
  );
  await plant('plain', serializeLegacySnapshot(snapshotOf(task({ id: 'F1' as never, title: 'Solo' }))));
  await plant('unlaned', serializeLegacySnapshot(snapshotOf(task({ id: 'F1' as never, title: 'No lanes yet' }))));
  await plant('broken', '{not json');
  await mkdir(join(home, 'sessions', 'silent'), { recursive: true });

  const store = new FileBoardStore(join(paths.state, 'board'), new StateFileSystem(paths), new KeyedSerialExecutor(), {
    warn: () => undefined,
  });
  const projects = new Projects();
  const agenda = new Agenda({ busy: ['A1', 'A2'], plain: ['A1'] });
  const markerFile = join(home, 'board-import.json');
  const importer = new BoardImporter({
    tasks: new FileLegacyTaskSource(() => sessionIds, fileOf),
    store,
    projects,
    sessions: new StorageImportSessions(
      () => sessionIds,
      async () => [{ id: 'plain', name: 'Plain', teammate: null }],
    ),
    agenda,
    marker: new FileBoardImportMarker(markerFile),
    clock: { now: () => NOW },
    machineId: () => MACHINE,
  });
  return { home, fileOf, store, projects, agenda, markerFile, importer };
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('the board import over a state home', () => {
  it('should turn every readable task into a card keyed by legacyRef and report the broken file', async () => {
    const { store, importer, projects } = await fixture();

    const summary = await importer.run();

    should(summary.imported).equal(5);
    should(summary.alreadyImported).equal(0);
    should(summary.complete).equal(true);
    should(summary.problems.some(problem => problem.sessionId === 'broken')).equal(true);
    should(projects.proposed).eql([OTHER_PROJECT]);
    const cards = (await store.read()).cards;
    const refs = cards.flatMap(each => (each.legacyRef === undefined ? [] : [each.legacyRef])).sort();
    should(refs).eql(['busy:F1', 'busy:F2', 'busy:F3', 'plain:F1', 'unlaned:F1']);
    const stuck = cards.find(each => each.legacyRef === 'busy:F3');
    should(stuck?.owner).equal('busy');
    should(stuck?.history.at(-1)?.type).equal('migrated');
    should(cards.find(each => each.legacyRef === 'busy:F1')?.assignee).equal('plain');
  });

  it('should attach open agenda items to the single in-progress card', async () => {
    const { importer, agenda } = await fixture();
    await importer.run();
    should((agenda.links.get('busy') ?? []).map(link => link.id).sort()).eql(['A1', 'A2']);
    should((agenda.links.get('plain') ?? []).map(link => link.id)).eql(['A1']);
  });

  it('should be a no-op the second time: the marker says it ran, and a forced run adds nothing', async () => {
    const { store, importer, markerFile } = await fixture();
    await importer.run();
    const before = (await store.read()).cards.length;
    should(JSON.parse(await readFile(markerFile, 'utf8')).v).equal(1);

    should((await importer.run()).skipped).equal(true);
    const forced = await importer.run({ force: true });

    should(forced.imported).equal(0);
    should(forced.alreadyImported).equal(5);
    should((await store.read()).cards.length).equal(before);
  });

  it('should change nothing in a dry run, and leave the old files untouched', async () => {
    const { store, importer, markerFile, fileOf } = await fixture();
    const old = await readFile(fileOf('busy'), 'utf8');

    const summary = await importer.run({ dryRun: true });

    should(summary.dryRun).equal(true);
    should(summary.imported).equal(5);
    should(summary.complete).equal(false);
    should((await store.read()).cards).length(0);
    await readFile(markerFile, 'utf8').then(
      () => should.fail(undefined, undefined, 'no marker expected'),
      error => should((error as NodeJS.ErrnoException).code).equal('ENOENT'),
    );
    await importer.run();
    should(await readFile(fileOf('busy'), 'utf8')).equal(old);
  });
});
