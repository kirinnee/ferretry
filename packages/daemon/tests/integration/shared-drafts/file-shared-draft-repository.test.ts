import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharedDraftSnapshot } from '@ferretry/protocol';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FileSharedDraftRepository, sharedDraftFile } from '../../../src/adapters/shared-drafts/index.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import { createFoundationPaths, type FoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';

const draft = (text: string, rev: number): SharedDraftSnapshot => ({
  v: 1,
  sessionId: 'agent-1',
  generation: 'gen-1',
  epoch: 0,
  rev,
  text,
  items: [{ kind: 'attachment', id: 'a1', name: 'shot.png', mime: 'image/png', bytes: 4 }],
  updatedAt: '2026-11-01T00:00:00.000Z',
});

async function fixture(): Promise<{
  readonly home: string;
  readonly paths: FoundationPaths;
  readonly repository: FileSharedDraftRepository;
  readonly file: string;
}> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-shared-draft-'));
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  await mkdir(join(paths.sessions, 'agent-1'), { recursive: true });
  await mkdir(join(paths.state, 'shared-drafts'), { recursive: true });
  let id = 0;
  const files = new StateFileSystem(paths, () => `unique-${++id}`);
  return {
    home,
    paths,
    repository: new FileSharedDraftRepository(paths, files, new KeyedSerialExecutor()),
    file: sharedDraftFile(paths, 'agent-1'),
  };
}

describe('FileSharedDraftRepository', () => {
  it('should find nothing for a session that never had a draft', async () => {
    const subject = await fixture();
    try {
      should(await subject.repository.load('agent-1')).be.undefined();
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should write the draft owner-only and read it back exactly, the later of two writes winning', async () => {
    // Arrange
    const subject = await fixture();
    try {
      // Act — two writes started together land in the order they were made.
      await Promise.all([subject.repository.save(draft('first', 1)), subject.repository.save(draft('second', 2))]);

      // Assert
      should(await subject.repository.load('agent-1')).deepEqual(draft('second', 2));
      should((await stat(subject.file)).mode & 0o777).equal(0o600);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it("should keep unsent words out of the session's own folder, where agents and miners read", async () => {
    // Arrange
    const subject = await fixture();
    try {
      // Act
      await subject.repository.save(draft('unsent', 1));

      // Assert
      should(subject.file.startsWith(join(subject.paths.state, 'shared-drafts'))).be.true();
      should(await readdir(join(subject.paths.sessions, 'agent-1'))).be.empty();
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should treat a damaged file, or one naming another session, as no draft at all', async () => {
    // Arrange
    const subject = await fixture();
    try {
      // Act / Assert
      await writeFile(subject.file, '{not json');
      should(await subject.repository.load('agent-1')).be.undefined();
      await writeFile(subject.file, JSON.stringify({ ...draft('x', 1), sessionId: 'someone-else' }));
      should(await subject.repository.load('agent-1')).be.undefined();
      await writeFile(subject.file, JSON.stringify({ ...draft('x', 1), v: 9 }));
      should(await subject.repository.load('agent-1')).be.undefined();
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it("should keep an item's draft in its own owner-only file, apart from the chat's, and list it", async () => {
    // Arrange
    const subject = await fixture();
    const item = { ...draft('for the card', 1), slot: 'A5' };
    try {
      // Act
      await subject.repository.save(draft('for the chat', 1));
      await subject.repository.save(item);

      // Assert — two files, two drafts: neither reads as the other.
      const itemFile = sharedDraftFile(subject.paths, 'agent-1', 'A5');
      should(itemFile).equal(join(subject.paths.state, 'shared-drafts', 'agent-1.items', 'A5.json'));
      should((await stat(itemFile)).mode & 0o777).equal(0o600);
      should(await subject.repository.load('agent-1')).deepEqual(draft('for the chat', 1));
      should(await subject.repository.load('agent-1', 'A5')).deepEqual(item);
      should(await subject.repository.load('agent-1', 'A6')).be.undefined();
      should(await subject.repository.items('agent-1')).deepEqual(['A5']);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should treat an item file that names another slot, or none, as no draft for that item', async () => {
    // Arrange
    const subject = await fixture();
    const itemFile = sharedDraftFile(subject.paths, 'agent-1', 'A5');
    try {
      await mkdir(join(subject.paths.state, 'shared-drafts', 'agent-1.items'), { recursive: true });

      // Act / Assert
      await writeFile(itemFile, JSON.stringify({ ...draft('x', 1), slot: 'A6' }));
      should(await subject.repository.load('agent-1', 'A5')).be.undefined();
      await writeFile(itemFile, JSON.stringify(draft('x', 1)));
      should(await subject.repository.load('agent-1', 'A5')).be.undefined();
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it("should delete an item's draft outright and leave the chat's, and a missing one is no error", async () => {
    // Arrange
    const subject = await fixture();
    try {
      await subject.repository.save(draft('for the chat', 1));
      await subject.repository.save({ ...draft('for the card', 1), slot: 'A5' });

      // Act
      await subject.repository.remove('agent-1', 'A5');
      await subject.repository.remove('agent-1', 'A9');

      // Assert
      should(await subject.repository.load('agent-1', 'A5')).be.undefined();
      should(await subject.repository.items('agent-1')).be.empty();
      should(await subject.repository.load('agent-1')).deepEqual(draft('for the chat', 1));
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should list only item drafts: no folder is none, and stray names or folders are skipped', async () => {
    // Arrange
    const subject = await fixture();
    const folder = join(subject.paths.state, 'shared-drafts', 'agent-1.items');
    try {
      // Act / Assert — no item has ever had a draft.
      should(await subject.repository.items('agent-1')).be.empty();
      await subject.repository.save({ ...draft('kept', 1), slot: 'A2' });
      await writeFile(join(folder, 'notes.txt'), 'not a draft');
      await writeFile(join(folder, 'not-an-id.json'), '{}');
      await mkdir(join(folder, 'A3.json'));
      should(await subject.repository.items('agent-1')).deepEqual(['A2']);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });
});
