import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import {
  FileCleanUpRunStore,
  FileReplacedGuide,
  FileRoutingMigrationBackup,
} from '../../../src/adapters/pack/cleanup-runs.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import type { CleanUpRun } from '../../../src/lib/pack/cleanup/service.ts';
import type { RoutingMigrationBackup } from '../../../src/lib/pack/migrate.ts';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-cleanup-runs-'));
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths, () => 'unique-id');
  const root = join(home, 'pack-cleanup');
  const store = new FileCleanUpRunStore(files, root, async path => await rm(path, { recursive: true, force: true }));
  return { home, root, files, store };
}

const run = (id: string, startedAt: string): CleanUpRun => ({
  job: {
    id,
    session: `s-${id}`,
    name: 'Routing Prompt Clean-up',
    runtime: 'claude-main',
    startedAt,
    status: 'running',
  },
});

describe('FileCleanUpRunStore', () => {
  it('should keep each run in its own folder, list them newest first, and remove one with its files', async () => {
    // Arrange
    const subject = await fixture();
    try {
      // Act
      const inventory = await subject.store.writeFile('run-a', 'inventory.json', '{}\n');
      await subject.store.save(run('run-a', '2026-10-22T10:00:00.000Z'));
      await subject.store.save(run('run-b', '2026-10-22T11:00:00.000Z'));
      const listed = await subject.store.list();
      await subject.store.remove('run-a');

      // Assert
      should(inventory).equal(join(subject.root, 'run-a', 'inventory.json'));
      should(subject.store.pathOf('run-b', 'draft.json')).equal(join(subject.root, 'run-b', 'draft.json'));
      should(listed.map(entry => entry.job.id)).deepEqual(['run-b', 'run-a']);
      should(await subject.store.load('run-a')).be.undefined();
      should(await subject.store.readFile('run-a', 'inventory.json')).be.undefined();
      should(await readdir(subject.root)).deepEqual(['run-b']);
      should(await subject.store.load('run-b')).deepEqual(run('run-b', '2026-10-22T11:00:00.000Z'));
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should list nothing before any run, skip a run document that does not read, and refuse an id that is a path', async () => {
    // Arrange
    const subject = await fixture();
    try {
      // Act
      const before = await subject.store.list();
      await mkdir(join(subject.root, 'run-bad'), { recursive: true });
      await writeFile(join(subject.root, 'run-bad', 'run.json'), 'not json');
      await mkdir(join(subject.root, 'run-odd'), { recursive: true });
      await writeFile(join(subject.root, 'run-odd', 'run.json'), '{"job": {}}');

      // Assert
      should(before).deepEqual([]);
      should(await subject.store.list()).deepEqual([]);
      should(await subject.store.readFile('../escape', 'run.json')).be.undefined();
      should(() => subject.store.pathOf('../escape', 'run.json')).throw(/not a clean-up run id/u);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });
});

describe('FileReplacedGuide', () => {
  it('should keep the replaced file, read it back, read a damaged one as nothing, and forget it', async () => {
    // Arrange
    const subject = await fixture();
    const path = join(subject.home, 'pack-routing-replaced.json');
    const replaced = new FileReplacedGuide(subject.files, path);
    try {
      // Act
      const empty = await replaced.read();
      await replaced.write({ text: null, savedAt: '2026-10-22T12:00:00.000Z', source: 'default' });
      const kept = await replaced.read();
      await writeFile(path, '{"text": 3}');
      const wrong = await replaced.read();
      await writeFile(path, 'not json');
      const damaged = await replaced.read();
      await replaced.write(undefined);
      await replaced.write(undefined);

      // Assert
      should(empty).be.undefined();
      should(kept).deepEqual({ text: null, savedAt: '2026-10-22T12:00:00.000Z', source: 'default' });
      should(wrong).be.undefined();
      should(damaged).be.undefined();
      should(await replaced.read()).be.undefined();
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });
});

describe('FileRoutingMigrationBackup', () => {
  const backup = (at: string, modelsGuide: string | null): RoutingMigrationBackup => ({
    at,
    modelsGuide,
    pack: null,
    cut: false,
  });

  it('should keep a run in a document named by when it ran, and answer where it is', async () => {
    // Arrange
    const subject = await fixture();
    const target = new FileRoutingMigrationBackup(subject.files, subject.home);
    const value: RoutingMigrationBackup = {
      at: '2026-10-22T12:00:00.123Z',
      modelsGuide: 'useCases: []\n',
      pack: 'routingPreferences: opus\n',
      prompt: 'Opus for everything.',
      cut: true,
    };
    try {
      // Act
      const path = await target.write(value);

      // Assert
      should(path).equal(join(subject.home, 'pack-routing-migration-2026-10-22T12-00-00-123Z.json'));
      should(JSON.parse(await readFile(path, 'utf8'))).deepEqual(value);
      should(await readFile(path, 'utf8')).endWith('\n');
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should never let one run overwrite another: two runs at different times keep two documents', async () => {
    // Arrange
    const subject = await fixture();
    const target = new FileRoutingMigrationBackup(subject.files, subject.home);
    try {
      // Act
      const first = await target.write(backup('2026-10-22T12:00:00.000Z', 'first: 1\n'));
      const second = await target.write(backup('2026-10-22T12:00:00.001Z', 'second: 2\n'));
      const later = await target.write(backup('2026-10-23T09:30:00.000Z', null));

      // Assert
      should(new Set([first, second, later]).size).equal(3);
      should(JSON.parse(await readFile(first, 'utf8')).modelsGuide).equal('first: 1\n');
      should(JSON.parse(await readFile(second, 'utf8')).modelsGuide).equal('second: 2\n');
      should(JSON.parse(await readFile(later, 'utf8')).modelsGuide).be.null();
      should((await readdir(subject.home)).filter(name => name.startsWith('pack-routing-migration-'))).have.length(3);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });
});
