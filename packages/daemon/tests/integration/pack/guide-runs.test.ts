import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FileGuideRunStore, FileReplacedGuide } from '../../../src/adapters/pack/guide-runs.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import type { GuideRun } from '../../../src/lib/pack/builder/service.ts';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-guide-runs-'));
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths, () => 'unique-id');
  const root = join(home, 'pack-guide');
  const store = new FileGuideRunStore(files, root, async path => await rm(path, { recursive: true, force: true }));
  return { home, root, files, store };
}

const run = (id: string, startedAt: string): GuideRun => ({
  job: { id, session: `s-${id}`, name: 'Models Guide Builder', runtime: 'claude-main', startedAt, status: 'running' },
});

describe('FileGuideRunStore', () => {
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
      should(() => subject.store.pathOf('../escape', 'run.json')).throw(/not a guide builder run id/u);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });
});

describe('FileReplacedGuide', () => {
  it('should keep the replaced file, read it back, read a damaged one as nothing, and forget it', async () => {
    // Arrange
    const subject = await fixture();
    const path = join(subject.home, 'pack-guide-replaced.json');
    const replaced = new FileReplacedGuide(subject.files, path);
    try {
      // Act
      const empty = await replaced.read();
      await replaced.write({ text: null, savedAt: '2026-10-22T12:00:00.000Z', source: 'derived' });
      const kept = await replaced.read();
      await writeFile(path, '{"text": 3}');
      const wrong = await replaced.read();
      await writeFile(path, 'not json');
      const damaged = await replaced.read();
      await replaced.write(undefined);
      await replaced.write(undefined);

      // Assert
      should(empty).be.undefined();
      should(kept).deepEqual({ text: null, savedAt: '2026-10-22T12:00:00.000Z', source: 'derived' });
      should(wrong).be.undefined();
      should(damaged).be.undefined();
      should(await replaced.read()).be.undefined();
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });
});
